import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
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
        self.relay = Mock(error=None, forward_port=12345, port=12346)
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

    def test_monitor_restarts_alive_stale_window_after_same_address_recovery(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, False)
        old_proc, new_proc = Mock(), Mock()
        old_proc.poll.return_value = None
        new_proc.poll.return_value = 0
        with patch.object(m.subprocess, 'Popen', side_effect=[old_proc, new_proc]) as popen, \
             patch.object(c, 'recover_once', side_effect=[None, c.address]), \
             patch.object(m.time, 'sleep'):
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

    def test_monitor_stops_after_three_failed_restarts(self):
        c = self.target()
        monitor = m.Monitor(c, Path(self.temp.name) / 'scrcpy.exe', self.temp.name, False)
        proc = Mock()
        proc.poll.return_value = 1
        with patch.object(m.subprocess, 'Popen', return_value=proc) as popen, \
             patch.object(c, 'recover_once', return_value=c.address), \
             patch.object(m.time, 'sleep'), self.assertRaises(m.MirrorError):
            monitor.run()
        self.assertEqual(popen.call_count, 4)

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

    def test_fast_profile_halves_configured_bitrate_without_added_video_buffer(self):
        fast = m.StreamSettings()
        balanced = m.StreamSettings('balanced')
        self.assertEqual((fast.max_size, fast.bit_rate, fast.max_fps), (960, '4M', 60))
        self.assertEqual((balanced.max_size, balanced.bit_rate), (1080, '8M'))
        self.assertIn('--video-codec=h264', fast.video_args())
        self.assertIn('--video-buffer=0', fast.video_args())
        self.assertIn('--hwdec=auto', fast.video_args())
        self.assertNotIn('--print-fps', fast.video_args())

    def test_weak_network_and_custom_settings_survive_spawn(self):
        c = self.target()
        settings = m.StreamSettings('weak-wifi', max_size=800, bit_rate='3m', max_fps=45,
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
                   dict(encoder='--record=x'), dict(hwdec='unrecognized'), dict(profile='unknown')]
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


if __name__ == '__main__':
    unittest.main(verbosity=2)
