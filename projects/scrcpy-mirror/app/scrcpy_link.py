"""Loopback relay for the pinned scrcpy 5.0.1 video/control protocol.

Video and clipboard bytes pass through in memory and are never saved or logged.
Control packets are framed before forwarding so recovery commands cannot split
an in-flight mouse, keyboard or clipboard message.
"""
import socket
import threading


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
        self.lock = threading.Lock()
        self.control = None
        self.sockets = []
        self.threads = []
        self.error = None
        self.video_bytes = 0
        self._thread(self._accept)

    def _thread(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        self.threads.append(thread)
        thread.start()

    def _socket(self, sock):
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sockets.append(sock)
        return sock

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
                self.error = str(exc)
        finally:
            self.listener.close()

    def _pump(self, source, destination, video):
        try:
            while not self.closed.is_set():
                data = source.recv(65536)
                if not data:
                    break
                destination.sendall(data)
                if video:
                    self.video_bytes += len(data)
        except OSError:
            pass
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
                    break
                buffer.extend(data)
                while (size := packet_size(buffer)) is not None:
                    packet = bytes(buffer[:size])
                    del buffer[:size]
                    if not self.send(packet):
                        return
        except (OSError, ValueError) as exc:
            if not self.closed.is_set():
                self.error = str(exc)

    def send(self, packet):
        if not self.ready.is_set() or self.closed.is_set():
            return False
        try:
            with self.lock:
                self.control.sendall(packet)
            return True
        except OSError:
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
        for sock in self.sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        for thread in self.threads:
            if thread is not threading.current_thread():
                thread.join(timeout=0.5)
