"""Loopback relay for the pinned scrcpy 5.0.1 video/control protocol.

Video and clipboard bytes pass through in memory and are never saved or logged.
Control packets are framed before forwarding so recovery commands cannot split
an in-flight mouse, keyboard or clipboard message.
"""
import socket
import threading
import time


def packet_size(data):
    if not data:
        return None
    kind = data[0]
    fixed = {0: 14, 2: 32, 3: 21, 4: 2, 5: 1, 6: 1, 7: 1, 8: 2,
             10: 2, 11: 1, 14: 3, 15: 1, 17: 1, 18: 2, 19: 1, 20: 1, 21: 5}
    if kind in fixed:
        size = fixed[kind]
    elif kind in (1, 22):
        if len(data) < 5:
            return None
        size = 5 + int.from_bytes(data[1:5], 'big')
    elif kind == 9:
        if len(data) < 14:
            return None
        size = 14 + int.from_bytes(data[10:14], 'big')
    elif kind == 12:
        if len(data) < 8:
            return None
        index = 8 + data[7]
        if len(data) < index + 2:
            return None
        size = index + 2 + int.from_bytes(data[index:index + 2], 'big')
    elif kind == 13:
        if len(data) < 5:
            return None
        size = 5 + int.from_bytes(data[3:5], 'big')
    elif kind == 16:
        if len(data) < 2:
            return None
        size = 2 + data[1]
    else:
        raise ValueError(f'Unsupported scrcpy control message: {kind}')
    if size > 1_048_576:
        raise ValueError('Oversized scrcpy control message')
    return size if len(data) >= size else None


class ControlRelay:
    def __init__(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            self.forward_port = reservation.getsockname()[1]
        self.listener = socket.socket()
        self.listener.bind(('127.0.0.1', 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen(4)
        self.listener.settimeout(0.5)
        self.closed = threading.Event()
        self.ready = threading.Event()
        self.disconnected = threading.Event()
        self.client_closed = threading.Event()
        self.client_closed_at = 0.0
        self.end_origin = None
        self.disconnect_reason = None
        self.protocol_error = threading.Event()
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.control = None
        self.sockets = []
        self.threads = []
        self.error = None
        self.video_bytes = 0
        self.last_video_at = 0.0
        self._thread(self._accept)

    def _thread(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True, name='scrcpy-relay-' + target.__name__)
        with self.lifecycle_lock:
            if not self.closed.is_set():
                self.threads.append(thread)
                thread.start()

    def _socket(self, sock):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        with self.lifecycle_lock:
            if self.closed.is_set():
                sock.close()
                raise OSError('Relay closed')
            self.sockets.append(sock)
        return sock

    def _lost(self, reason):
        with self.lifecycle_lock:
            if not self.closed.is_set():
                if self.end_origin is None:
                    self.end_origin = 'remote'
                self.disconnect_reason = self.disconnect_reason or reason
                self.disconnected.set()

    def _client_ended(self):
        with self.lifecycle_lock:
            if not self.closed.is_set():
                if self.end_origin is None:
                    self.end_origin = 'client'
                if not self.client_closed.is_set():
                    self.client_closed_at = time.monotonic()
                self.client_closed.set()

    def _accept(self):
        video = True
        try:
            while not self.closed.is_set():
                try:
                    client, _ = self.listener.accept()
                except socket.timeout:
                    continue
                client = self._socket(client)
                backend = None
                try:
                    backend = self._socket(socket.create_connection(('127.0.0.1', self.forward_port), timeout=3))
                    if video:
                        # The server's dummy byte is the protocol readiness check.
                        first = backend.recv(1)
                        if not first:
                            raise ConnectionError('ADB tunnel not ready')
                        client.sendall(first)
                    backend.settimeout(None)
                except OSError:
                    client.close()
                    if backend is not None:
                        backend.close()
                    # scrcpy probes before Android finishes starting. Refused
                    # connections/empty dummy bytes are normal at this stage.
                    # Monitor bounds the initial handshake with its deadline.
                    if not video:
                        self._lost('ADB control tunnel connection failed')
                    continue
                if video:
                    self._thread(self._pump, backend, client, True)
                    video = False
                else:
                    self.control = backend
                    self.ready.set()
                    self._thread(self._pump, backend, client, False)
                    self._thread(self._client_control, client)
                    return
        except OSError as exc:
            if not self.closed.is_set():
                self._lost('Local relay listener failed')
        finally:
            self.listener.close()

    def _pump(self, source, destination, video):
        stage = 'read'
        try:
            while not self.closed.is_set():
                stage = 'read'
                data = source.recv(65536)
                if not data:
                    self._lost('Video stream ended' if video else 'Control stream ended')
                    break
                stage = 'write'
                destination.sendall(data)
                if video:
                    self.video_bytes += len(data)
                    self.last_video_at = time.monotonic()
        except OSError:
            if stage == 'read':
                self._lost('Video transport failed' if video else 'Control transport failed')
            else:
                # The local consumer closing its socket is not a Wi-Fi loss.
                self._client_ended()
        finally:
            try:
                destination.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def _client_control(self, client):
        buffer = bytearray()
        try:
            while not self.closed.is_set():
                data = client.recv(65536)
                if not data:
                    self._client_ended()
                    break
                buffer.extend(data)
                while (size := packet_size(buffer)) is not None:
                    packet = bytes(buffer[:size])
                    del buffer[:size]
                    if not self.send(packet):
                        return
        except ValueError as exc:
            if not self.closed.is_set():
                self.error = str(exc)
                self.protocol_error.set()
        except OSError:
            self._client_ended()
        finally:
            # Forward the client's FIN. Otherwise Android may keep the control
            # session alive while scrcpy is waiting for exit cleanup to finish.
            try:
                self.control.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def send(self, packet):
        if not self.ready.is_set() or self.closed.is_set():
            return False
        try:
            with self.lock:
                self.control.sendall(packet)
            return True
        except OSError:
            self._lost('Control send failed')
            return False

    def set_power(self, on):
        return self.send(bytes((10, int(on))))

    def reset_video(self):
        return self.send(bytes((17,)))

    def dark_and_reset(self):
        return self.send(bytes((10, 0, 17)))

    def wake_dark_reset(self):
        # Controller schedules another panel-off after WAKEUP key-up. This
        # avoids Android's asynchronous wake transition turning the panel on
        # again after an immediate SurfaceControl power-off.
        down = bytes((0, 0)) + (224).to_bytes(4, 'big') + bytes(8)
        up = bytes((0, 1)) + (224).to_bytes(4, 'big') + bytes(8)
        return self.send(bytes((10, 0)) + down + up + bytes((17,)))

    def wake_light_reset(self):
        down = bytes((0, 0)) + (224).to_bytes(4, 'big') + bytes(8)
        up = bytes((0, 1)) + (224).to_bytes(4, 'big') + bytes(8)
        return self.send(bytes((10, 1)) + down + up + bytes((17,)))

    def close(self):
        self.closed.set()
        self.listener.close()
        with self.lifecycle_lock:
            sockets, threads = list(self.sockets), list(self.threads)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(timeout=0.5)
