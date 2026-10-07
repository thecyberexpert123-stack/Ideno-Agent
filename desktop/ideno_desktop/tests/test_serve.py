"""The loopback server: real sockets, real requests, no display needed."""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from ..serve import LOOPBACK, port_is_free, serve


class StaticServing(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "index.html").write_text("<!doctype html><title>Ideno</title>", encoding="utf-8")
        assets = self.root / "assets"
        assets.mkdir()
        (assets / "app-abc123.js").write_text("export const a = 1;", encoding="utf-8")
        (assets / "app-abc123.css").write_text("body{}", encoding="utf-8")
        (assets / "data.json").write_text(json.dumps({"ok": True}), encoding="utf-8")
        self.server = serve(self.root)

    def tearDown(self) -> None:
        self.server.shutdown()
        self._tmp.cleanup()

    def get(self, path: str):
        return urllib.request.urlopen(f"{self.server.url.rstrip('/')}{path}", timeout=5)  # noqa: S310

    def test_it_binds_loopback_only(self) -> None:
        # The single most important property of this server: it must not be reachable
        # from another machine.
        self.assertIn(f"//{LOOPBACK}:", self.server.url)
        self.assertNotIn("0.0.0.0", self.server.url)

    def test_serves_the_entry_point_as_html(self) -> None:
        with self.get("/index.html") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("text/html", response.headers["Content-Type"])
            self.assertIn("Ideno", response.read().decode("utf-8"))

    def test_serves_javascript_with_a_module_mime_type(self) -> None:
        # A module bundle served as text/plain is refused by every engine, and the
        # symptom is a blank window with no obvious cause.
        with self.get("/assets/app-abc123.js") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("text/javascript", response.headers["Content-Type"])
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_serves_css_and_json(self) -> None:
        with self.get("/assets/app-abc123.css") as response:
            self.assertIn("text/css", response.headers["Content-Type"])
        with self.get("/assets/data.json") as response:
            self.assertIn("application/json", response.headers["Content-Type"])
            self.assertTrue(json.loads(response.read())["ok"])

    def test_hashed_assets_are_cacheable_and_the_entry_point_is_not(self) -> None:
        with self.get("/assets/app-abc123.js") as response:
            self.assertIn("immutable", response.headers["Cache-Control"])
        with self.get("/index.html") as response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_a_missing_file_is_a_404_not_a_hang(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/assets/nope.js")
        self.assertEqual(caught.exception.code, 404)

    def test_path_traversal_cannot_escape_the_served_directory(self) -> None:
        secret = self.root.parent / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        try:
            for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"):
                with self.subTest(path=path):
                    try:
                        with self.get(path) as response:
                            self.assertNotIn("private", response.read().decode("utf-8"))
                    except urllib.error.HTTPError as error:
                        self.assertIn(error.code, (400, 404))
        finally:
            secret.unlink(missing_ok=True)

    def test_writing_methods_are_refused(self) -> None:
        request = urllib.request.Request(self.server.url, data=b"x", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)  # noqa: S310
        self.assertEqual(caught.exception.code, 501)

    def test_head_is_allowed_and_has_no_body(self) -> None:
        request = urllib.request.Request(f"{self.server.url}index.html", method="HEAD")
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")

    def test_an_arbitrary_port_is_chosen_and_it_is_then_busy(self) -> None:
        self.assertGreater(self.server.port, 0)
        self.assertFalse(port_is_free(self.server.port))


class Guards(unittest.TestCase):
    def test_serving_a_directory_that_does_not_exist_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(NotADirectoryError):
                serve(Path(tmp) / "dist")


if __name__ == "__main__":
    unittest.main()
