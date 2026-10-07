"""Locating and building the web bundle."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ..build import BuildError, build_web_app, locate_dist, repo_root, start_dev_server

MANIFEST = '{\n  "name": "ideno",\n  "private": true\n}\n'


class FakeRoot(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "package.json").write_text(MANIFEST, encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def make_dist(self) -> Path:
        dist = self.root / "dist"
        (dist / "assets").mkdir(parents=True)
        (dist / "index.html").write_text("<!doctype html>", encoding="utf-8")
        return dist


class RepoRoot(FakeRoot):
    def test_found_from_a_nested_directory(self) -> None:
        nested = self.root / "desktop" / "ideno_desktop"
        nested.mkdir(parents=True)
        self.assertEqual(repo_root(nested / "build.py"), self.root.resolve())

    def test_a_package_json_for_another_project_is_not_the_root(self) -> None:
        (self.root / "package.json").write_text('{"name": "something-else"}', encoding="utf-8")
        with self.assertRaises(BuildError):
            repo_root(self.root)

    def test_the_real_repository_is_found(self) -> None:
        found = repo_root()
        self.assertTrue((found / "package.json").is_file())
        self.assertTrue((found / "src" / "main.ts").is_file())


class Locate(FakeRoot):
    def test_a_missing_bundle_comes_with_instructions(self) -> None:
        with self.assertRaises(BuildError) as caught:
            locate_dist(self.root)
        message = str(caught.exception)
        # The message has to say what to do, not just what is wrong: the person
        # reading it has a window that did not open and no other information.
        self.assertIn("npm run build", message)
        self.assertIn("--dev", message)
        self.assertIn(str(self.root / "dist" / "index.html"), message)

    def test_a_built_bundle_is_found(self) -> None:
        self.make_dist()
        app = locate_dist(self.root)
        self.assertEqual(app.root, self.root / "dist")
        self.assertTrue(app.index.is_file())
        self.assertFalse(app.dev)


class Build(FakeRoot):
    def test_it_installs_dependencies_when_they_are_missing(self) -> None:
        self.make_dist()
        calls: list[list[str]] = []

        def fake_run(command, **kwargs):
            calls.append(list(command))
            return subprocess.CompletedProcess(command, 0, "", "")

        with mock.patch("shutil.which", return_value="/usr/bin/npm"), \
             mock.patch("subprocess.run", side_effect=fake_run):
            build_web_app(self.root)

        self.assertEqual([call[-1] for call in calls], ["ci", "build"])

    def test_it_skips_the_install_when_node_modules_exists(self) -> None:
        self.make_dist()
        (self.root / "node_modules").mkdir()
        calls: list[list[str]] = []

        with mock.patch("shutil.which", return_value="/usr/bin/npm"), \
             mock.patch("subprocess.run", side_effect=lambda command, **kw: calls.append(list(command))
                        or subprocess.CompletedProcess(command, 0, "", "")):
            build_web_app(self.root)

        self.assertEqual([call[-1] for call in calls], ["build"])

    def test_a_failing_build_reports_the_tail_of_the_output(self) -> None:
        with mock.patch("shutil.which", return_value="/usr/bin/npm"), \
             mock.patch("subprocess.run", return_value=subprocess.CompletedProcess(
                 ["npm"], 1, "", "line1\nline2\nerror: tsc found 3 problems")):
            with self.assertRaises(BuildError) as caught:
                build_web_app(self.root)
        self.assertIn("tsc found 3 problems", str(caught.exception))
        self.assertIn("exit 1", str(caught.exception))

    def test_a_missing_npm_is_an_actionable_error(self) -> None:
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaises(BuildError) as caught:
                build_web_app(self.root)
        self.assertIn("npm was not found", str(caught.exception))
        self.assertIn("Node.js", str(caught.exception))

    def test_a_hung_build_does_not_hang_ideno(self) -> None:
        with mock.patch("shutil.which", return_value="/usr/bin/npm"), \
             mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired(["npm"], 1)):
            with self.assertRaises(BuildError) as caught:
                build_web_app(self.root, timeout=1)
        self.assertIn("did not finish", str(caught.exception))


class DevServer(FakeRoot):
    def test_it_is_started_on_loopback_with_a_strict_port(self) -> None:
        with mock.patch("shutil.which", return_value="/usr/bin/npm"), \
             mock.patch("subprocess.Popen") as popen:
            start_dev_server(self.root, 5199)
        command = popen.call_args.args[0]
        # --strictPort: silently picking a different port would leave the window
        # pointing at whatever else answers on the one we announced.
        self.assertIn("--strictPort", command)
        self.assertIn("127.0.0.1", command)
        self.assertIn("5199", command)
        self.assertEqual(popen.call_args.kwargs["cwd"], str(self.root))

    def test_a_missing_npm_is_reported(self) -> None:
        with mock.patch("shutil.which", return_value=None):
            with self.assertRaises(BuildError):
                start_dev_server(self.root, 5199)


if __name__ == "__main__":
    unittest.main()
