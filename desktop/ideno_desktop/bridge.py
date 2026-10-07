"""The object pywebview exposes to the page as ``window.pywebview.api``.

Every public method returns a JSON-serialisable dict with an ``ok`` flag. Nothing
raises across the bridge: an exception that crosses into the web engine becomes a
JavaScript rejection whose shape depends on the backend, so errors are converted
here into something the web app can rely on.

The surface is deliberately tiny — info, snapshot, read, write, remove, list — and
every one of those takes a *key*, never a path. A bridge that accepted paths would
be a file-system proxy for whatever ends up running in the page.
"""

from __future__ import annotations

import logging
import platform
import sys
from pathlib import Path

from .storage import PROTOCOL_VERSION, FileStore, StorageError

logger = logging.getLogger("ideno.bridge")


class IdenoApi:
    """Bridge methods callable from JavaScript."""

    def __init__(self, store: FileStore, version: str) -> None:
        self._store = store
        self._version = version

    # -- identity -----------------------------------------------------------

    def info(self) -> dict[str, object]:
        """Who is on the other end. Called first by the web app."""
        try:
            payload = self._store.info()
        except StorageError as error:
            return error.as_result()
        payload.update(
            {
                "version": self._version,
                "python": sys.version.split()[0],
                "platform": platform.system(),
            }
        )
        return payload

    # -- storage ------------------------------------------------------------

    def snapshot(self) -> dict[str, object]:
        return self._guard(self._store.snapshot)

    def read(self, key: str) -> dict[str, object]:
        return self._guard(self._store.read, key)

    def write(self, key: str, value: str) -> dict[str, object]:
        return self._guard(self._store.write, key, value)

    def remove(self, key: str) -> dict[str, object]:
        return self._guard(self._store.remove, key)

    def list(self) -> dict[str, object]:
        return self._guard(self._store.list)

    # -- housekeeping -------------------------------------------------------

    def data_dir(self) -> dict[str, object]:
        return {"ok": True, "path": str(Path(self._store.directory).resolve())}

    def _guard(self, call, *args: object) -> dict[str, object]:
        try:
            return call(*args)
        except StorageError as error:
            return error.as_result()
        except Exception as error:  # noqa: BLE001 - the bridge must never raise
            # Anything unexpected is logged with its traceback on the Python side,
            # where the person who can act on it will find it, and reported as a
            # plain failure to the page.
            logger.exception("Bridge call %s failed", getattr(call, "__name__", call))
            return {"ok": False, "error": f"{type(error).__name__}: {error}", "kind": "internal"}


def protocol_version() -> int:
    return PROTOCOL_VERSION
