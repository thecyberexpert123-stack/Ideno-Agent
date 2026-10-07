"""Web-engine detection must be safe to run with no display and no engine."""

from __future__ import annotations

import unittest
from unittest import mock

from .. import backend


class Detection(unittest.TestCase):
    def test_module_presence_is_probed_without_importing(self) -> None:
        # Importing a GUI toolkit can abort the process when there is no display, so
        # detection has to use find_spec and never import.
        with mock.patch("importlib.util.find_spec", return_value=None) as probe:
            self.assertFalse(backend.module_present("PyQt6"))
        probe.assert_called_once_with("PyQt6")

        with mock.patch("importlib.util.find_spec", side_effect=ValueError("bad spec")):
            self.assertFalse(backend.module_present("PyQt6"))

    def test_a_missing_backend_names_what_to_install(self) -> None:
        with mock.patch.object(backend, "module_present", return_value=False):
            status = backend.check_backend("qt")
        self.assertFalse(status.available)
        self.assertIn("PyQt6", status.missing)
        self.assertIn("pywebview[qt]", status.install_hint)

    def test_modules_alone_are_not_enough_without_a_display(self) -> None:
        # The most confusing failure a desktop app can produce is a window that never
        # appears, so "no display" is detected and said out loud.
        with mock.patch.object(backend, "module_present", return_value=True), \
             mock.patch.object(backend, "_webkit_present", return_value=True), \
             mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(backend.have_display())
            self.assertFalse(backend.check_backend("qt").available)
            self.assertIn("display", backend.check_backend("qt").reason)

        with mock.patch.object(backend, "module_present", return_value=True), \
             mock.patch.object(backend, "_webkit_present", return_value=True), \
             mock.patch.dict("os.environ", {"DISPLAY": ":0"}, clear=True):
            self.assertTrue(backend.have_display())
            self.assertTrue(backend.check_backend("qt").available)

    def test_gtk_without_a_webkit_typelib_is_reported_as_a_half_installation(self) -> None:
        with mock.patch.object(backend, "module_present", return_value=True), \
             mock.patch.object(backend, "_webkit_present", return_value=False), \
             mock.patch.dict("os.environ", {"DISPLAY": ":0"}, clear=True):
            status = backend.check_backend("gtk")
        self.assertFalse(status.available)
        self.assertIn("WebKitGTK", status.reason)

    def test_an_unknown_backend_is_refused_rather_than_guessed(self) -> None:
        status = backend.check_backend("webkit2gtk")
        self.assertFalse(status.available)
        self.assertIn("not a backend", status.reason)


class Selection(unittest.TestCase):
    def test_auto_prefers_qt_then_gtk(self) -> None:
        ready = {"qt": True, "gtk": True}
        with mock.patch.object(backend, "check_backend",
                               side_effect=lambda name: backend.BackendStatus(
                                   name=name, available=ready[name], missing=(), install_hint="", reason="Ready.")):
            chosen, _ = backend.choose_backend("auto")
        self.assertEqual(chosen, "qt")

        ready["qt"] = False
        with mock.patch.object(backend, "check_backend",
                               side_effect=lambda name: backend.BackendStatus(
                                   name=name, available=ready[name], missing=(), install_hint="", reason="Ready.")):
            chosen, _ = backend.choose_backend("auto")
        self.assertEqual(chosen, "gtk")

    def test_an_explicit_request_is_not_silently_substituted(self) -> None:
        # The user asked for GTK. Quietly opening a Chromium window instead would be
        # answering a different question than the one asked.
        with mock.patch.object(backend, "check_backend",
                               side_effect=lambda name: backend.BackendStatus(
                                   name=name, available=(name == "qt"), missing=(), install_hint="hint", reason="r")):
            chosen, statuses = backend.choose_backend("gtk")
        self.assertIsNone(chosen)
        self.assertEqual(len(statuses), 2)

    def test_nothing_available_returns_none_and_the_reasons(self) -> None:
        with mock.patch.object(backend, "check_backend",
                               side_effect=lambda name: backend.BackendStatus(
                                   name=name, available=False, missing=("x",), install_hint="install x", reason="no x")):
            chosen, statuses = backend.choose_backend(None)
        self.assertIsNone(chosen)
        message = backend.explain_unavailable(statuses)
        self.assertIn("could not find a usable web engine", message)
        # The browser escape hatch must be in the message: it is the thing that makes
        # "no web engine here" not a dead end.
        self.assertIn("--browser", message)

    def test_available_backends_lists_only_ready_ones(self) -> None:
        with mock.patch.object(backend, "check_backend",
                               side_effect=lambda name: backend.BackendStatus(
                                   name=name, available=(name == "gtk"), missing=(), install_hint="", reason="r")):
            self.assertEqual(backend.available_backends(), ["gtk"])


class ImportSafety(unittest.TestCase):
    def test_importing_the_module_does_not_import_a_toolkit(self) -> None:
        for forbidden in ("PyQt6", "gi", "webview"):
            with self.subTest(module=forbidden):
                self.assertNotIn(forbidden, backend.__dict__)


if __name__ == "__main__":
    unittest.main()
