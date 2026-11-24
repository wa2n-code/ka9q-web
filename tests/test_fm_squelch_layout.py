"""Keep FM squelch layout separate from the receiver's control table."""
import pathlib
import unittest

HTML = (pathlib.Path(__file__).resolve().parents[1] / "html" / "radio.html").read_text()


class FmSquelchLayoutTests(unittest.TestCase):
    def test_squelch_is_below_analogue_s_meter(self):
        meter = HTML.index('id="analog_smeter_box"')
        squelch = HTML.index('id="fmSquelchControls"')
        stats = HTML.index('id="stat_div"')
        table_end = HTML.rfind("</table>", 0, meter)
        self.assertLess(table_end, meter)
        self.assertLess(meter, squelch)
        self.assertLess(squelch, stats)

    def test_mode_row_does_not_contain_squelch(self):
        mode_start = HTML.index('<select name="mode"')
        filter_edges = HTML.index("<!-- Filter edge controls:")
        self.assertNotIn('id="fmSquelchControls"', HTML[mode_start:filter_edges])
        self.assertIn("grid-template-columns:repeat(3,minmax(0,1fr))", HTML)

    def test_all_original_squelch_ids_exist_once(self):
        for control_id in (
            "fmSquelchControls", "fmSqOpen", "fmSqClose",
            "fmSqHysteresis", "fmSqMonitor", "fmSqApply", "fmSqStatus",
        ):
            with self.subTest(control_id=control_id):
                self.assertEqual(HTML.count('id="' + control_id + '"'), 1)


if __name__ == "__main__":
    unittest.main()
