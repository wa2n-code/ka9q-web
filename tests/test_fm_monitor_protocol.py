"""Static integration tests for the KA9Q FM Monitor wire protocol.

The live radiod / WebSocket path is tested separately on the receiver host.
"""
import math
import pathlib
import struct
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class MonitorProtocolTests(unittest.TestCase):
    def test_finite_minus_500_db_underflows_to_zero_float(self):
        db = -500.0
        power = 10.0 ** (db / 10.0)
        self.assertTrue(math.isfinite(db))
        self.assertEqual(struct.unpack("f", struct.pack("f", power))[0], 0.0)

    def test_normal_open_threshold_allows_negative_db_to_minus_30(self):
        server = (ROOT / "ka9q-web.c").read_text()
        html = (ROOT / "html" / "radio.html").read_text()
        self.assertIn('open_db < -30 || open_db > 40', server)
        self.assertIn('id="fmSqOpen" type="number" min="-30"', html)

    def test_monitor_command_accepts_websocket_sequence(self):
        server = (ROOT / "ka9q-web.c").read_text()
        self.assertIn('strcasecmp(open_text, "MONITOR") == 0', server)
        self.assertIn('control_set_squelch(sp, -500.0f, -500.0f)', server)
        self.assertIn('encode_int(&bp, OUTPUT_SSRC, sp->ssrc)', server)

    def test_internal_zero_is_forwarded_as_finite_monitor_marker(self):
        server = (ROOT / "ka9q-web.c").read_text()
        self.assertIn('Channel.squelch.open == 0 ? -500.0f', server)
        self.assertIn('Channel.squelch.close == 0 ? -500.0f', server)


if __name__ == "__main__":
    unittest.main()
