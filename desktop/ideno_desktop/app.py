"""Application entry point.

Ordering matters here, and it is the substance of this module:

1. Work out what is being served (built bundle, or a dev server) — and fail with
   instructions if it is not there.
2. Work out whether a web engine exists — and offer the browser path if it does not.
3. Start the loopback server.
4. Only then touch the GUI toolkit.

Importing a GUI toolkit before those checks is how a desktop app ends up printing a
Qt stack trace when the real problem is "you have not built the web app yet".
"""

from __future__ import annotations

import logging
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from . import __version__
from .backend import (
    available_backends,
    check_backend,
    choose_backend,
    explain_unavailable,
    pywebview_installed,
)
from .bridge import IdenoApi
from .build import BuildError, WebApp, build_web_app, locate_dist, repo_root, start_dev_server
from .cli import Options
from .paths import data_home, describe as describe_paths, ensure_data_dir, log_path
from .serve import port_is_free, serve
from .storage import FileStore

logger = logging.getLogger("ideno")

DEV_SERVER_PORT = 5173
DEV_SERVER_WAIT_S = 60.0
WINDOW_TITLE = "Ideno"
#: Matches the app's own page background (`--bg` in src/ui/styles.css), so the
#: window is not a flash of a different colour before the UI paints. Keeping this in
#: step with the stylesheet is a manual coupling; it is one hex value, and the
#: alternative — reading the built CSS at startup — would be worse.
BACKGROUND_COLOR = "#f7f7f8"


class StartupError(Exception):
    """Something prevented Ideno from starting. The message is for a person."""


def configure_logging(debug: bool, root: Path | None = None) -> Path | None:
    """Logs to stderr and to a file in the data directory.

    The file matters more than it looks: when a window fails to appear there is
    otherwise nothing to read, and "nothing happened" is not a bug report.
    """
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    path: Path | None = None
    try:
        path = log_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(path, encoding="utf-8"))
    except OSError as error:
        logging.basicConfig(level=logging.DEBUG if debug else logging.INFO, force=True)
        logger.warning("Could not open a log file (%s); logging to stderr only.", error)
        return None

    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )
    return path


def resolve_web_app(options: Options) -> tuple[WebApp, subprocess.Popen[str] | None]:
    """Decides what to serve. Raises `StartupError` with instructions on failure."""
    try:
        root = repo_root()
    except BuildError as error:
        raise StartupError(str(error)) from error

    try:
        if options.build:
            logger.info("Building the web app with npm…")
            return build_web_app(root), None

        if options.dev:
            port = options.port or DEV_SERVER_PORT
            if not port_is_free(port):
                raise StartupError(
                    f"Port {port} is already in use, so the dev server cannot start there. "
                    "Pass --port to choose another."
                )
            logger.info("Starting `vite dev` on port %d…", port)
            process = start_dev_server(root, port)
            try:
                _wait_for_dev_server(port)
            except StartupError:
                process.terminate()
                raise
            return (
                WebApp(root=root, index=root / "index.html", dev=True, url=f"http://127.0.0.1:{port}/"),
                process,
            )

        return locate_dist(root), None
    except BuildError as error:
        raise StartupError(str(error)) from error


