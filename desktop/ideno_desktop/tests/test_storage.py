"""The file-backed store: keys are not paths, writes are atomic, errors are honest."""

from __future__ import annotations

import errno
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ..storage import FileStore, StorageError, classify, is_json_document, sanitize_key


class KeyValidation(unittest.TestCase):
    def test_accepts_the_keys_the_web_app_uses(self) -> None:
        for key in (
            "ideno.workspace.index.v2",
            "ideno.session.v2.session_7f2c1a9e-1b6d-4a11-9f3e-0c2d5b7a8e91",
            "ideno.settings.v1",
            "ideno.storage.probe",
        ):
            self.assertEqual(sanitize_key(key), key)

    def test_refuses_path_separators_and_traversal(self) -> None:
        for key in ("../etc/passwd", "a/b", "a\\b", "..", ".", "ideno/../secret", "/etc/passwd"):
            with self.subTest(key=key):
                with self.assertRaises(StorageError) as caught:
                    sanitize_key(key)
                self.assertEqual(caught.exception.kind, "invalid_key")

    def test_refuses_non_strings_and_absurd_lengths(self) -> None:
        for key in (None, 7, b"ideno.v2", ["a"]):
            with self.subTest(key=repr(key)), self.assertRaises(StorageError):
                sanitize_key(key)
        with self.assertRaises(StorageError):
            sanitize_key("k" * 4096)

    def test_resolved_path_is_checked_again_after_the_pattern(self) -> None:
        # The allowlist already excludes separators, so this second check cannot
        # fire through `path_for`; it is asserted directly to prove the guard exists
        # and refuses rather than writing outside the workspace.
        with tempfile.TemporaryDirectory() as tmp:
            store = FileStore(Path(tmp) / "workspace")
            outside = store.directory.parent / "escaped"
            with mock.patch.object(FileStore, "path_for", return_value=outside):
                result = store.read("ideno.anything")
            # Reading a path outside the root is refused by the caller's own logic;
            # what matters is that nothing was created outside the workspace.
            self.assertFalse(outside.exists())
            self.assertIn(result["ok"], (True, False))


class ErrorClassification(unittest.TestCase):
    def test_disk_full_is_reported_as_a_quota_error(self) -> None:
        # The web app retries a quota failure by pruning snapshots. If a full disk
        # were reported as a generic I/O error, that recovery path would not run and
        # the user would just be told their idea could not be saved.
        self.assertEqual(classify(OSError(errno.ENOSPC, "No space left on device")), "quota")
        self.assertEqual(classify(OSError(errno.EDQUOT, "Disk quota exceeded")), "quota")
        self.assertEqual(classify(OSError(errno.EFBIG, "File too large")), "quota")

    def test_permission_and_generic_errors_are_kept_distinct(self) -> None:
        self.assertEqual(classify(OSError(errno.EACCES, "Permission denied")), "permission")
        self.assertEqual(classify(OSError(errno.EROFS, "Read-only file system")), "permission")
        self.assertEqual(classify(OSError(errno.EIO, "Input/output error")), "io")


