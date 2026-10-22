import importlib.util
import itertools
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import socket
import threading
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'app' / 'mirror.py'
sys.path.insert(0, str(SOURCE.parent))
spec = importlib.util.spec_from_file_location('mirror', SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeAdb:
    path = 'fake-adb.exe'

    def __init__(self):
        self.states = {}
        self.ids = {}
        self.records = []
        self.pair_records = []
        self.connections = {}
        self.calls = []
        self.pair_result = subprocess.CompletedProcess([], 0, 'Successfully paired to 192.168.4.9:60000', '')

    def ready(self, address):
        return self.states.get(address, False)

    def identity(self, address):
        return self.ids.get(address, '')

    def run(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == 'pair':
            return self.pair_result
        if args[0] == 'connect' and args[1] in self.connections:
            self.states[args[1]] = True
            self.ids[args[1]] = self.connections[args[1]]
        return subprocess.CompletedProcess(args, 0, '', '')

    def services(self, kind='connect'):
        return self.pair_records if kind == 'pairing' else self.records

    def text(self, *args, **kwargs):
        if args[0] == 'devices':
            return 'List of devices attached\n' + '\n'.join(
                f'{a}\tdevice' for a, ready in self.states.items() if ready)
        return ''


class CoreTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parent / 'tmp'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        assert Path(self.temp.name).resolve().is_relative_to(scratch)
        self.addCleanup(self.temp.cleanup)
        self.cache = m.Cache(self.temp.name)
        self.adb = FakeAdb()
        self.relay = Mock(error=None, forward_port=12345, port=12346, last_video_at=0.0, end_origin=None)
        self.relay.disconnected.is_set.return_value = False
        self.relay.client_closed.is_set.return_value = False
        self.relay.dark_and_reset.return_value = True
        self.relay.wake_dark_reset.return_value = True
        self.relay.wake_light_reset.return_value = True
        relay_patch = patch.object(m, 'ControlRelay', return_value=self.relay)
        relay_patch.start()
        self.addCleanup(relay_patch.stop)

    def target(self, address='192.168.4.9:41000', identity='PHONE-A'):
        self.cache.save(address, identity)
        return m.Connector(self.adb, self.cache)

    def test_validate_addresses(self):
        self.assertEqual(m.endpoint('192.168.4.9:65535'), '192.168.4.9:65535')
        self.assertEqual(m.endpoint('[fd00::1]:5555'), '[fd00::1]:5555')
        for bad in ('192.168.4.9', '192.168.4.9:0', '192.168.4.9:65536',
                    '192.168.4.999:5555', 'localhost:5555', '1.1.1.1:５５５５',
                    '1.1.1.1:5555 & calc.exe'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                m.endpoint(bad)

    def test_mdns_services_not_headers_or_pairing(self):
        output = ('List of discovered mdns services\n'
                  'adb-A _adb-tls-connect._tcp 192.168.4.9:60000\n'
                  'adb-P _adb-tls-pairing._tcp 192.168.4.9:42000\n'
                  'bad _adb-tls-connect._tcp wrong:5\n')
        self.assertEqual(m.parse_services(output), [('adb-A', '192.168.4.9:60000')])
        self.assertEqual(m.parse_services(output, 'pairing'), [('adb-P', '192.168.4.9:42000')])

    def test_devices_exact_state_including_alias(self):
        self.assertEqual(m.parse_devices('List of devices attached\n'
                         'ip:5 offline\nX unauthorized\nadb-A._adb-tls-connect._tcp device\n'),
                         ['adb-A._adb-tls-connect._tcp'])

    def test_legacy_cache_migration(self):
        self.cache.legacy.write_text('192.168.4.9:41000\n')
        c = m.Connector(self.adb, self.cache)
        self.adb.states[c.address] = True
        self.adb.ids[c.address] = 'PHONE-A'
        self.assertTrue(c.accept(c.address))
        self.assertEqual(self.cache.load()['identity'], 'PHONE-A')

    def test_corrupt_json_falls_back_without_crash(self):
        self.cache.path.write_text('null')
        self.assertEqual(self.cache.load(), {})

    def test_cache_clear_both_formats(self):
        self.cache.save('192.168.4.9:60000', 'PHONE-A')
        self.cache.clear()
        self.assertFalse(self.cache.path.exists())
        self.assertFalse(self.cache.legacy.exists())

    def test_reconnect_same_address_without_mdns(self):
        c = self.target()
        self.adb.connections[c.address] = 'PHONE-A'
        self.assertEqual(c.recover_once(), '192.168.4.9:41000')
        self.assertIn(('connect', c.address), self.adb.calls)

    def test_new_ip_port_saves_cache(self):
        c = self.target()
        new = '192.168.4.79:61000'
        self.adb.records = [('adb-A', new)]
        self.adb.connections[new] = 'PHONE-A'
        self.assertEqual(c.recover_once(), new)
        self.assertEqual(self.cache.load()['address'], new)
        self.assertEqual(self.cache.legacy.read_text().strip(), new)

    def test_stale_legacy_address_does_not_force_manual_selection(self):
        self.cache.legacy.write_text('192.168.4.9:41000')
        c = m.Connector(self.adb, self.cache)
        new = '192.168.4.79:61000'
        self.adb.records = [('adb-A', new)]
        self.adb.connections[new] = 'PHONE-A'
        with patch.object(m, 'choose', side_effect=AssertionError('unexpected prompt')):
            self.assertEqual(c.discover(), new)

    def test_other_phone_is_never_adopted(self):
        c = self.target()
        wrong = '192.168.4.8:60000'
        self.adb.records = [('adb-B', wrong)]
        self.adb.connections[wrong] = 'PHONE-B'
        self.assertIsNone(c.recover_once())
        self.assertEqual(self.cache.load()['identity'], 'PHONE-A')

    def test_alias_is_resolved_to_endpoint(self):
        c = self.target()
        address = '192.168.4.9:60000'
        self.adb.records = [('adb-A', address)]
        self.adb.states['adb-A._adb-tls-connect._tcp'] = True
        self.adb.connections[address] = 'PHONE-A'
        self.assertEqual(c.discover(), address)

    def test_ready_alias_precedes_stale_cached_port_and_is_used_for_stream(self):
        c = self.target()
        old, new, alias = c.address, '192.168.4.9:60000', 'adb-A._adb-tls-connect._tcp'
        self.adb.records = [('adb-A', new)]
        self.adb.states[alias], self.adb.ids[alias] = True, 'PHONE-A'
        self.assertEqual(c.discover(), new)
        self.assertEqual(c.serial, alias)
        self.assertNotIn(('connect', old), self.adb.calls)
        self.assertNotIn(('connect', new), self.adb.calls)
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        with patch.object(m.subprocess, 'Popen') as popen:
            monitor.spawn()
        self.assertEqual(popen.call_args.args[0][2], alias)
        self.assertEqual(self.cache.load()['address'], new)
        self.assertNotIn(alias, self.cache.path.read_text())

    def test_ready_alias_without_broadcast_still_requires_same_identity(self):
        c = self.target()
        alias = 'adb-A._adb-tls-connect._tcp'
        self.adb.states[alias], self.adb.ids[alias] = True, 'PHONE-B'
        self.assertIsNone(c.discover())
        self.assertEqual(c.identity, 'PHONE-A')
        self.adb.ids[alias] = 'PHONE-A'
        self.assertEqual(c.discover(), c.address)
        self.assertEqual(c.serial, alias)

    def test_fresh_broadcast_precedes_dead_numeric_port(self):
        c = self.target()
        old, new = c.address, '192.168.4.9:60000'
        self.adb.records = [('adb-A', new)]
        self.adb.connections[new] = 'PHONE-A'
        self.assertEqual(c.discover(), new)
        self.assertNotIn(('connect', old), self.adb.calls)

    def test_alias_transport_cannot_skip_identity_or_accept_arbitrary_selector(self):
        c = self.target()
        for selector in ('-d', 'USB-OTHER', 'adb-A._adb-tls-pairing._tcp', 'adb-A;calc'):
            self.adb.states[selector], self.adb.ids[selector] = True, 'PHONE-A'
            self.assertFalse(c.accept(c.address, selector))
        self.assertEqual(c.transport, '')

    def test_no_identity_cannot_be_accepted(self):
        c = self.target()
        self.adb.states[c.address] = True
        self.assertFalse(c.accept(c.address))

    def test_pair_failure_does_not_claim_success_or_clear_target(self):
        c = self.target()
        self.adb.pair_records = [('adb-A', '192.168.4.9:60000')]
        self.adb.pair_result = subprocess.CompletedProcess([], 1, '', 'failed')
        with patch.object(m, 'ask', return_value='123456'), self.assertRaises(m.MirrorError):
            c.pair()
        self.assertEqual(c.identity, 'PHONE-A')

    def test_zero_exit_without_pair_success_is_failure(self):
        c = self.target()
        self.adb.pair_records = [('adb-A', '192.168.4.9:60000')]
        self.adb.pair_result = subprocess.CompletedProcess([], 0, 'failed to pair', '')
        with patch.object(m, 'ask', return_value='123456'), self.assertRaises(m.MirrorError):
            c.pair()

    def test_pair_success_connects_automatically_without_cached_old_phone(self):
        c = self.target()
        new = '192.168.4.9:61000'
        self.adb.pair_records = [('adb-new', '192.168.4.9:60000')]
        self.adb.records = [('adb-new', new), ('adb-other', '192.168.4.8:62000')]
        self.adb.connections[new] = 'PHONE-NEW'
        with patch.object(m, 'ask', return_value='012345'):
            self.assertEqual(c.pair(), new)
        self.assertEqual(self.cache.load()['identity'], 'PHONE-NEW')
        self.assertNotIn('012345', self.cache.path.read_text())

    def test_eof_exits_and_does_not_loop(self):
        with patch('builtins.input', side_effect=EOFError), self.assertRaises(m.MirrorError):
            m.ask('prompt')

    def test_blank_input_rediscovers(self):
        c = self.target()
        with patch.object(m, 'ask', return_value=''), patch.object(c, 'discover', return_value=c.address):
            self.assertEqual(c.interactive(), c.address)

    def test_invalid_input_never_becomes_subprocess_command(self):
        c = self.target()
        with patch.object(m, 'ask', side_effect=['1.2.3.4:5 & calc', 'q']), self.assertRaises(m.MirrorError):
            c.interactive()
        self.assertEqual(self.adb.calls, [])

    def test_single_host_scan_can_find_port_outside_old_range(self):
        c = self.target()
        address = '192.168.4.9:32005'
        self.adb.connections[address] = 'PHONE-A'
        def socket_connect(target, timeout):
            self.assertEqual(target[0], '192.168.4.9')
            if target[1] != 32005:
                raise OSError('closed')
            return Mock(__enter__=Mock(), __exit__=Mock(return_value=False))
        with patch.object(m.socket, 'create_connection', side_effect=socket_connect):
            self.assertEqual(c.scan('192.168.4.9', seconds=2), address)

    def test_restart_after_same_address_reconnect_or_address_change(self):
        self.assertTrue(m.restart_needed('A', 'A', True, False))
        self.assertTrue(m.restart_needed('A', 'B', False, False))
        self.assertTrue(m.restart_needed('A', 'A', False, True))
        self.assertFalse(m.restart_needed('A', 'A', False, False))

    def test_normal_and_forget_reach_launch(self):
        tools = Path(self.temp.name) / 'tools'
        tools.mkdir()
        (tools / 'adb.exe').touch()
        (tools / 'scrcpy.exe').touch()
        modern = tools / 'versions' / 'scrcpy-win64-v5.0.1'
        modern.mkdir(parents=True)
        (modern / 'scrcpy.exe').touch()
        for mode in ('normal', 'forget'):
            with self.subTest(mode=mode), patch.dict(os.environ, LOCALAPPDATA=self.temp.name), \
                 patch.object(m, 'Adb'), patch.object(m, 'Connector') as cls, \
                 patch.object(m, 'Monitor') as monitor, patch.object(m.logging, 'basicConfig'), \
                 patch.object(m, 'RotatingFileHandler'):
                cls.return_value.discover.return_value = '192.168.4.9:60000'
                self.assertEqual(m.main([mode, '--tools-dir', str(tools), '--project-dir', self.temp.name]), 0)
                self.assertEqual(monitor.call_args.kwargs['screen_off'], mode != 'normal')
                monitor.return_value.run.assert_called_once()

    def test_project_data_and_engine_are_relative_to_project(self):
        project = Path(self.temp.name) / 'relocated-project'
        engine = project / 'tools' / 'scrcpy'
        engine.mkdir(parents=True)
        (engine / 'adb.exe').touch()
        (engine / 'scrcpy.exe').touch()
        with patch.object(m, 'Adb') as adb, patch.object(m, 'Connector') as connector, \
             patch.object(m, 'Monitor'), patch.object(m.logging, 'basicConfig'), \
             patch.object(m, 'RotatingFileHandler'):
            connector.return_value.discover.return_value = '192.168.4.9:60000'
            self.assertEqual(m.main(['--project-dir', str(project)]), 0)
        self.assertEqual(adb.call_args.args[0], engine / 'adb.exe')
        self.assertEqual(connector.call_args.args[1].directory, project / 'data')

    def test_monitor_close_window_exits_without_relaunch(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        proc = Mock()
        proc.poll.return_value = 0
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 1)

    def test_window_close_waits_for_cleanup_instead_of_restarting(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        proc = Mock()
        proc.poll.side_effect = [None, 0]
        proc.wait.return_value = 0
        self.relay.disconnected.is_set.return_value = True
        self.relay.client_closed.is_set.return_value = True
        self.relay.client_closed_at = 10
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(c, 'recover_once') as recover, patch.object(m.time, 'sleep'), \
             patch.object(m.time, 'monotonic', return_value=100):
            monitor.run()
        self.assertEqual(popen.call_count, 1)
        recover.assert_not_called()
        proc.wait.assert_called_once_with(timeout=monitor.EXIT_TIMEOUT)
        proc.terminate.assert_not_called()

    def test_client_close_timeout_stops_instead_of_reopening(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        proc = Mock()
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired('scrcpy', monitor.EXIT_TIMEOUT), 0]
        self.relay.client_closed.is_set.return_value = True
        self.relay.end_origin = 'client'
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(c, 'recover_once') as recover, patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 1)
        recover.assert_not_called()
        proc.terminate.assert_called_once()

    def test_remote_close_timeout_still_recovers(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        old, new = Mock(), Mock()
        old.poll.return_value, new.poll.return_value = None, 0
        old.wait.side_effect = [subprocess.TimeoutExpired('scrcpy', monitor.EXIT_TIMEOUT), 0]
        self.relay.disconnected.is_set.return_value = True
        self.relay.end_origin = 'remote'
        with patch.object(m.subprocess, 'Popen', side_effect=[old, new]) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 2)

    def test_window_close_during_failed_discovery_cancels_waiting(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        proc = Mock()
        proc.poll.return_value = None
        def discover(*_):
            proc.poll.return_value = 0
            return None
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(monitor, 'connected_address', side_effect=discover), patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 1)

    def test_window_close_during_reconnect_backoff_cancels_relaunch(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        proc = Mock()
        proc.poll.return_value = None
        def discover():
            c.address = '192.168.4.9:62000'
            return c.address
        def sleep(seconds):
            if seconds == .5:
                proc.poll.return_value = 0
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(c, 'recover_once', side_effect=discover), patch.object(m.time, 'sleep', side_effect=sleep):
            monitor.run()
        self.assertEqual(popen.call_count, 1)

    def test_instance_lock_blocks_duplicate_and_can_be_reacquired(self):
        path = Path(self.temp.name) / 'mirror.lock'
        with m.InstanceLock(path) as first:
            self.assertTrue(first.acquired)
            with m.InstanceLock(path) as second:
                self.assertFalse(second.acquired)
        with m.InstanceLock(path) as third:
            self.assertTrue(third.acquired)

    def test_crashed_process_does_not_leave_stale_instance_lock(self):
        path = Path(self.temp.name) / 'mirror.lock'
        code = ("import os,sys; sys.path.insert(0,sys.argv[1]); from mirror import InstanceLock; "
                "lock=InstanceLock(sys.argv[2]); lock.__enter__(); assert lock.acquired; os._exit(0)")
        result = subprocess.run([sys.executable, '-X', 'utf8', '-B', '-c', code, str(SOURCE.parent), str(path)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        with m.InstanceLock(path) as lock:
            self.assertTrue(lock.acquired)

    def test_duplicate_start_does_not_launch_or_forget_running_phone(self):
        tools = Path(self.temp.name) / 'tools'
        tools.mkdir()
        (tools / 'adb.exe').touch()
        (tools / 'scrcpy.exe').touch()
        data = Path(self.temp.name) / 'data'
        data.mkdir()
        m.Cache(data).save('192.168.4.9:41000', 'PHONE-A')
        with m.InstanceLock(data / 'mirror.lock'), patch.object(m, 'Monitor') as monitor, \
             patch.object(m, 'Adb'), patch.object(m.logging, 'basicConfig'), patch.object(m, 'RotatingFileHandler'):
            self.assertEqual(m.main(['forget', '--project-dir', self.temp.name, '--tools-dir', str(tools)]), 0)
        monitor.assert_not_called()
        self.assertEqual(m.Cache(data).load()['identity'], 'PHONE-A')

    def test_monitor_restarts_alive_stale_window_after_same_address_recovery(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, False)
        old_proc, new_proc = Mock(), Mock()
        old_proc.poll.return_value = None
        new_proc.poll.return_value = 0
        with patch.object(m.subprocess, 'Popen', side_effect=[old_proc, new_proc]) as popen, \
             patch.object(c, 'recover_once', side_effect=[None, None, c.address]), \
             patch.object(m.time, 'sleep'), patch.object(m.time, 'monotonic', side_effect=itertools.count()):
            monitor.run()
        self.assertEqual(popen.call_count, 2)
        old_proc.terminate.assert_called_once()

    def test_monitor_restarts_when_address_changes_even_if_window_alive(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, False)
        old_proc, new_proc = Mock(), Mock()
        old_proc.poll.return_value = None
        new_proc.poll.return_value = 0
        new = '192.168.4.79:61000'
        def recover():
            c.address = new
            return new
        with patch.object(m.subprocess, 'Popen', side_effect=[old_proc, new_proc]) as popen, \
             patch.object(c, 'recover_once', side_effect=recover), patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_args.args[0][2], new)
        old_proc.terminate.assert_called_once()

    def test_monitor_keeps_recovering_after_three_failed_restarts_with_bounded_backoff(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, False)
        failed, closed = Mock(), Mock()
        failed.poll.return_value, closed.poll.return_value = 2, 0
        with patch.object(m.subprocess, 'Popen', side_effect=[failed] * 8 + [closed]) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), \
             patch.object(m.time, 'sleep') as sleep, patch.object(m.time, 'monotonic', return_value=0):
            monitor.run()
        self.assertEqual(popen.call_count, 9)
        self.assertTrue(all(0 < call.args[0] <= 15 for call in sleep.call_args_list))
        self.assertIn(unittest.mock.call(15), sleep.call_args_list)

    def test_monitor_transport_failure_restarts_alive_window(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        old, new = Mock(), Mock()
        old.poll.return_value, new.poll.return_value = None, 0
        old.wait.return_value = 2
        self.relay.disconnected.is_set.return_value = True
        with patch.object(m.subprocess, 'Popen', side_effect=[old, new]) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 2)
        old.terminate.assert_called_once()

    def test_startup_without_control_handshake_is_retried_after_deadline(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        old, new = Mock(), Mock()
        old.poll.return_value, new.poll.return_value = None, 0
        self.relay.ready.is_set.return_value = False
        with patch.object(m.subprocess, 'Popen', side_effect=[old, new]) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), patch.object(m.time, 'sleep'), \
             patch.object(m.time, 'monotonic', side_effect=itertools.count(0, 20)):
            monitor.run()
        self.assertEqual(popen.call_count, 2)

    def test_monitor_waits_beyond_one_minute_without_manual_prompt(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        old, new = Mock(), Mock()
        old.poll.return_value, new.poll.return_value = 2, 0
        with patch.object(m.subprocess, 'Popen', side_effect=[old, new]) as popen, \
             patch.object(c, 'recover_once', side_effect=[None] * 80 + [c.address]), \
             patch.object(c, 'interactive', side_effect=AssertionError('must recover automatically')), \
             patch.object(m.time, 'sleep'), patch.object(m.time, 'monotonic', side_effect=itertools.count()):
            monitor.run()
        self.assertEqual(popen.call_count, 2)

    def test_forward_cleanup_uses_original_session_after_port_change(self):
        c = self.target()
        old = c.address
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        with patch.object(m.subprocess, 'Popen'):
            monitor.spawn()
        c.address, c.transport = '192.168.4.9:62000', 'adb-A._adb-tls-connect._tcp'
        monitor.stop()
        self.assertIn(('-s', old, 'forward', '--remove', 'tcp:12345'), self.adb.calls)

    def test_spawn_uses_selected_device_absolute_adb_and_screen_mode(self):
        c = self.target()
        for screen_off in (True, False):
            monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, screen_off)
            with patch.object(m.subprocess, 'Popen') as popen:
                monitor.spawn()
            args, kwargs = popen.call_args
            self.assertEqual(args[0][1:3], ['-s', c.address])
            self.assertEqual('--turn-screen-off' in args[0], screen_off)
            self.assertEqual(kwargs['env']['ADB'], c.adb.path)

    def test_adb_timeout_is_bounded(self):
        with patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('adb', 3)):
            result = m.Adb('adb.exe').run('devices', timeout=3)
        self.assertEqual(result.returncode, 124)

    def test_active_sleep_wakes_android_then_blacks_panel_without_restart(self):
        self.adb.text = Mock(return_value='mWakefulness=Asleep')
        bridge = m.ScreenBridge(self.adb, self.relay)
        self.assertTrue(bridge.tick('192.168.4.9:60000'))
        self.assertEqual(self.adb.calls, [])
        self.relay.wake_dark_reset.assert_called_once()

    def test_phone_awake_is_not_forced_dark(self):
        self.adb.text = Mock(return_value='mWakefulness=Awake')
        self.assertFalse(m.ScreenBridge(self.adb, self.relay).tick('192.168.4.9:60000'))
        self.assertEqual(self.adb.calls, [])

    def test_missing_power_state_does_not_send_blind_wake(self):
        self.adb.text = Mock(return_value='')
        self.assertFalse(m.ScreenBridge(self.adb).tick('192.168.4.9:60000'))
        self.assertEqual(self.adb.calls, [])

    def test_failed_wakeup_does_not_send_display_command(self):
        self.adb.text = Mock(return_value='mWakefulness=Asleep')
        self.relay.wake_dark_reset.return_value = False
        self.assertFalse(m.ScreenBridge(self.adb, self.relay).tick('192.168.4.9:60000'))
        self.assertEqual(self.adb.calls, [])

    def test_monitor_keeps_same_window_during_physical_sleep(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, True)
        proc = Mock()
        proc.poll.side_effect = [None, 0, 0]
        self.adb.text = Mock(return_value='mWakefulness=Asleep')
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), patch.object(m.time, 'sleep'):
            monitor.run()
        self.assertEqual(popen.call_count, 1)
        self.relay.wake_dark_reset.assert_called_once()

    def test_waking_phone_resets_capture_without_forcing_panel_off(self):
        bridge = m.ScreenBridge(self.adb, self.relay)
        self.adb.text = Mock(side_effect=['mWakefulness=Awake\nmLastWakeTime=10',
                                        'mWakefulness=Awake\nmLastWakeTime=20'])
        bridge.tick('192.168.4.9:60000')
        bridge.tick('192.168.4.9:60000')
        self.relay.reset_video.assert_called_once()
        self.relay.dark_and_reset.assert_not_called()

    def test_power_button_from_dark_lights_phone_instead_of_forcing_dark(self):
        bridge = m.ScreenBridge(self.adb, self.relay)
        self.adb.text = Mock(side_effect=[
            'mWakefulness=Awake\npowerMode=Off',
            'mWakefulness=Dozing\nmLastSleepReason=power_button\nmLastSleepTime=20\npowerMode=Doze'])
        bridge.tick('192.168.4.9:60000')
        bridge.tick('192.168.4.9:60000')
        self.relay.wake_light_reset.assert_called_once()
        self.relay.wake_dark_reset.assert_not_called()

    def test_power_button_from_lit_phone_recovers_dark(self):
        bridge = m.ScreenBridge(self.adb, self.relay)
        self.adb.text = Mock(side_effect=[
            'mWakefulness=Awake\npowerMode=On',
            'mWakefulness=Asleep\nmLastSleepReason=power_button\nmLastSleepTime=20\npowerMode=Off'])
        bridge.tick('192.168.4.9:60000')
        bridge.tick('192.168.4.9:60000')
        self.relay.wake_dark_reset.assert_called_once()
        self.relay.wake_light_reset.assert_not_called()

    def test_fragmented_control_packets_wait_for_complete_clipboard(self):
        from scrcpy_link import packet_size
        clipboard = bytes([9]) + bytes(8) + bytes([0]) + (6).to_bytes(4, 'big') + b'secret'
        for index in range(len(clipboard)):
            self.assertIsNone(packet_size(clipboard[:index]))
        self.assertEqual(packet_size(clipboard), len(clipboard))
        self.assertEqual(packet_size(clipboard + bytes([17])), len(clipboard))

    def test_mixed_mouse_keyboard_and_recovery_packets_stay_framed(self):
        from scrcpy_link import packet_size
        packets = [bytes([0]) + bytes(13), bytes([2]) + bytes(31), bytes([3]) + bytes(20),
                   bytes([10, 0]), bytes([17]), bytes([1]) + (3).to_bytes(4, 'big') + b'abc']
        stream = b''.join(packets)
        actual = []
        while stream:
            size = packet_size(stream)
            actual.append(stream[:size])
            stream = stream[size:]
        self.assertEqual(actual, packets)

    def test_invalid_control_packets_fail_without_unbounded_allocation(self):
        from scrcpy_link import packet_size
        for data in (bytes([255]), bytes([1, 255, 255, 255, 255])):
            with self.assertRaises(ValueError):
                packet_size(data)

    def test_single_default_preserves_detail_without_added_video_buffer(self):
        settings = m.StreamSettings()
        self.assertEqual((settings.max_size, settings.bit_rate, settings.max_fps), (1600, '6M', 60))
        self.assertIn('--video-codec=h264', settings.video_args())
        self.assertIn('--video-buffer=0', settings.video_args())
        self.assertIn('--hwdec=auto', settings.video_args())
        self.assertNotIn('--print-fps', settings.video_args())
        self.assertNotIn('--no-mipmaps', settings.video_args())

    def test_maintenance_custom_settings_survive_spawn(self):
        c = self.target()
        settings = m.StreamSettings(max_size=800, bit_rate='3m', max_fps=45,
                                    hwdec='disabled', encoder='c2.vendor.avc.encoder', stats=True)
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, settings=settings)
        with patch.object(m.subprocess, 'Popen') as popen:
            monitor.spawn()
        args = popen.call_args.args[0]
        self.assertEqual(args[args.index('-m') + 1], '800')
        self.assertEqual(args[args.index('-b') + 1], '3M')
        self.assertEqual(args[args.index('--max-fps') + 1], '45')
        self.assertIn('--hwdec=disabled', args)
        self.assertIn('--print-fps', args)
        self.assertEqual(args[args.index('--video-encoder') + 1], 'c2.vendor.avc.encoder')
        self.assertIn('--tunnel-port', args)
        self.assertIn('--turn-screen-off', args)

    def test_stream_settings_reject_invalid_sizes_rates_and_encoders(self):
        invalid = [dict(max_size=0), dict(max_size=9000), dict(max_fps=0), dict(max_fps=121),
                   dict(bit_rate='0M'), dict(bit_rate='5M --record=x'), dict(bit_rate='100M'),
                   dict(encoder='--record=x'), dict(hwdec='unrecognized')]
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                m.StreamSettings(**kwargs)

    def test_full_identity_health_check_is_throttled_but_disconnect_is_not(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        with patch.object(c, 'recover_once', return_value=c.address) as probe:
            for second in range(30):
                self.assertEqual(monitor.connected_address(None, False, second), c.address)
            self.assertEqual(probe.call_count, 6)
            monitor.connected_address(2, False, 29.1)
            monitor.connected_address(None, True, 29.2)
            self.assertEqual(probe.call_count, 8)

    def test_one_health_probe_failure_keeps_window_but_two_idle_failures_recover(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        monitor.relay = self.relay
        with patch.object(c, 'recover_once', return_value=None):
            self.assertEqual(monitor.connected_address(None, False, 10), c.address)
            self.assertIsNone(monitor.connected_address(None, False, 11))

    def test_current_video_prevents_metadata_probe_from_restarting_healthy_window(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name)
        monitor.relay = self.relay
        self.relay.last_video_at = 10
        with patch.object(c, 'recover_once', return_value=None):
            self.assertEqual(monitor.connected_address(None, False, 11), c.address)
            self.assertEqual(monitor.connected_address(None, False, 12), c.address)
            self.assertIsNone(monitor.connected_address(None, True, 13))

    def test_screen_state_uses_one_adb_request(self):
        self.adb.text = Mock(return_value='mWakefulness=Awake\npowerMode=On')
        m.ScreenBridge(self.adb, self.relay).tick('192.168.4.9:60000')
        self.adb.text.assert_called_once()
        args = self.adb.text.call_args.args
        self.assertEqual(args[:3], ('-s', '192.168.4.9:60000', 'shell'))
        self.assertIn('dumpsys power', args[3])
        self.assertIn('dumpsys SurfaceFlinger --displays', args[3])

    def test_dark_settle_does_not_repeatedly_reset_video_encoder(self):
        bridge = m.ScreenBridge(self.adb, self.relay)
        bridge.dark_settle_until = 103
        bridge.last_wake = 'old'
        self.adb.text = Mock(side_effect=[
            'mWakefulness=Awake\nmLastWakeTime=new\npowerMode=On',
            'mWakefulness=Awake\nmLastWakeTime=new\npowerMode=Off',
        ])
        with patch.object(m.time, 'monotonic', return_value=101):
            bridge.tick('192.168.4.9:60000')
            bridge.tick('192.168.4.9:60000')
        self.relay.set_power.assert_called_once_with(False)
        self.relay.reset_video.assert_not_called()
        self.relay.dark_and_reset.assert_not_called()

    def test_missing_wake_timestamp_does_not_reset_capture(self):
        bridge = m.ScreenBridge(self.adb, self.relay)
        bridge.last_wake = 'known'
        self.adb.text = Mock(return_value='mWakefulness=Awake\npowerMode=On')
        bridge.tick('192.168.4.9:60000')
        self.relay.reset_video.assert_not_called()

    def test_diagnostics_exclude_failures_from_percentiles_and_device_details(self):
        adb = Mock()
        adb.run.side_effect = [subprocess.CompletedProcess([], code, '', '') for code in [0, 1, 0, 0]]
        timestamps = [0, .010, 1, 1.2, 2, 2.020, 3, 3.030]
        with patch.object(m.time, 'perf_counter', side_effect=timestamps):
            report = m.diagnose(adb, '192.168.4.9:60000', self.temp.name, m.StreamSettings(), samples=4)
        self.assertEqual((report['successes'], report['failures']), (3, 1))
        self.assertEqual(report['median_ms'], 20.0)
        self.assertEqual(report['p95_ms'], 30.0)
        self.assertEqual(adb.run.call_count, 4)
        saved = (Path(self.temp.name) / 'latency-diagnostics.json').read_text(encoding='utf-8')
        self.assertNotIn('192.168.', saved)
        self.assertNotIn('PHONE-', saved)

    def test_all_failed_diagnostics_do_not_invent_a_latency(self):
        adb = Mock()
        adb.run.return_value = subprocess.CompletedProcess([], 124, '', '')
        report = m.diagnose(adb, '192.168.4.9:60000', self.temp.name, m.StreamSettings(), samples=2)
        self.assertIsNone(report['median_ms'])
        self.assertIsNone(report['p95_ms'])
        self.assertEqual(report['failures'], 2)

    def test_diagnose_does_not_pair_forget_or_start_mirroring(self):
        tools = Path(self.temp.name) / 'tools'
        tools.mkdir()
        (tools / 'adb.exe').touch()
        (tools / 'scrcpy.exe').touch()
        with patch.object(m, 'Adb'), patch.object(m, 'Connector') as connector, \
             patch.object(m, 'Monitor') as monitor, patch.object(m, 'diagnose', return_value={'successes': 8}) as diagnose, \
             patch.object(m.logging, 'basicConfig'), patch.object(m, 'RotatingFileHandler'):
            connector.return_value.discover.return_value = '192.168.4.9:60000'
            self.assertEqual(m.main(['--diagnose', '--project-dir', self.temp.name, '--tools-dir', str(tools)]), 0)
        diagnose.assert_called_once()
        connector.return_value.pair.assert_not_called()
        monitor.assert_not_called()


class RelayStartupTests(unittest.TestCase):
    def test_empty_startup_probe_is_retried_without_poisoning_live_connection(self):
        from scrcpy_link import ControlRelay
        relay = ControlRelay()
        self.addCleanup(relay.close)
        server = socket.socket()
        self.addCleanup(server.close)
        server.bind(('127.0.0.1', relay.forward_port))
        server.listen(2)
        server.settimeout(3)
        probe = socket.create_connection(('127.0.0.1', relay.port), timeout=3)
        self.addCleanup(probe.close)
        first, _ = server.accept()
        first.close()  # ADB forward exists; Android's server is not ready yet.
        self.assertEqual(probe.recv(1), b'')
        client = socket.create_connection(('127.0.0.1', relay.port), timeout=3)
        self.addCleanup(client.close)
        backend, _ = server.accept()
        self.addCleanup(backend.close)
        backend.sendall(b'\x00frame')
        self.assertEqual(client.recv(1), b'\x00')
        self.assertEqual(client.recv(5), b'frame')
        self.assertFalse(relay.disconnected.is_set())
        self.assertIsNone(relay.error)


class RelaySocketTests(unittest.TestCase):
    """Exercise real loopback streams: mocks cannot expose dropped bytes/EOF."""

    def setUp(self):
        from scrcpy_link import ControlRelay
        self.relay = ControlRelay()
        self.addCleanup(self.relay.close)
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', self.relay.forward_port))
        self.server.listen(2)
        self.server.settimeout(3)
        self.addCleanup(self.server.close)
        self.video_client = socket.create_connection(('127.0.0.1', self.relay.port), timeout=3)
        self.addCleanup(self.video_client.close)
        self.video_server, _ = self.server.accept()
        self.addCleanup(self.video_server.close)
        self.video_server.sendall(b'\x00')
        self.assertEqual(self.video_client.recv(1), b'\x00')
        self.control_client = socket.create_connection(('127.0.0.1', self.relay.port), timeout=3)
        self.addCleanup(self.control_client.close)
        self.control_server, _ = self.server.accept()
        self.control_server.settimeout(3)
        self.addCleanup(self.control_server.close)
        self.assertTrue(self.relay.ready.wait(3))

    def receive(self, sock, size):
        body = bytearray()
        while len(body) < size:
            chunk = sock.recv(size - len(body))
            self.assertTrue(chunk, 'unexpected EOF')
            body.extend(chunk)
        return bytes(body)

    def test_video_is_forwarded_byte_for_byte_without_application_queue(self):
        payload = bytes(range(256)) * 12288  # 3 MiB, including every byte value.
        errors = []
        def send():
            try:
                self.video_server.sendall(payload)
            except OSError as exc:
                errors.append(exc)
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
        self.assertEqual(self.receive(self.video_client, len(payload)), payload)
        sender.join(3)
        self.assertFalse(sender.is_alive())
        self.assertEqual(errors, [])
        self.assertGreater(self.relay.last_video_at, 0)
        self.assertFalse(self.relay.disconnected.is_set())

    def test_idle_static_video_is_not_treated_as_a_disconnect(self):
        self.assertFalse(self.relay.disconnected.wait(.05))
        self.assertTrue(self.relay.send(bytes((17,))))
        self.assertEqual(self.receive(self.control_server, 1), bytes((17,)))
        self.assertFalse(self.relay.disconnected.is_set())

    def test_video_eof_immediately_signals_monitor(self):
        self.video_server.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.disconnected.wait(3))
        self.assertIsNone(self.relay.error)
        self.assertEqual(self.relay.disconnect_reason, 'Video stream ended')

    def test_control_eof_is_recoverable_instead_of_fatal(self):
        self.control_server.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.disconnected.wait(3))
        self.assertIsNone(self.relay.error)

    def test_client_fin_is_forwarded_to_android_and_not_classified_as_network_loss(self):
        self.control_client.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.client_closed.wait(3))
        self.assertEqual(self.control_server.recv(1), b'')
        self.assertEqual(self.relay.end_origin, 'client')
        self.assertFalse(self.relay.disconnected.is_set())

    def test_remote_eof_followed_by_client_cleanup_preserves_remote_origin(self):
        self.video_server.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.disconnected.wait(3))
        self.control_client.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.client_closed.wait(3))
        self.assertEqual(self.relay.end_origin, 'remote')

    def test_client_close_followed_by_android_cleanup_preserves_client_origin(self):
        self.control_client.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.client_closed.wait(3))
        self.video_server.shutdown(socket.SHUT_WR)
        self.assertTrue(self.relay.disconnected.wait(3))
        self.assertEqual(self.relay.end_origin, 'client')

    def test_local_video_write_error_is_a_client_close_not_remote_loss(self):
        source, destination = Mock(), Mock()
        source.recv.return_value = b'frame'
        destination.sendall.side_effect = ConnectionResetError('local window closed')
        self.relay._pump(source, destination, True)
        self.assertTrue(self.relay.client_closed.is_set())
        self.assertFalse(self.relay.disconnected.is_set())
        self.assertEqual(self.relay.end_origin, 'client')

    def test_remote_video_read_error_is_a_recoverable_network_loss(self):
        source, destination = Mock(), Mock()
        source.recv.side_effect = ConnectionResetError('remote stream closed')
        self.relay._pump(source, destination, True)
        self.assertTrue(self.relay.disconnected.is_set())
        self.assertFalse(self.relay.client_closed.is_set())
        self.assertEqual(self.relay.end_origin, 'remote')

    def test_partial_clipboard_and_recovery_commands_never_interleave_bytes(self):
        clipboard = bytes([9]) + bytes(8) + bytes([0]) + (6).to_bytes(4, 'big') + b'secret'
        self.control_client.sendall(clipboard[:9])
        self.assertTrue(self.relay.reset_video())
        self.assertEqual(self.receive(self.control_server, 1), bytes((17,)))
        self.control_client.sendall(clipboard[9:])
        self.assertEqual(self.receive(self.control_server, len(clipboard)), clipboard)
        self.control_server.sendall(b'ack')
        self.assertEqual(self.receive(self.control_client, 3), b'ack')

    def test_malformed_control_packet_still_fails_explicitly(self):
        self.control_client.sendall(bytes((255,)))
        self.assertTrue(self.relay.protocol_error.wait(3))
        self.assertIn('Unsupported', self.relay.error)

    def test_intentional_close_releases_all_relay_threads(self):
        self.relay.close()
        self.assertTrue(self.relay.closed.is_set())
        self.assertTrue(all(not thread.is_alive() for thread in self.relay.threads))
        self.assertFalse(self.relay.disconnected.is_set())


if __name__ == '__main__':
    unittest.main(verbosity=2)
