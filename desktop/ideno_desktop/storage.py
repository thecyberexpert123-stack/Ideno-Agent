"""The file-backed store exposed to the web app through pywebview's JS bridge.

Design rules, in the order they matter:

1. **The bridge has no policy.** It reads and writes named files and reports what
   happened. Deciding *what* to save, when to prune a snapshot, and what a quota
   failure means is the TypeScript State Manager's job, where that logic is already
   written and tested. Duplicating it here would create two authorities over the
   same data.

2. **Errors are reported faithfully.** A disk-full condition is returned as a
   quota error rather than a generic one, so the retry-with-pruning path in the web
   app still works on the desktop. Swallowing an exception and returning ``None``
   would turn "your disk is full" into "your idea is gone".

3. **Writes are atomic.** Every write goes to a temporary file in the same
   directory and is then ``os.replace``d over the target, which is atomic on POSIX.
   A crash or a full disk mid-write therefore leaves either the previous good copy
   or the new one, never a truncated file. Truncation is the one failure mode that
   would destroy an idea rather than merely fail to update it.

4. **The key is not a path.** Keys come from the web app, so they are treated as
   untrusted input: a strict allowlist, no separators, no traversal, and the
   resolved path is verified to still be inside the workspace directory before it
   is touched.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

#: Version of this bridge's contract. The web app refuses to use a bridge whose
#: protocol it does not recognise, so the two can never silently disagree about the
#: shape of a response.
PROTOCOL_VERSION = 1

MAX_KEY_LENGTH = 128

# Keys in this codebase look like "ideno.session.v2.session_abc-123" and
# "ideno.settings.v1". Letters, digits, dot, dash and underscore cover all of them;
# everything else — above all "/" and "\" — is refused.
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")

# Error strings the web app matches on to decide whether shrinking the payload
# could help. Keep in sync with `isQuotaError` in
# src/core/state_manager/store.ts.
QUOTA_MARKERS = ("quota", "no space left", "disk quota", "file too large")


class StorageError(Exception):
    """A storage operation failed. ``kind`` says whether retrying smaller helps."""

    def __init__(self, message: str, kind: str = "io") -> None:
        super().__init__(message)
        self.kind = kind

    def as_result(self) -> dict[str, object]:
        return {"ok": False, "error": str(self), "kind": self.kind}


def sanitize_key(key: object) -> str:
    """Validates a storage key and returns it, or raises :class:`StorageError`.

    The key is used as a filename, so this is a path-traversal boundary, not a
    stylistic preference. It is checked twice: once by pattern, and again after
    resolution, because a rule about the string is not a proof about the path.
    """
    if not isinstance(key, str):
        raise StorageError(f"A storage key must be a string, got {type(key).__name__}.", kind="invalid_key")
    if not key or len(key) > MAX_KEY_LENGTH:
        raise StorageError(
            f"A storage key must be 1-{MAX_KEY_LENGTH} characters long.", kind="invalid_key"
        )
    if not _KEY_PATTERN.match(key):
        raise StorageError(
            "A storage key may only contain letters, digits, '.', '-' and '_'.", kind="invalid_key"
        )
    if key in (".", ".."):
        # Both satisfy the character allowlist and neither is a filename. Refusing
        # them here rather than relying on the resolution check below is the
        # difference between a rule and a hope.
        raise StorageError(f"'{key}' is not a valid storage key.", kind="invalid_key")
    return key


def classify(error: OSError) -> str:
    """Maps an OS error onto the kinds the web app knows how to react to."""
    import errno

    if error.errno in (errno.ENOSPC, errno.EDQUOT, errno.EFBIG):
        return "quota"
    if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return "permission"
    return "io"


class FileStore:
    """One JSON document per key, inside a single workspace directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    # -- path handling ------------------------------------------------------

    def path_for(self, key: str) -> Path:
        """Resolves and re-validates the file path for a key."""
        safe = sanitize_key(key)
        candidate = (self.directory / safe).resolve()
        root = self.directory.resolve()
        if candidate.parent != root:
            # Unreachable given the allowlist above. Kept because the consequence
            # of being wrong here is writing outside the user's data directory.
            raise StorageError(f"The key '{safe}' does not resolve inside the workspace.", kind="invalid_key")
        return candidate

    # -- the bridge surface -------------------------------------------------

    def info(self) -> dict[str, object]:
        return {
            "ok": True,
            "protocol": PROTOCOL_VERSION,
            "kind": "desktop-file",
            "data_dir": str(self.directory.parent),
            "workspace_dir": str(self.directory),
        }

    def read(self, key: str) -> dict[str, object]:
        try:
            path = self.path_for(key)
        except StorageError as error:
            return error.as_result()
        if not path.is_file():
            return {"ok": True, "value": None}
        try:
            return {"ok": True, "value": path.read_text(encoding="utf-8")}
        except OSError as error:
            return StorageError(f"Could not read '{key}': {error.strerror or error}", classify(error)).as_result()

    def write(self, key: str, value: str) -> dict[str, object]:
        if not isinstance(value, str):
            return StorageError("Only strings can be stored.", kind="invalid_value").as_result()
        try:
            path = self.path_for(key)
            _atomic_write(path, value)
        except StorageError as error:
            return error.as_result()
        except OSError as error:
            return StorageError(
                f"Could not save '{key}': {error.strerror or error}", classify(error)
            ).as_result()
        return {"ok": True}

    def remove(self, key: str) -> dict[str, object]:
        try:
            path = self.path_for(key)
        except StorageError as error:
            return error.as_result()
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            return StorageError(f"Could not remove '{key}': {error.strerror or error}", classify(error)).as_result()
        return {"ok": True}

    def list(self) -> dict[str, object]:
        try:
            keys = sorted(entry.name for entry in self.directory.iterdir() if entry.is_file())
        except OSError as error:
            return StorageError(f"Could not list the workspace: {error.strerror or error}", classify(error)).as_result()
        return {"ok": True, "keys": keys}

    def snapshot(self) -> dict[str, object]:
        """Every stored document, in one call.

        The web app loads its whole store into memory at boot and then mirrors
        writes back, which is what lets the store it uses stay synchronous while
        the bridge underneath is not. One round trip at startup is cheaper than one
        per key, and the payload is the same data either way.
        """
        try:
            entries = [entry for entry in self.directory.iterdir() if entry.is_file()]
        except OSError as error:
            return StorageError(f"Could not read the workspace: {error.strerror or error}", classify(error)).as_result()

        values: dict[str, str] = {}
        failures: list[str] = []
        for entry in sorted(entries, key=lambda item: item.name):
            try:
                values[entry.name] = entry.read_text(encoding="utf-8")
            except OSError as error:
                failures.append(f"{entry.name}: {error.strerror or error}")
        result: dict[str, object] = {
            "ok": True,
            "protocol": PROTOCOL_VERSION,
            "values": values,
            "data_dir": str(self.directory.parent),
            "workspace_dir": str(self.directory),
        }
        if failures:
            # Partial success is reported as such: some documents were unreadable,
            # and the web app has to be able to say so instead of showing a
            # workspace that silently lacks one idea.
            result["failures"] = failures
        return result


def _atomic_write(path: Path, value: str) -> None:
    """Writes `value` to `path`, or leaves whatever is there untouched."""
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=directory)
    temp = Path(temp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        # Preserve the previous file's permissions when replacing it, and keep new
        # files owner-only: ideas are private notes, not world-readable documents.
        _copy_mode(path, temp)
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def _copy_mode(source: Path, target: Path) -> None:
    try:
        target.chmod(source.stat().st_mode & 0o777)
    except (OSError, FileNotFoundError):
        try:
            target.chmod(0o600)
        except OSError:
            pass


def is_json_document(text: str) -> bool:
    """Cheap sanity check used by `--check` and by the import path."""
    try:
        json.loads(text)
    except (ValueError, TypeError):
        return False
    return True
