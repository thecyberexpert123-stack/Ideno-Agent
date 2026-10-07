"""Locating the built web app, and building it when it is not there.

The desktop host serves the same `dist/` a web deployment would: one artefact, two
delivery mechanisms. Nothing about the UI changes between them, which is the point
of keeping the product a web app and putting Python around it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

#: Where Vite writes its output, relative to the repository root.
DIST_RELPATH = ("dist",)
INDEX_NAME = "index.html"


class BuildError(Exception):
    """The web app could not be located or built."""


@dataclass(frozen=True)
class WebApp:
    """A directory that can be served as the Ideno web app."""

    root: Path
    index: Path
    #: True when this is a `vite dev` server rather than a built directory.
    dev: bool = False
    url: str | None = None

    def describe(self) -> dict[str, object]:
        return {
            "root": str(self.root),
            "index": str(self.index),
            "dev": self.dev,
            "url": self.url,
        }


def repo_root(start: Path | None = None) -> Path:
    """Walks up from `start` looking for the repository root.

    Identified by `package.json` naming this project, not by `.git`: an installed
    copy has no `.git` and must still work.
    """
    current = (start or Path(__file__)).resolve()
    for candidate in (current, *current.parents):
        manifest = candidate / "package.json"
        if manifest.is_file() and '"name": "ideno"' in manifest.read_text(encoding="utf-8"):
            return candidate
    raise BuildError(
        "Could not find the Ideno repository root (a package.json naming the project "
        f"'ideno') above {current}. Run the desktop app from inside the repository."
    )


def locate_dist(root: Path | None = None) -> WebApp:
    """Returns the built web app, or raises with instructions."""
    root = root or repo_root()
    dist = root.joinpath(*DIST_RELPATH)
    index = dist / INDEX_NAME
    if not index.is_file():
        raise BuildError(
            f"The web app has not been built yet: {index} does not exist.\n"
            f"  Build it once with:  cd {root} && npm ci && npm run build\n"
            f"  Or let Ideno do it:  python3 -m ideno_desktop --build\n"
            f"  Or develop live:     python3 -m ideno_desktop --dev"
        )
    return WebApp(root=dist, index=index)


def build_web_app(root: Path | None = None, timeout: float = 600.0) -> WebApp:
    """Runs the project's own build, so there is one definition of "built"."""
    root = root or repo_root()
    npm = shutil.which("npm")
    if not npm:
        raise BuildError(
            "npm was not found on PATH, so the web app cannot be built. "
            "Install Node.js (20 or newer) or build it on another machine and copy "
            f"the resulting {root.joinpath(*DIST_RELPATH)} directory here."
        )

    if not (root / "node_modules").is_dir():
        _run([npm, "ci"], root, timeout)
    _run([npm, "run", "build"], root, timeout)
    return locate_dist(root)


def _run(command: list[str], cwd: Path, timeout: float) -> None:
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            check=False,
            timeout=timeout,
            capture_output=True,
            text=True,
            env={**os.environ, "npm_config_fund": "false", "npm_config_audit": "false"},
        )
    except subprocess.TimeoutExpired as error:
        raise BuildError(f"{' '.join(command)} did not finish within {timeout:.0f}s.") from error
    except OSError as error:
        raise BuildError(f"Could not run {' '.join(command)}: {error}") from error

    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-15:]
        raise BuildError(
            f"{' '.join(command)} failed (exit {completed.returncode}):\n" + "\n".join(tail)
        )


def start_dev_server(root: Path | None = None, port: int = 5173) -> subprocess.Popen[str]:
    """Starts `vite dev` for live development against the desktop window.

    Returned so the caller can terminate it; the desktop app owns the lifetime of
    anything it starts.
    """
    root = root or repo_root()
    npm = shutil.which("npm")
    if not npm:
        raise BuildError("npm was not found on PATH, so the dev server cannot be started.")
    return subprocess.Popen(
        [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=str(root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
