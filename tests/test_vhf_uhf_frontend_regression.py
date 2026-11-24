"""Regression coverage for support of tuner-based (non-zero-centred) front
ends - the VHF/UHF frequency-offset handling. This is easy to break silently
in a later refactor, because on a direct-sampling HF front end (where
Frontend.frequency is ~0) a regression is invisible.

Runs against fixtures captured live over the websocket from three real
receivers - a direct-sampling HF front end (RX888), a complex/IQ VHF one
(RTL-SDR) and a real-sampling UHF one (Airspy R2) - rather than synthetic
data, so the three front end classes are all covered. Recapture with
tests/capture_ws.py against your own receivers if the fixtures go stale.

Run: python3 -m unittest tests.test_vhf_uhf_frontend_regression -v
(from the repo root)
"""
import unittest
from pathlib import Path

from tests.decode_status import (
    FIELD_FE_HIGH_EDGE,
    FIELD_FE_ISREAL,
    FIELD_FE_LOW_EDGE,
    FIELD_FIRST_LO_FREQUENCY,
    all_channel_data_fields,
    as_bool,
    as_float32,
    as_float64,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _require(testcase, fields, field_id, band):
    testcase.assertIn(field_id, fields, f"field {field_id} missing from {band} capture")
    return fields[field_id]


class FrontendOffsetFieldsPresent(unittest.TestCase):
    """The core bug this commit fixes: FIRST_LO_FREQUENCY/FE_ISREAL/
    FE_LOW_EDGE/FE_HIGH_EDGE must be forwarded to the browser at all. Before
    this fix, none of these fields were ever encoded server-side."""

    def _fields(self, band):
        fixture = FIXTURES / f"{band}.bin"
        if not fixture.exists():
            self.skipTest(f"no fixture captured for {band} (run capture_ws.py first)")
        return all_channel_data_fields(fixture)

    def test_vhf_forwards_frontend_fields(self):
        fields = self._fields("vhf")
        for f in (FIELD_FIRST_LO_FREQUENCY, FIELD_FE_ISREAL, FIELD_FE_LOW_EDGE, FIELD_FE_HIGH_EDGE):
            self.assertIn(f, fields, f"field {f} missing from VHF capture")

    def test_uhf_forwards_frontend_fields(self):
        fields = self._fields("uhf")
        for f in (FIELD_FIRST_LO_FREQUENCY, FIELD_FE_ISREAL, FIELD_FE_LOW_EDGE, FIELD_FE_HIGH_EDGE):
            self.assertIn(f, fields, f"field {f} missing from UHF capture")


class VhfIsComplexIqAndCentredOnTune(unittest.TestCase):
    """VHF's RTL-SDR is a complex/IQ front end: FE_ISREAL must be false, and
    its real tuned centre must land in the 2m ham band (144-148 MHz) - not
    0 Hz, which was the pre-fix bug (silently assumed direct-sampling HF)."""

    def test_vhf_frontend_frequency_in_2m_band(self):
        fields = all_channel_data_fields(FIXTURES / "vhf.bin")
        freq_hz = as_float64(_require(self, fields, FIELD_FIRST_LO_FREQUENCY, "VHF"))
        self.assertGreater(freq_hz, 144_000_000)
        self.assertLess(freq_hz, 148_000_000)

    def test_vhf_isreal_false(self):
        fields = all_channel_data_fields(FIXTURES / "vhf.bin")
        self.assertFalse(as_bool(_require(self, fields, FIELD_FE_ISREAL, "VHF")))

    def test_vhf_if_window_roughly_symmetric(self):
        # Complex/IQ front end: window should straddle 0 (both signs present),
        # unlike a real-sampling front end where it sits entirely below 0.
        fields = all_channel_data_fields(FIXTURES / "vhf.bin")
        lo = as_float32(_require(self, fields, FIELD_FE_LOW_EDGE, "VHF"))
        hi = as_float32(_require(self, fields, FIELD_FE_HIGH_EDGE, "VHF"))
        self.assertLess(lo, 0)
        self.assertGreater(hi, 0)


class UhfIsRealSamplingAndAsymmetric(unittest.TestCase):
    """UHF's Airspy R2 is a real-sampling front end: FE_ISREAL must be true,
    and its IF window must be asymmetric (entirely below the tuned
    frequency, per src/airspy.c: max_IF=-600kHz, min_IF=-0.47*samprate).
    This is a distinct case from the complex/IQ one above - a fix that only
    handles a symmetric window still gets this front end wrong."""

    def test_uhf_frontend_frequency_in_70cm_band(self):
        fields = all_channel_data_fields(FIXTURES / "uhf.bin")
        freq_hz = as_float64(_require(self, fields, FIELD_FIRST_LO_FREQUENCY, "UHF"))
        self.assertGreater(freq_hz, 420_000_000)
        self.assertLess(freq_hz, 450_000_000)

    def test_uhf_isreal_true(self):
        fields = all_channel_data_fields(FIXTURES / "uhf.bin")
        self.assertTrue(as_bool(_require(self, fields, FIELD_FE_ISREAL, "UHF")))

    def test_uhf_if_window_entirely_negative(self):
        fields = all_channel_data_fields(FIXTURES / "uhf.bin")
        lo = as_float32(_require(self, fields, FIELD_FE_LOW_EDGE, "UHF"))
        hi = as_float32(_require(self, fields, FIELD_FE_HIGH_EDGE, "UHF"))
        self.assertLess(lo, 0)
        self.assertLess(hi, 0)
        self.assertLess(lo, hi)


class HfUnaffectedByTheFix(unittest.TestCase):
    """HF's RX888 is direct-sampling, so this work must be a no-op for it:
    FIRST_LO_FREQUENCY still reads ~0 Hz and HF's effective behaviour is
    unchanged."""

    def test_hf_frontend_frequency_near_zero(self):
        fields = all_channel_data_fields(FIXTURES / "hf.bin")
        freq_hz = as_float64(fields[FIELD_FIRST_LO_FREQUENCY]) if FIELD_FIRST_LO_FREQUENCY in fields else 0.0
        self.assertLess(abs(freq_hz), 1_000_000)  # well within one HF band's width of 0


class BandSelectorHas2mAnd70cm(unittest.TestCase):
    """Static check (no live capture needed): the quick-select band list in
    radio.js must carry the 2m/70cm entries, without which a tuner-based
    front end's bands are unreachable from the band buttons."""

    def test_band_options_include_2m_and_70cm(self):
        radio_js = (Path(__file__).parent.parent / "html" / "radio.js").read_text()
        self.assertIn('{ label: "2M", freq: 145500000 }', radio_js)
        self.assertIn('{ label: "70CM", freq: 433500000 }', radio_js)


if __name__ == "__main__":
    unittest.main()
