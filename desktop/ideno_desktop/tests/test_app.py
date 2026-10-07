"""Orchestration. Verified on a machine with no display and no web engine."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ..app import StartupError, _no_backend_message, check_report, resolve_web_app, run
from ..backend import BackendStatus
from ..build import BuildError, WebApp
from ..cli import parse_args


def status(name: str, available: bool, reason: str = "reason") -> BackendStatus:
    return BackendStatus(
        name=name, available=available, missing=(), install_hint=f"install {name}", reason=reason
    )


class CheckReport(unittest.TestCase):
    def test_it_runs_headless_and_covers_everything_a_person_must_decide_from(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = check_report(Path(tmp))
        for expected in ("Python", "Web engine", "pywebview installed", "qt", "gtk",
                         "Web app", "npm", "Data", "workspace_dir", "Modes", "--browser", "--dev"):
            with self.subTest(section=expected):
                self.assertIn(expected, report)

    def test_it_reports_a_missing_bundle_rather_than_failing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch("ideno_desktop.app.repo_root", side_effect=BuildError("no repository here")):
                report = check_report(Path(tmp))
        self.assertIn("not found", report)

    def test_check_exits_zero_through_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            options = parse_args(["--check", "--data-dir", tmp])
            self.assertEqual(run(options), 0)


class ResolveWebApp(unittest.TestCase):
    def test_a_missing_bundle_becomes_a_startup_error_with_instructions(self) -> None:
        with mock.patch("ideno_desktop.app.repo_root", side_effect=BuildError("no repository")):
            with self.assertRaises(StartupError) as caught:
                resolve_web_app(parse_args([]))
        self.assertIn("no repository", str(caught.exception))

    def test_dev_mode_waits_for_the_server_and_reports_its_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with mock.patch("ideno_desktop.app.repo_root", return_value=root), \
                 mock.patch("ideno_desktop.app.port_is_free", return_value=True), \
                 mock.patch("ideno_desktop.app.start_dev_server") as start, \
                 mock.patch("ideno_desktop.app._wait_for_dev_server"):
                app, process = resolve_web_app(parse_args(["--dev", "--port", "5199"]))
        self.assertTrue(app.dev)
        self.assertEqual(app.url, "http://127.0.0.1:5199/")
        start.assert_called_once_with(root, 5199)
        self.assertIs(process, start.return_value)

    def test_a_busy_dev_port_is_refused_before_starting_anything(self) -> None:
        with mock.patch("ideno_desktop.app.repo_root", return_value=Path("/tmp")), \
             mock.patch("ideno_desktop.app.port_is_free", return_value=False), \
             mock.patch("ideno_desktop.app.start_dev_server") as start:
            with self.assertRaises(StartupError) as caught:
                resolve_web_app(parse_args(["--dev", "--port", "5199"]))
        self.assertIn("already in use", str(caught.exception))
        start.assert_not_called()

    def test_a_dev_server_that_never_listens_is_reported_and_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            process = mock.Mock()
            with mock.patch("ideno_desktop.app.repo_root", return_value=Path(tmp)), \
                 mock.patch("ideno_desktop.app.port_is_free", return_value=True), \
                 mock.patch("ideno_desktop.app.start_dev_server", return_value=process), \
                 mock.patch("ideno_desktop.app._wait_for_dev_server", side_effect=StartupError("never came up")):
                with self.assertRaises(StartupError):
                    resolve_web_app(parse_args(["--dev"]))
        process.terminate.assert_called_once()


class BackendMessages(unittest.TestCase):
    def test_an_explicit_engine_that_is_unusable_is_named(self) -> None:
        message = _no_backend_message("gtk", [status("qt", True), status("gtk", False, "no WebKitGTK typelib")])
        self.assertIn("gtk", message)
        self.assertIn("no WebKitGTK typelib", message)
        self.assertIn("--browser", message)

    def test_auto_falls_back_to_the_general_explanation(self) -> None:
        message = _no_backend_message("auto", [status("qt", False), status("gtk", False)])
        self.assertIn("could not find a usable web engine", message)
        self.assertIn("--browser", message)


class WindowStartup(unittest.TestCase):
    def test_without_pywebview_the_failure_names_the_install_command(self) -> None:
        # This machine has no web engine, which is exactly the situation the message
        # exists for: it must name a package to install and offer the browser path.
        from ..app import _run_in_window

        app = WebApp(root=Path("/tmp"), index=Path("/tmp/index.html"))
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch("ideno_desktop.app.pywebview_installed", return_value=False):
            with self.assertRaises(StartupError) as caught:
                _run_in_window(app, parse_args([]), Path(tmp))
        message = str(caught.exception)
        self.assertIn("pywebview is not installed", message)
        self.assertIn('pip install "pywebview[qt]"', message)
        self.assertIn("--browser", message)

    def test_with_pywebview_but_no_engine_it_still_explains_instead_of_crashing(self) -> None:
        from ..app import _run_in_window

        app = WebApp(root=Path("/tmp"), index=Path("/tmp/index.html"))
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch("ideno_desktop.app.pywebview_installed", return_value=True), \
             mock.patch("ideno_desktop.app.choose_backend",
                        return_value=(None, [status("qt", False, "no PyQt6"), status("gtk", False, "no gi")])):
            with self.assertRaises(StartupError) as caught:
                _run_in_window(app, parse_args([]), Path(tmp))
        self.assertIn("no PyQt6", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
