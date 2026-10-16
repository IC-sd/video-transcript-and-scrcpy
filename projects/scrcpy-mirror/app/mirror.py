"""Wireless scrcpy launcher. Standard library only; importing has no side effects."""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import getpass
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from scrcpy_link import ControlRelay


class MirrorError(Exception):
    pass


class InstanceLock:
    """An OS-owned lock is released even after a crash; no stale PID guessing."""
    def __init__(self, path):
        self.path, self.stream, self.acquired = Path(path), None, False

    def __enter__(self):
        self.stream = self.path.open('a+b')
        if self.path.stat().st_size == 0:
            self.stream.write(b'0')
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.acquired = True
        except OSError:
            self.stream.close()
        return self

    def __exit__(self, *_):
        if self.acquired:
            self.stream.close()
            self.acquired = False


class StreamSettings:
    def __init__(self, max_size=None, bit_rate=None, max_fps=None,
                 hwdec="auto", encoder=None, stats=False):
        self.max_size = 1600 if max_size is None else max_size
        self.bit_rate = str("6M" if bit_rate is None else bit_rate).upper()
        self.max_fps = 60 if max_fps is None else max_fps
        if not isinstance(self.max_size, int) or not 128 <= self.max_size <= 4096:
            raise ValueError("最大边长需要在 128–4096 之间")
        if not isinstance(self.max_fps, int) or not 1 <= self.max_fps <= 120:
            raise ValueError("帧率需要在 1–120 之间")
        match = re.fullmatch(r"([1-9][0-9]*)([KM]?)", self.bit_rate)
        rate = int(match[1]) * {"": 1, "K": 1000, "M": 1000000}[match[2]] if match else 0
        if not 100000 <= rate <= 50000000:
            raise ValueError("码率需要在 100K–50M 之间，例如 4M")
        if hwdec not in ("auto", "disabled", "d3d11va"):
            raise ValueError("不支持的硬件解码方式")
        if encoder and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,159}", encoder):
            raise ValueError("编码器名称格式无效")
        self.hwdec, self.encoder, self.stats = hwdec, encoder, bool(stats)

    def video_args(self):
        args = ["-m", str(self.max_size), "-b", self.bit_rate, "--max-fps", str(self.max_fps),
                "--video-codec=h264", "--video-buffer=0", "--hwdec=" + self.hwdec]
        if self.encoder:
            args += ["--video-encoder", self.encoder]
        if self.stats:
            args.append("--print-fps")
        return args

    def description(self):
        return f"最长边 {self.max_size}，码率 {self.bit_rate}，最高 {self.max_fps} fps"


