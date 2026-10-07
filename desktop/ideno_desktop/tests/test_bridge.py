"""The JS bridge: nothing raises across it, and every answer has an `ok` flag."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ..bridge import IdenoApi
from ..storage import FileStore, StorageError


class Bridge(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = FileStore(Path(self._tmp.name) / "workspace")
        self.api = IdenoApi(self.store, "0.2.0")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_info_identifies_the_host_and_protocol(self) -> None:
        info = self.api.info()
        self.assertTrue(info["ok"])
        self.assertEqual(info["protocol"], 1)
        self.assertEqual(info["version"], "0.2.0")
        self.assertEqual(info["kind"], "desktop-file")
        self.assertIn("python", info)
        self.assertIn("platform", info)

    def test_write_read_remove_round_trip_through_the_bridge(self) -> None:
        self.assertTrue(self.api.write("ideno.settings.v1", '{"a":1}')["ok"])
        self.assertEqual(self.api.read("ideno.settings.v1")["value"], '{"a":1}')
        self.assertIn("ideno.settings.v1", self.api.list()["keys"])
        self.assertTrue(self.api.remove("ideno.settings.v1")["ok"])
        self.assertIsNone(self.api.read("ideno.settings.v1")["value"])

    def test_a_bad_key_is_an_error_result_not_an_exception(self) -> None:
        # An exception crossing into a web engine becomes a rejection whose shape
        # depends on the backend. The web app cannot be written against that.
        for method in (self.api.read, self.api.remove):
            result = method("../escape")
            self.assertFalse(result["ok"])
            self.assertEqual(result["kind"], "invalid_key")
        result = self.api.write("../escape", "x")
        self.assertFalse(result["ok"])

    def test_an_unexpected_failure_is_contained_and_logged(self) -> None:
        with mock.patch.object(FileStore, "list", side_effect=RuntimeError("something broke")):
            result = self.api.list()
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "internal")
        self.assertIn("something broke", str(result["error"]))

    def test_a_storage_error_keeps_its_kind(self) -> None:
        with mock.patch.object(FileStore, "snapshot", side_effect=StorageError("disk full", kind="quota")):
            result = self.api.snapshot()
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "quota")

    def test_snapshot_reports_the_data_directory(self) -> None:
        self.api.write("ideno.a", "1")
        result = self.api.snapshot()
        self.assertTrue(result["ok"])
        self.assertEqual(result["values"], {"ideno.a": "1"})
        self.assertEqual(Path(str(result["workspace_dir"])), self.store.directory)

    def test_every_result_is_json_serialisable(self) -> None:
        import json

        for result in (self.api.info(), self.api.snapshot(), self.api.list(), self.api.data_dir()):
            json.dumps(result)


if __name__ == "__main__":
    unittest.main()