def _wait_for_dev_server(port: int, timeout: float = DEV_SERVER_WAIT_S) -> None:
    """Blocks until Vite accepts connections, so the window is not pointed at nothing."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.25)
    raise StartupError(
        f"The dev server did not start listening on port {port} within {timeout:.0f}s. "
        "Run `npm run dev` yourself to see what it reports."
    )


def run(options: Options) -> int:
    """Starts Ideno. Returns a process exit code."""
    data_root = options.data_dir or data_home()
    configure_logging(options.debug, data_root)

    if options.check:
        print(check_report(data_root))
        return 0

    try:
        workspace_dir = ensure_data_dir(data_root)
    except OSError as error:
        raise StartupError(f"Could not create the data directory {data_root}: {error}") from error
    logger.info("Workspace files: %s", workspace_dir)

    web_app, dev_process = resolve_web_app(options)

    try:
        if options.browser:
            return _run_in_browser(web_app, options)
        return _run_in_window(web_app, options, workspace_dir)
    finally:
        if dev_process is not None and dev_process.poll() is None:
            logger.info("Stopping the dev server.")
            dev_process.terminate()
            try:
                dev_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                dev_process.kill()


def _run_in_browser(web_app: WebApp, options: Options) -> int:
    server = None
    if web_app.dev and web_app.url:
        url = web_app.url
    else:
        server = serve(web_app.root, options.port)
        url = server.url

    # `flush=True` throughout: when stdout is a pipe or a log file it is
    # block-buffered, and a CLI that prints the URL you are supposed to open would
    # otherwise keep it to itself until it exited.
    print(f"Ideno is being served at {url}", flush=True)
    print("Run this way, the workspace lives in the browser's own storage.", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if not webbrowser.open(url):
        print("Could not open a browser automatically — copy the URL above.", flush=True)
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopping.", flush=True)
    finally:
        if server is not None:
            server.shutdown()
    return 0


def _run_in_window(web_app: WebApp, options: Options, workspace_dir: Path) -> int:
    if not pywebview_installed():
        raise StartupError(
            "pywebview is not installed, so Ideno cannot open a window.\n"
            '  Install it with:  pip install "pywebview[qt]"   (or "pywebview[gtk]")\n'
            "  Or run in your browser instead:  python3 -m ideno_desktop --browser"
        )

    backend, statuses = choose_backend(options.gui)
    if backend is None:
        raise StartupError(_no_backend_message(options.gui, statuses))

    # Imported only now: importing a GUI toolkit on a machine without one is the
    # failure the checks above exist to prevent.
    import webview  # noqa: PLC0415

    server = None
    if web_app.dev and web_app.url:
        url = web_app.url
    else:
        server = serve(web_app.root, options.port)
        url = server.url

    api = IdenoApi(FileStore(workspace_dir), __version__)

    logger.info("Opening a %s window at %s", backend, url)
    window = webview.create_window(
        WINDOW_TITLE,
        url=url,
        js_api=api,
        width=options.width,
        height=options.height,
        min_size=(960, 600),
        background_color=BACKGROUND_COLOR,
        text_select=True,
        zoomable=True,
    )

    try:
        # `private_mode=False` plus an explicit `storage_path` gives the web engine a
        # persistent profile, so anything the UI keeps in localStorage survives too.
        # The ideas themselves go through the bridge into real files.
        webview.start(
            gui=backend,
            debug=options.debug,
            private_mode=False,
            storage_path=str(workspace_dir.parent),
        )
    except Exception as error:  # noqa: BLE001 - a toolkit failure must stay readable
        raise StartupError(
            f"The {backend} web engine failed to start: {error}\n\n{explain_unavailable(statuses)}"
        ) from error
    finally:
        if server is not None:
            server.shutdown()
        if window is not None:
            logger.debug("Window closed.")
    return 0


def _no_backend_message(requested: str, statuses: list) -> str:
    if requested and requested != "auto":
        detail = next((status for status in statuses if status.name == requested), None)
        if detail is not None:
            return (
                f"You asked for the '{requested}' web engine, but it is not usable here.\n"
                f"  {detail.reason}\n\n{explain_unavailable(statuses)}"
            )
    return explain_unavailable(statuses)


def check_report(data_root: Path) -> str:
    """What this machine can run. Written for a person deciding what to install."""
    lines = [f"Ideno {__version__} — environment check", "=" * 46, ""]

    lines.append(f"Python      {sys.version.split()[0]} at {sys.executable}")
    lines.append(f"Platform    {sys.platform}")
    lines.append("")

    lines.append("Web engine")
    lines.append(f"  pywebview installed : {'yes' if pywebview_installed() else 'no'}")
    if not pywebview_installed():
        lines.append('                        install: pip install "pywebview[qt]"')
    for name in ("qt", "gtk"):
        status = check_backend(name)
        mark = "ready" if status.available else "unavailable"
        lines.append(f"  {name:<20}: {mark} — {status.reason}")
        if not status.available and status.install_hint:
            lines.append(f"  {'':<20}  install: {status.install_hint}")
    ready = available_backends()
    lines.append(f"  usable now          : {', '.join(ready) if ready else 'none'}")
    lines.append("")

    lines.append("Web app")
    try:
        root = repo_root()
        lines.append(f"  repository root     : {root}")
        try:
            app = locate_dist(root)
            lines.append(f"  built bundle        : {app.index}")
        except BuildError:
            lines.append("  built bundle        : MISSING")
            lines.append(f"                        build with: cd {root} && npm ci && npm run build")
        lines.append(f"  npm                 : {shutil.which('npm') or 'not found on PATH'}")
        lines.append(f"  node                : {shutil.which('node') or 'not found on PATH'}")
    except BuildError as error:
        lines.append(f"  repository root     : not found — {error}")
    lines.append("")

    lines.append("Data")
    locations = describe_paths(data_root)
    for key, value in locations.items():
        lines.append(f"  {key:<20}: {value}")
    workspace = Path(locations["workspace_dir"])
    if workspace.is_dir():
        documents = sorted(entry for entry in workspace.iterdir() if entry.is_file())
        lines.append(f"  stored documents    : {len(documents)}")
        for entry in documents[:10]:
            lines.append(f"      {entry.name} ({entry.stat().st_size:,} bytes)")
        if len(documents) > 10:
            lines.append(f"      … and {len(documents) - 10} more")
    else:
        lines.append("  stored documents    : none yet (created on first run)")
    lines.append("")

    lines.append("Modes")
    lines.append("  window (default)    : needs a usable web engine above")
    lines.append("  --browser           : needs only a browser; workspace lives in browser storage")
    lines.append("  --dev               : needs npm; runs against `vite dev` with hot reload")
    return "\n".join(lines)