def diagnose(adb, address, directory, settings, samples=8):
    """Measure command round trips, not capture-to-display or input latency."""
    durations = []
    failures = 0
    for _ in range(samples):
        start = time.perf_counter()
        result = adb.run("-s", address, "shell", "true", timeout=2)
        elapsed = (time.perf_counter() - start) * 1000
        if result.returncode == 0:
            durations.append(round(elapsed, 2))
        else:
            failures += 1
    ordered = sorted(durations)
    report = {
        "measurement": "adb_shell_round_trip_ms_not_end_to_end_video_latency",
        "max_size": settings.max_size,
        "bit_rate": settings.bit_rate, "max_fps": settings.max_fps,
        "samples": samples, "successes": len(ordered), "failures": failures,
        "median_ms": round(statistics.median(ordered), 2) if ordered else None,
        "p95_ms": ordered[max(0, (len(ordered) * 95 + 99) // 100 - 1)] if ordered else None,
        "samples_ms": durations,
    }
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "latency-diagnostics.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if ordered:
        print(f"ADB 命令往返：中位数 {report['median_ms']} ms，P95 {report['p95_ms']} ms，失败 {failures}/{samples}")
    else:
        print("所有诊断请求均失败，请检查无线连接。")
    print("该数值包含命令启动开销，不是画面端到端延迟。诊断结果：", destination)
    return report


def endpoint(value):
    """Accept numeric IP:port only; never interpret input as shell code."""
    value = value.strip()
    host, sep, port = value.rpartition(":")
    if not sep or not port.isascii() or not port.isdecimal():
        raise ValueError("请输入 IP:端口，例如 192.168.4.79:41875")
    host = str(ipaddress.ip_address(host.strip("[]")))
    if not 1 <= int(port) <= 65535:
        raise ValueError("端口必须在 1–65535 之间")
    return f"[{host}]:{int(port)}" if ":" in host else f"{host}:{int(port)}"


def host_of(value):
    try:
        return endpoint(value).rpartition(":")[0].strip("[]")
    except ValueError:
        return None


def parse_services(output, kind="connect"):
    result = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[1].rstrip(".") != f"_adb-tls-{kind}._tcp":
            continue
        try:
            address = endpoint(parts[2])
        except ValueError:
            continue
        if (parts[0], address) not in result:
            result.append((parts[0], address))
    return result


def parse_devices(output):
    return [p[0] for line in output.splitlines()
            if len(p := line.split()) >= 2 and p[1] == "device"]


class Cache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / "device.json"
        self.legacy = self.directory / "last.txt"

    def load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            address = endpoint(data.get("address", ""))
            return {"address": address, "identity": str(data.get("identity", ""))}
        except (OSError, ValueError, TypeError, AttributeError):
            try:
                return {"address": endpoint(self.legacy.read_text().strip()), "identity": ""}
            except (OSError, ValueError):
                return {}

    def save(self, address, identity):
        address = endpoint(address)
        self.directory.mkdir(parents=True, exist_ok=True)
        for path, body in (
            (self.path, json.dumps({"address": address, "identity": identity}, ensure_ascii=False)),
            (self.legacy, address + "\n"),
        ):
            fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=self.directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(body)
                os.replace(name, path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)

    def clear(self):
        for path in (self.path, self.legacy):
            path.unlink(missing_ok=True)


class Adb:
    def __init__(self, path):
        self.path = str(path)

    def run(self, *args, timeout=6):
        try:
            return subprocess.run([self.path, *args], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=timeout,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess(args, 124, "", "ADB 操作超时")
        except OSError as exc:
            raise MirrorError(f"无法运行 ADB：{exc}") from exc

    def text(self, *args, timeout=6):
        r = self.run(*args, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else ""

    def ready(self, address):
        return self.text("-s", address, "get-state", timeout=3) == "device"

    def identity(self, address):
        return self.text("-s", address, "shell", "getprop", "ro.serialno", timeout=3)

    def services(self, kind="connect"):
        return parse_services(self.text("mdns", "services"), kind)


def ask(prompt, secret=False):
    try:
        return (getpass.getpass(prompt) if secret else input(prompt)).strip()
    except (EOFError, KeyboardInterrupt):
        raise MirrorError("操作已取消") from None


def choose(items, title):
    if len(items) == 1:
        return items[0]
    print(title)
    for i, value in enumerate(items, 1):
        print(f"  {i}. {value}")
    for _ in range(5):
        value = ask("输入序号，Q 退出：")
        if value.lower() == "q":
            raise MirrorError("操作已取消")
        if value.isascii() and value.isdigit() and 1 <= int(value) <= len(items):
            return items[int(value) - 1]
    raise MirrorError("未选择有效设备")


class Connector:
    def __init__(self, adb, cache):
        self.adb, self.cache = adb, cache
        saved = cache.load()
        self.address = saved.get("address", "")
        self.identity = saved.get("identity", "")
        self.transport = ""  # Live ADB selector; never persist an ephemeral mDNS alias.
        self.discovered = []

    @property
    def serial(self):
        return self.transport or self.address

    def accept(self, address, transport=None):
        address = endpoint(address)
        transport = transport or address
        if transport != address and not re.fullmatch(r"adb-[A-Za-z0-9_-]+\._adb-tls-connect\._tcp\.?", transport):
            return False
        if not self.adb.ready(transport):
            return False
        identity = self.adb.identity(transport)
        # Do not silently adopt another phone when the original target disappears.
        if not identity or (self.identity and identity != self.identity):
            return False
        if address != self.address or identity != self.identity:
            self.cache.save(address, identity)
            logging.info("已确认设备 %s，地址 %s", identity, address)
        self.address, self.identity, self.transport = address, identity, transport
        return True

    def connect(self, address):
        address = endpoint(address)
        self.adb.run("connect", address, timeout=5)
        return self.accept(address)

    def discover(self, preferred_host=None):
        devices = parse_devices(self.adb.text("devices"))
        services = self.adb.services()
        self.discovered = services
        advertised = {name.rstrip(".") + "._adb-tls-connect._tcp": a for name, a in services}
        # A ready mDNS transport can stay usable while an old numeric transport
        # is offline. Use the actual ready selector instead of reconnecting it.
        live = [(advertised[d.rstrip(".")], d) for d in devices if d.rstrip(".") in advertised]
        live += [(a, a) for a in devices if host_of(a)]
        # A broadcast can expire briefly without invalidating an authenticated
        # transport. Retain the cached endpoint only as a future fallback.
        if self.identity and self.address and not preferred_host:
            live += [(self.address, d) for d in devices if d.rstrip(".") not in advertised
                     and re.fullmatch(r"adb-[A-Za-z0-9_-]+\._adb-tls-connect\._tcp\.?", d)]
        candidates = list(dict.fromkeys([a for a, _ in live] + [a for _, a in services]))
        if preferred_host:
            candidates = [a for a in candidates if host_of(a) == preferred_host]
        if not self.identity and len(candidates) > 1:
            candidates = [choose(candidates, "发现多台设备，请选择你的手机：")]
        for address, transport in live:
            if address in candidates and self.accept(address, transport):
                return self.address
        # Fresh advertised ports precede the saved port. With no broadcasts,
        # the saved endpoint remains a useful fallback without a new prompt.
        if self.address and (not preferred_host or host_of(self.address) == preferred_host):
            if self.identity or not candidates:
                candidates = list(dict.fromkeys(candidates + [self.address]))
        for address in candidates:
            if self.accept(address) or self.connect(address):
                return address
        return None

    def recover_once(self):
        if self.transport and self.accept(self.address, self.transport):
            return self.address
        return self.discover()

    def scan(self, host, seconds=20):
        host = str(ipaddress.ip_address(host))
        print(f"正在扫描手机 {host} 的 TCP 端口，最多约 {seconds} 秒……")
        # Probe one known phone only. Prefer dynamic ports, then cover the rest.
        ports = iter(list(range(32000, 65536)) + list(range(1, 32000)))
        deadline = time.monotonic() + seconds

        def probe(port):
            try:
                with socket.create_connection((host, port), timeout=0.12):
                    return port
            except OSError:
                return None

        executor = futures.ThreadPoolExecutor(max_workers=128)
        pending = set()
        exhausted = False
        try:
            while time.monotonic() < deadline:
                while len(pending) < 128 and not exhausted:
                    port = next(ports, None)
                    if port is None:
                        exhausted = True
                    else:
                        pending.add(executor.submit(probe, port))
                if not pending:
                    break
                done, pending = futures.wait(pending, timeout=0.2,
                                             return_when=futures.FIRST_COMPLETED)
                for task in done:
                    port = task.result()
                    if port and time.monotonic() < deadline:
                        address = endpoint(f"[{host}]:{port}" if ":" in host else f"{host}:{port}")
                        if self.connect(address):
                            return self.address
        finally:
            for task in pending:
                task.cancel()
            executor.shutdown(wait=True, cancel_futures=True)
        print("尚未确认可用的 ADB 端口；限时扫描可能没有覆盖全部端口。")
        return None

    def pair(self):
        print("在手机打开“无线调试 → 使用配对码配对设备”，保持弹窗打开。")
        services = self.adb.services("pairing")
        if services:
            pair_address = choose([a for _, a in services], "发现多个配对服务，请选择手机上的地址：")
            print("发现配对地址：", pair_address)
        else:
            try:
                pair_address = endpoint(ask("输入配对弹窗中的 IP:端口："))
            except ValueError as exc:
                raise MirrorError(str(exc)) from exc
        code = ask("输入弹窗中的 6 位配对码（不显示输入）：", secret=True)
        if not re.fullmatch(r"[0-9]{6}", code):
            raise MirrorError("配对码必须是 6 位数字，请重新打开配对弹窗后重试")
        result = self.adb.run("pair", pair_address, code, timeout=25)
        code = None  # Pairing secrets are never written to logs or cache.
        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0 or "successfully paired to" not in output.lower():
            raise MirrorError("配对未成功。请重新打开手机配对弹窗，检查地址和新配对码。")
        print("配对成功，正在寻找主连接地址……")
        # Pairing is an explicit user choice, so this may replace a saved phone.
        self.identity, self.address, self.transport = "", "", ""
        host = host_of(pair_address)
        for _ in range(3):
            found = self.discover(preferred_host=host)
            if found:
                return found
            time.sleep(1)
        print("配对已成功，但主连接尚未建立。主地址与配对地址的端口通常不同。")
        try:
            address = endpoint(ask("返回无线调试主页面，输入该页的 IP:端口："))
        except ValueError as exc:
            raise MirrorError(str(exc)) from exc
        if self.connect(address):
            return self.address
        raise MirrorError("配对已成功，但主地址连接失败。请确认无线调试仍开启。")

    def interactive(self):
        for _ in range(5):
            if self.discovered:
                print("发现手机广播，但未建立可用的 ADB 连接。可能是授权、手机服务或网络问题。")
            print("手机与电脑需处于可互访的 Wi-Fi 网络，并保持无线调试开启。")
            value = ask("回车重新发现；P 重新配对；输入 IP:端口或纯 IP；Q 退出：")
            if value.lower() == "q":
                raise MirrorError("操作已取消")
            if value.lower() == "p":
                return self.pair()
            if not value:
                found = self.discover()
            else:
                try:
                    if ":" in value and not value.startswith("["):
                        # An IPv6 literal without port is handled by ip_address below.
                        try:
                            host = str(ipaddress.ip_address(value))
                        except ValueError:
                            found = self.address if self.connect(value) else None
                        else:
                            found = self.scan(host)
                    elif value.startswith("[") and "]:" in value:
                        found = self.address if self.connect(value) else None
                    else:
                        found = self.scan(str(ipaddress.ip_address(value)))
                except ValueError:
                    print("地址格式错误，请输入 IP:端口或纯 IP。")
                    continue
            if found:
                return found
        raise MirrorError("多次尝试未能连接。请检查手机无线调试界面，或使用 pair 重新配对。")


def restart_needed(previous, current, was_disconnected, exited):
    return previous != current or was_disconnected or exited


class ScreenBridge:
    """Keep Android rendering while respecting the user's physical screen choice."""
    def __init__(self, adb, relay=None):
        self.adb = adb
        self.relay = relay
        self.last_attempt = -10
        self.last_wake = None
        self.dark_settle_until = 0
        self.last_panel = None
        self.sleep_token = None
        self.sleep_target = "dark"

    def tick(self, address):
        # One read-only shell invocation replaces two ADB process/transport round trips.
        # The final true preserves a usable power snapshot if display diagnostics fail.
        snapshot = self.adb.text("-s", address, "shell",
                                 "dumpsys power; dumpsys SurfaceFlinger --displays; true", timeout=2)
        power = snapshot
        state = re.search(r"mWakefulness=(\w+)", power)
        if not state:
            return False
        display = snapshot
        panel = re.search(r"powerMode=(\w+)", display)
        panel = panel.group(1) if panel else None
        wake = re.search(r"mLastWakeTime=(\S+)", power)
        wake = wake.group(1) if wake else None
        previous_wake, self.last_wake = self.last_wake, wake
        if state and state.group(1) == "Awake" and time.monotonic() < self.dark_settle_until:
            # vivo may asynchronously turn the panel back on as wake-up finishes.
            # Reapply only during this short wake transition, not throughout use.
            if self.relay and panel == "On":
                self.relay.set_power(False)
        elif state.group(1) == "Awake" and panel in ("On", "Off"):
            self.last_panel = panel
        if (state.group(1) == "Awake" and previous_wake and wake and wake != previous_wake
                and time.monotonic() >= self.dark_settle_until):
            if self.relay and self.relay.reset_video():
                logging.info("手机已唤醒，原窗口重新建立视频采集")
        if state.group(1) not in ("Asleep", "Dozing"):
            return False
        if not self.relay or not self.relay.ready.is_set():
            return False
        now = time.monotonic()
        if now - self.last_attempt < 2:
            return False
        self.last_attempt = now
        reason = re.search(r"mLastSleepReason=(\S+)", power)
        sleep_time = re.search(r"mLastSleepTime=(\S+)", power)
        token = sleep_time.group(1) if sleep_time else "unknown"
        if token != self.sleep_token:
            self.sleep_token = token
            # POWER from scrcpy's dark-but-awake state can be reported as sleep
            # by Android. Infer button intent from the panel BEFORE the event.
            wants_light = self.last_panel == "Off" and reason and reason.group(1) == "power_button"
            self.sleep_target = "light" if wants_light else "dark"
        if self.sleep_target == "light":
            self.dark_settle_until = 0
            if self.relay.wake_light_reset():
                self.last_panel = "On"
                logging.info("黑屏时按下电源键：手机亮屏，电脑原窗口继续运行")
                return True
            return False
        logging.info("亮屏时主动熄屏：恢复渲染并保持手机黑屏")
        # Use scrcpy's SurfaceControl implementation. Android's cmd display
        # override is inconsistent on this vivo model, even with exit status 0.
        if not self.relay.wake_dark_reset():
            logging.warning("显示控制通道暂时不可用，等待恢复")
            return False
        self.dark_settle_until = time.monotonic() + 3
        self.last_panel = "Off"
        return True


class Monitor:
    HEALTH_INTERVAL = 5.0

    def __init__(self, connector, scrcpy, logdir, screen_off=True, settings=None):
        self.connector, self.scrcpy = connector, Path(scrcpy)
        self.logdir, self.screen_off = Path(logdir), screen_off
        self.proc = None
        self.restarts = 0
        self.started = 0
        self.bridge = ScreenBridge(connector.adb)
        self.relay = None
        self.settings = settings if settings is not None else StreamSettings()
        self.next_probe = 0.0
        self.probe_failures = 0
        self.session_transport = ""

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        if self.relay:
            self.relay.close()
            self.connector.adb.run("-s", self.session_transport, "forward", "--remove", f"tcp:{self.relay.forward_port}")
            self.relay = None

    def spawn(self):
        self.stop()
        self.relay = ControlRelay()
        self.bridge = ScreenBridge(self.connector.adb, self.relay)
        self.session_transport = self.connector.serial
        logfile = self.logdir / "scrcpy.log"
        if logfile.exists() and logfile.stat().st_size > 2_000_000:
            os.replace(logfile, self.logdir / "scrcpy.previous.log")
        args = [str(self.scrcpy), "-s", self.session_transport,
                *self.settings.video_args(), "--no-audio", "--keep-active",
                "--window-title=无线投屏"]
        args += ["--port", str(self.relay.forward_port), "--tunnel-port", str(self.relay.port)]
        if self.screen_off:
            args += ["--turn-screen-off"]
        env = os.environ.copy()
        env["ADB"] = self.connector.adb.path  # scrcpy must use the same adb binary.
        env["SCRCPY_SERVER_PATH"] = str(self.scrcpy.parent / "scrcpy-server")
        with logfile.open("a", encoding="utf-8") as stream:
            self.proc = subprocess.Popen(args, cwd=self.scrcpy.parent, env=env,
                                         stdin=subprocess.DEVNULL,
                                         stdout=stream, stderr=subprocess.STDOUT)
        self.started = time.monotonic()
        self.next_probe = 0.0
        self.probe_failures = 0
        logging.info("投屏启动：%s，熄屏=%s，%s", self.connector.address, self.screen_off, self.settings.description())

    def connected_address(self, rc, disconnected, now):
        # Keep full identity verification on reconnect, but do not shell getprop every second.
        if rc is None and not disconnected and now < self.next_probe:
            return self.connector.address
        self.next_probe = now + self.HEALTH_INTERVAL
        address = self.connector.recover_once()
        if address:
            self.probe_failures = 0
            return address
        self.probe_failures += 1
        self.next_probe = now + 1
        recent_video = (self.relay and self.relay.last_video_at > 0
                        and now - self.relay.last_video_at < self.HEALTH_INTERVAL)
        if rc is None and not disconnected and (self.probe_failures < 2 or recent_video):
            return self.connector.address
        return None

    def run(self):
        self.spawn()
        disconnected = False
        next_notice = 0
        try:
            while True:
                time.sleep(1)
                rc = self.proc.poll()
                if rc == 0:
                    logging.info("投屏窗口已关闭，结束运行")
                    return
                if self.relay.error:
                    raise MirrorError(f"投屏控制协议异常：{self.relay.error}")
                now = time.monotonic()
                # Closing the window shuts its control socket before scrcpy
                # finishes Android cleanup. Let that normal exit complete.
                if (rc is None and self.relay.client_closed.is_set()
                        and now - self.relay.client_closed_at < 3):
                    continue
                broken = (self.relay.disconnected.is_set()
                          or (not self.relay.ready.is_set() and now - self.started > 15))
                previous = (self.connector.address, self.connector.serial)
                address = self.connected_address(rc, disconnected or broken, time.monotonic())
                if not address:
                    if not disconnected:
                        logging.info("连接中断，正在重试；关闭控制台可停止")
                        next_notice = time.monotonic() + 30
                    disconnected = True
                    if time.monotonic() >= next_notice:
                        logging.warning("仍在自动等待原手机恢复，请确认 Wi-Fi 和无线调试开启；Ctrl+C 可结束")
                        next_notice = time.monotonic() + 30
                    time.sleep(2)
                    continue
                if rc is None and not broken and not disconnected and time.monotonic() - self.started > 30:
                    self.restarts = 0
                current = (address, self.connector.serial)
                if restart_needed(previous, current, disconnected or broken, rc is not None):
                    logging.info("正在恢复投屏：退出码=%s，通道=%s", rc, self.relay.disconnect_reason or '重新核验连接')
                    self.restarts += 1
                    # Repeated short outages must not turn into a permanent
                    # exit. Back off, bounded to keep cancellation responsive.
                    time.sleep(min(0.5 * 2 ** min(self.restarts - 1, 5), 15))
                    self.spawn()
                disconnected = False
                self.bridge.tick(self.connector.serial)
        finally:
            self.stop()


def main(argv=None):
    parser = argparse.ArgumentParser(description="安卓无线投屏：自动连接、配对和断线恢复")
    parser.add_argument("mode", nargs="?", choices=("normal", "pair", "forget", "help"))
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--tools-dir", type=Path, help="覆盖投屏引擎目录，通常无需设置")
    parser.add_argument("--check", action="store_true", help="检查工具和设备状态，不启动投屏")
    parser.add_argument("--max-size", type=int, help="自定义最长边，128–4096")
    parser.add_argument("--bit-rate", help="自定义码率，例如 4M")
    parser.add_argument("--max-fps", type=int, help="自定义最高帧率，1–120")
    parser.add_argument("--hwdec", choices=("auto", "disabled", "d3d11va"), default="auto",
                        help="电脑解码方式；auto 可在硬件解码失败时回退软件")
    parser.add_argument("--video-encoder", help="指定手机编码器，仅在已确认支持时使用")
    parser.add_argument("--stats", action="store_true", help="在日志中记录帧率；静态画面低帧率不等于高延迟")
    parser.add_argument("--diagnose", action="store_true", help="测量 ADB 命令往返，不启动投屏")
    args = parser.parse_args(argv)
    if args.mode == "help":
        parser.print_help()
        print("无参数：熄屏投屏；normal：亮屏投屏；pair：重新配对并投屏；forget：清除地址并重新发现。")
        return 0
    try:
        settings = StreamSettings(args.max_size, args.bit_rate, args.max_fps,
                                  args.hwdec, args.video_encoder, args.stats)
    except ValueError as exc:
        parser.error(str(exc))
    project = args.project_dir.resolve()
    directory = project / "data"
    directory.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout),
                                  RotatingFileHandler(directory / "keepalive.log", maxBytes=1_000_000,
                                                      backupCount=2, encoding="utf-8")])
    engine = args.tools_dir.resolve() if args.tools_dir else project / "tools" / "scrcpy"
    adb_path, scrcpy = engine / "adb.exe", engine / "scrcpy.exe"
    if not scrcpy.is_file():
        raise MirrorError("缺少新版 scrcpy 5.0.1，请重新安装投屏优化版。")
    if not adb_path.is_file() or not scrcpy.is_file():
        raise MirrorError(f"工具不完整，请检查 {engine}")
    adb = Adb(adb_path)
    if args.check:
        for command in (("version",), ("devices", "-l"), ("mdns", "services")):
            result = adb.run(*command)
            print((result.stdout + result.stderr).strip())
            if result.returncode:
                return 1
        return 0
    if args.diagnose:
        connector = Connector(adb, Cache(directory))
        address = connector.discover()
        if not address:
            print("未发现已授权的手机，请先连接无线调试，再运行 --diagnose。")
            return 1
        return 0 if diagnose(adb, connector.serial, directory, settings)["successes"] else 1
    with InstanceLock(directory / 'mirror.lock') as lock:
        if not lock.acquired:
            print("投屏已在运行，请使用现有投屏窗口；恢复连接时无需重复启动。")
            return 0
        cache = Cache(directory)
        if args.mode == "forget":
            cache.clear()
            print("已清除地址和设备记录，正在重新发现。")
        connector = Connector(adb, cache)
        if args.mode == "pair":
            connector.pair()
        else:
            found = connector.discover()
            if not found:
                # Give mDNS a short warm-up before asking the user.
                time.sleep(2)
                found = connector.discover()
            if not found:
                connector.interactive()
        print("连接成功。关闭投屏窗口即可结束；Ctrl+C 停止等待。")
        print("投屏设置：", settings.description())
        Monitor(connector, scrcpy, directory, screen_off=args.mode != "normal", settings=settings).run()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已停止投屏。")
        raise SystemExit(0)
    except (MirrorError, OSError) as exc:
        print(f"\n{exc}")
        raise SystemExit(1)
