"""Where Ideno keeps its data on a Linux machine.

Follows the XDG Base Directory Specification rather than inventing a location: a
desktop application that writes into its own installation directory, or into the
user's home directory directly, is a nuisance that people have to clean up by
hand.

    $XDG_DATA_HOME/ideno      (default ~/.local/share/ideno)
        workspace/*.json      the ideas themselves
        ideno.log             diagnostics from the last run

The data directory is *the* persistence layer of the desktop app. The web engine's
own localStorage is still used when Ideno runs in a plain browser, but on the
desktop the ideas live in files a person can inspect, copy and back up — which is
also what removes the ~5 MB ceiling that `localStorage` imposes on a workspace.
"""

from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "ideno"

# The layout version lives in the directory name so that a future format change can
# be introduced without reading (or overwriting) an existing user's data.
LAYOUT = "v1"

WORKSPACE_DIRNAME = "workspace"
LOG_FILENAME = "ideno.log"


def data_home(override: str | os.PathLike[str] | None = None) -> Path:
    """Root of Ideno's data directory.

    `override` wins, then ``$IDENO_DATA_DIR`` (used by the test suite and by
    anyone who wants a throwaway profile), then ``$XDG_DATA_HOME/ideno``, then
    ``~/.local/share/ideno``.
    """
    if override:
        return Path(override).expanduser()

    from_env = os.environ.get("IDENO_DATA_DIR")
    if from_env:
        return Path(from_env).expanduser()

    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / APP_NAME


def ensure_data_dir(root: Path | None = None) -> Path:
    """Creates the data directory tree and returns the workspace directory."""
    root = root or data_home()
    workspace = root / LAYOUT / WORKSPACE_DIRNAME
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def log_path(root: Path | None = None) -> Path:
    root = root or data_home()
    return root / LAYOUT / LOG_FILENAME


def describe(root: Path | None = None) -> dict[str, str]:
    """The locations Ideno will use, for `--check` and for the UI's About panel."""
    base = root or data_home()
    return {
        "data_dir": str(base),
        "workspace_dir": str(base / LAYOUT / WORKSPACE_DIRNAME),
        "log_file": str(log_path(base)),
        "layout": LAYOUT,
    }
