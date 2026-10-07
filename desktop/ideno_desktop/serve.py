"""Serving the built web app over loopback.

Why a server at all, rather than ``file://``: the UI is an ES-module bundle. Web
engines apply origin restrictions to ``file://`` that break module imports, service
workers and ``fetch`` — and pywebview's own JavaScript bridge is injected per
origin, which is far more predictable over HTTP than over the file scheme.

Security posture, stated plainly because this is a listener:

* It binds **127.0.0.1** and never ``0.0.0.0``. Nothing outside this machine can
  reach it. It is still reachable by other local processes and other users of a
  shared machine, which is the same exposure any local development server has; the
  data it serves is the application bundle, not the workspace (the workspace travels
  over the pywebview bridge or stays in the browser's own storage).
* Only ``GET`` and ``HEAD`` are accepted.
* Paths are resolved and re-checked against the served root before anything is
  read, so a crafted URL cannot escape it.
* Responses are ``no-store``: a desktop app reloading from disk should never be
  served a stale bundle by an intermediate cache.
"""

from __future__ import annotations

import socket
import threading
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOOPBACK = "127.0.0.1"

#: `SimpleHTTPRequestHandler` guesses most of these, but the ones that matter for a
#: module bundle are stated explicitly rather than left to the platform's
#: `mime.types`, which on a minimal Linux install may not exist at all.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}

#: Hashed build artefacts are immutable; the entry point is not.
IMMUTABLE_PREFIXES = ("assets/",)


@dataclass(frozen=True)
class RunningServer:
    """A server thread and the URL to point a window at."""

    url: str
    port: int
    root: Path

    def shutdown(self) -> None:
        server = _REGISTRY.pop(self.port, None)
        if server is not None:
            server.shutdown()
            server.server_close()


# Keep a handle on live servers so `shutdown()` can stop them. Keyed by port, which
# is unique per running server on this machine.
_REGISTRY: dict[int, ThreadingHTTPServer] = {}


class IdenoRequestHandler(SimpleHTTPRequestHandler):
    """Static file handler with a hard root, explicit types and no caching."""

    server_version = "IdenoDesktop/1.0"

    def end_headers(self) -> None:  # noqa: N802 - signature from the base class
        path = self.translate_path(self.path)
        relative = _relative_to_root(path, Path(self.directory or "."))
        cacheable = any(relative.startswith(prefix) for prefix in IMMUTABLE_PREFIXES)
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if cacheable else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def guess_type(self, path: str) -> str:  # noqa: N802 - signature from the base class
        suffix = Path(path).suffix.lower()
        return CONTENT_TYPES.get(suffix, super().guess_type(path))

    def do_POST(self) -> None:  # noqa: N802 - signature from the base class
        self._refuse(501, "This server only serves files.")

    def do_PUT(self) -> None:  # noqa: N802
        self._refuse(501, "This server only serves files.")

    def do_DELETE(self) -> None:  # noqa: N802
        self._refuse(501, "This server only serves files.")

    def _refuse(self, code: int, message: str) -> None:
        body = message.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        """Silence per-request stderr noise; the app logs what matters."""
        return None


def _relative_to_root(path: str, root: Path) -> str:
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return ""


def serve(root: Path, port: int = 0) -> RunningServer:
    """Starts a daemon-threaded static server for `root` on loopback.

    `port=0` asks the kernel for a free port, which is the right default for a
    desktop app: a fixed port would collide with anything else on the machine and
    turn "open Ideno" into "figure out what is using 8080".
    """
    root = Path(root).resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"There is no web app directory at {root}.")

    handler = partial(IdenoRequestHandler, directory=str(root))
    server = ThreadingHTTPServer((LOOPBACK, port), handler)
    server.daemon_threads = True
    bound = server.server_address[1]
    _REGISTRY[bound] = server

    thread = threading.Thread(target=server.serve_forever, name=f"ideno-http-{bound}", daemon=True)
    thread.start()

    return RunningServer(url=f"http://{LOOPBACK}:{bound}/", port=bound, root=root)


def port_is_free(port: int) -> bool:
    """Used before starting a dev server on a port the user chose."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((LOOPBACK, port))
        except OSError:
            return False
    return True
