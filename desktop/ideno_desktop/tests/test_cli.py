"""Argument parsing, which has to be testable without a display."""

from __future__ import annotations

import unittest
from pathlib import Path

from ..cli import parse_args


class Defaults(unittest.TestCase):
    def test_defaults_are_a_window_on_an_arbitrary_port(self) -> None:
        options = parse_args([])
        self.assertEqual(options.gui, "auto")
        self.assertFalse(options.browser)
        self.assertFalse(options.dev)
        self.assertFalse(options.build)
        self.assertEqual(options.port, 0)
        self.assertEqual((options.width, options.height), (1440, 900))
        self.assertIsNone(options.data_dir)

    def test_a_data_dir_is_expanded(self) -> None:
        options = parse_args(["--data-dir", "~/ideno-data"])
        self.assertEqual(options.data_dir, Path.home() / "ideno-data")


class Validation(unittest.TestCase):
    def test_an_absurd_window_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            parse_args(["--width", "10"])

    def test_an_impossible_port_is_refused(self) -> None:
        for port in ("-1", "70000"):
            with self.subTest(port=port), self.assertRaises(SystemExit):
                parse_args(["--port", port])

    def test_a_non_numeric_port_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            parse_args(["--port", "http"])

    def test_browser_and_gui_are_mutually_exclusive(self) -> None:
        # `--browser --gui qt` asks for two contradictory things. Exiting with a
        # sentence beats picking one and letting the user wonder which.
        with self.assertRaises(SystemExit):
            parse_args(["--browser", "--gui", "qt"])
        self.assertTrue(parse_args(["--browser"]).browser)

    def test_an_unknown_engine_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            parse_args(["--gui", "webkit2gtk"])

    def test_flags_combine(self) -> None:
        options = parse_args(["--dev", "--debug", "--gui", "gtk", "--width", "1200", "--height", "800"])
        self.assertTrue(options.dev)
        self.assertTrue(options.debug)
        self.assertEqual(options.gui, "gtk")
        self.assertEqual((options.width, options.height), (1200, 800))

    def test_help_exits_zero_and_mentions_the_modes(self) -> None:
        import contextlib
        import io

        out = io.StringIO()
        with self.assertRaises(SystemExit) as caught, contextlib.redirect_stdout(out):
            parse_args(["--help"])
        self.assertEqual(caught.exception.code, 0)
        text = out.getvalue()
        for expected in ("--browser", "--dev", "--build", "--check", "--data-dir"):
            self.assertIn(expected, text)


if __name__ == "__main__":
    unittest.main()
