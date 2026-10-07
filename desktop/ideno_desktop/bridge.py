"""The object pywebview exposes to the page as ``window.pywebview.api``.

Every public method returns a JSON-serialisable dict with an ``ok`` flag. Nothing
raises across the bridge: an exception that crosses into the web engine becomes a
JavaScript rejection whose shape depends on the backend, so errors are converted
here into something the web app can rely on.

The surface is deliberately tiny — info, snapshot, read, write, remove, list, and one
web search. Every storage method takes a *key*, never a path: a bridge that accepted
paths would be a file-system proxy for whatever ends up running in the page.

The web search is bounded the same way. It accepts a query, not a URL, so it is not an
HTTP proxy either; see :mod:`ideno_desktop.websearch` for why that distinction carries
the whole security argument.
"""

from __future__ import annotations

import json
import logging
import platform
import sys
from pathlib import Path

from . import websearch
from .storage import PROTOCOL_VERSION, FileStore, StorageError

logger = logging.getLogger("ideno.bridge")

#: The only search provider this host will call. See :mod:`ideno_desktop.websearch`.
TAVILY_PROVIDER = "tavily"

#: Bound on an incoming search payload. A query is 400 characters at most, so this is
#: generous by three orders of magnitude and exists only to stop an absurd input.
MAX_SEARCH_PAYLOAD_BYTES = 64 * 1024


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

    # -- web search ---------------------------------------------------------

    def web_search(self, payload: str) -> dict[str, object]:
        """Runs one web search on the host side and returns the reply as JSON text.

        Exists because a browser enforces CORS on a cross-origin ``fetch`` and this host
        does not. It is deliberately *not* a proxy: the payload carries a query and a
        few bounded options, never a destination, and
        :mod:`ideno_desktop.websearch` knows exactly one endpoint.

        The API key may arrive in the payload or be read from the environment. It is
        never logged — the only thing recorded about a failed search is the reason.
        """
        if not isinstance(payload, str):
            return {"ok": False, "error": "The search payload must be a JSON string."}
        if len(payload.encode("utf-8")) > MAX_SEARCH_PAYLOAD_BYTES:
            return {"ok": False, "error": "The search payload is too large."}

        try:
            decoded = json.loads(payload)
        except ValueError as error:
            return {"ok": False, "error": f"The search payload was not valid JSON ({error})."}
        if not isinstance(decoded, dict):
            return {"ok": False, "error": "The search payload was not a JSON object."}

        provider = decoded.get("provider")
        if provider != TAVILY_PROVIDER:
            # Naming the only supported provider keeps this method from becoming a
            # general "fetch this for me" entry point as more services are added.
            return {
                "ok": False,
                "error": f"Unsupported search provider {provider!r}; this host supports {TAVILY_PROVIDER!r}.",
            }

        body = decoded.get("body")
        if not isinstance(body, dict):
            return {"ok": False, "error": "The search payload had no request body."}

        # Flattened into the shape websearch.search expects: the options come from the
        # page, the key from the page or the environment, and the endpoint from neither.
        request = dict(body)
        request["api_key"] = decoded.get("api_key")
        request["timeout_ms"] = decoded.get("timeout_ms")

        try:
            value = websearch.search(request)
        except websearch.WebSearchError as error:
            logger.warning("Web search failed: %s", error.message)
            return {"ok": False, "error": error.message}
        except Exception as error:  # noqa: BLE001 - the bridge must never raise
            logger.exception("Web search failed unexpectedly")
            return {"ok": False, "error": f"{type(error).__name__}", "kind": "internal"}
        return {"ok": True, "value": value}

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
