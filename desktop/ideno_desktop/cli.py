"""Command line interface for the Ideno desktop application.

Argument parsing lives on its own so it can be tested without a display, a web
engine or a built bundle — which is the only way any of this can be verified on a
headless machine, and the reason `--check` exists.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

PROGRAM = "ideno"
DESCRIPTION = "Ideno — an idea-development system. Runs as a desktop application in a web engine, or in your browser."


@dataclass(frozen=True)
class Options:
    """Everything the entry point needs, already validated."""

    gui: str
    browser: bool
    dev: bool
    build: bool
    port: int
    width: int
    height: int
    data_dir: Path | None
    debug: bool
    check: bool
    version: bool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=PROGRAM, description=DESCRIPTION)

    window = parser.add_argument_group("window")
    window.add_argument(
        "--gui",
        choices=("auto", "qt", "gtk"),
        default="auto",
        help="web engine to use (default: auto — Qt/Chromium first, then WebKitGTK)",
    )
    window.add_argument("--width", type=int, default=1440, help="initial window width in pixels (default: 1440)")
    window.add_argument("--height", type=int, default=900, help="initial window height in pixels (default: 900)")
    window.add_argument(
        "--debug",
        action="store_true",
        help="enable the web engine's inspector and verbose logging",
    )

    mode = parser.add_argument_group("mode")
    mode.add_argument(
        "--browser",
        action="store_true",
        help="serve the app and open it in your default browser instead of a window "
        "(no web engine needed; the workspace then lives in browser storage)",
    )
    mode.add_argument(
        "--dev",
        action="store_true",
        help="run against `vite dev` with hot reload instead of the built bundle",
    )
    mode.add_argument(
        "--build",
        action="store_true",
        help="build the web app with npm before starting",
    )
    mode.add_argument(
        "--port",
        type=int,
        default=0,
        help="port to serve on (default: 0, meaning an arbitrary free port; "
        "with --dev it is the Vite port, default 5173)",
    )

    data = parser.add_argument_group("data")
    data.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="where to keep the workspace files (default: $XDG_DATA_HOME/ideno, "
        "i.e. ~/.local/share/ideno)",
    )

    info = parser.add_argument_group("information")
    info.add_argument(
        "--check",
        action="store_true",
        help="report what this machine can run — web engines, npm, the built bundle, "
        "the data directory — and exit",
    )
    info.add_argument("--version", action="store_true", help="print version information and exit")

    return parser


def parse_args(argv: list[str] | None = None) -> Options:
    """Parses and validates. Exits with a readable message rather than a traceback."""
    parser = build_parser()
    parsed = parser.parse_args(argv)

    if parsed.width < 480 or parsed.height < 360:
        parser.error("the window must be at least 480x360")
    if parsed.port < 0 or parsed.port > 65535:
        parser.error("--port must be between 0 and 65535")
    if parsed.browser and parsed.gui != "auto":
        parser.error("--browser opens your own browser, so --gui does not apply")

    return Options(
        gui=parsed.gui,
        browser=bool(parsed.browser),
        dev=bool(parsed.dev),
        build=bool(parsed.build),
        port=int(parsed.port),
        width=int(parsed.width),
        height=int(parsed.height),
        data_dir=Path(parsed.data_dir).expanduser() if parsed.data_dir else None,
        debug=bool(parsed.debug),
        check=bool(parsed.check),
        version=bool(parsed.version),
    )