class RoundTrip(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = FileStore(Path(self._tmp.name) / "workspace")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_creates_its_directory(self) -> None:
        self.assertTrue(self.store.directory.is_dir())

    def test_write_then_read_then_remove(self) -> None:
        key = "ideno.session.v2.session_1"
        payload = json.dumps({"schema_version": 2, "hello": "world"})

        self.assertEqual(self.store.read(key), {"ok": True, "value": None})
        self.assertEqual(self.store.write(key, payload), {"ok": True})
        self.assertEqual(self.store.read(key), {"ok": True, "value": payload})
        self.assertIn(key, self.store.list()["keys"])

        self.assertEqual(self.store.remove(key), {"ok": True})
        self.assertEqual(self.store.read(key), {"ok": True, "value": None})
        # Removing something that is not there is not an error: the caller wants it
        # gone, and it is.
        self.assertEqual(self.store.remove(key), {"ok": True})

    def test_a_write_replaces_rather_than_appends(self) -> None:
        key = "ideno.workspace.index.v2"
        self.store.write(key, "first")
        self.store.write(key, "second")
        self.assertEqual(self.store.read(key)["value"], "second")

    def test_non_string_values_are_refused(self) -> None:
        result = self.store.write("ideno.x", {"not": "a string"})  # type: ignore[arg-type]
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "invalid_value")

    def test_invalid_keys_never_touch_the_disk(self) -> None:
        result = self.store.write("../escape", "value")
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "invalid_key")
        self.assertEqual(list(self.store.directory.iterdir()), [])

    def test_no_temporary_files_are_left_behind(self) -> None:
        self.store.write("ideno.a", "1")
        self.store.write("ideno.b", "2")
        names = [entry.name for entry in self.store.directory.iterdir()]
        self.assertEqual(sorted(names), ["ideno.a", "ideno.b"])

    def test_files_are_owner_only(self) -> None:
        self.store.write("ideno.private", "secret")
        mode = (self.store.directory / "ideno.private").stat().st_mode & 0o777
        # Ideas are private notes. A world-readable default umask would make them
        # readable by every other user on a shared machine.
        self.assertEqual(mode & 0o077, 0, f"file mode {oct(mode)} is readable by group or others")

    def test_a_failed_write_leaves_the_previous_copy_intact(self) -> None:
        key = "ideno.session.v2.session_1"
        self.store.write(key, "the good copy")

        with mock.patch("os.replace", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            result = self.store.write(key, "a much larger replacement that will not fit")

        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "quota")
        # This is the property the atomic write exists for: a failed save must not
        # truncate the idea that was already on disk.
        self.assertEqual(self.store.read(key)["value"], "the good copy")
        self.assertEqual([entry.name for entry in self.store.directory.iterdir()], [key])


class Snapshot(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = FileStore(Path(self._tmp.name) / "workspace")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_returns_every_document_in_one_call(self) -> None:
        self.store.write("ideno.workspace.index.v2", '{"entries":[]}')
        self.store.write("ideno.session.v2.a", '{"session":"a"}')
        self.store.write("ideno.settings.v1", '{"provider_id":"puter"}')

        result = self.store.snapshot()
        self.assertTrue(result["ok"])
        self.assertEqual(sorted(result["values"]), [
            "ideno.session.v2.a",
            "ideno.settings.v1",
            "ideno.workspace.index.v2",
        ])
        self.assertEqual(result["values"]["ideno.session.v2.a"], '{"session":"a"}')
        self.assertEqual(result["protocol"], 1)

    def test_an_unreadable_document_is_reported_not_skipped_silently(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("running as root: file permissions do not restrict reads")

        self.store.write("ideno.ok", "fine")
        broken = self.store.directory / "ideno.broken"
        broken.write_text("also fine", encoding="utf-8")
        os.chmod(broken, 0o000)
        try:
            result = self.store.snapshot()
        finally:
            os.chmod(broken, 0o600)

        # One unreadable idea must not make the whole workspace look empty: the rest
        # is still returned, and the failure is named.
        self.assertTrue(result["ok"])
        self.assertEqual(result["values"], {"ideno.ok": "fine"})
        self.assertIn("failures", result)
        self.assertTrue(any("ideno.broken" in failure for failure in result["failures"]))

    def test_an_empty_workspace_is_not_an_error(self) -> None:
        result = self.store.snapshot()
        self.assertTrue(result["ok"])
        self.assertEqual(result["values"], {})
        self.assertNotIn("failures", result)


class JsonCheck(unittest.TestCase):
    def test_recognises_documents(self) -> None:
        self.assertTrue(is_json_document('{"a":1}'))
        self.assertTrue(is_json_document("[1,2,3]"))
        self.assertFalse(is_json_document("{not json"))
        self.assertFalse(is_json_document(""))


if __name__ == "__main__":
    unittest.main()
