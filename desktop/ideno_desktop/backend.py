"""Which web engine this machine can actually run.

Ideno's UI is a web UI, so the desktop application needs a web engine. On Linux
pywebview can drive two:

    qt   → PyQt6 + PyQt6-WebEngine   (Chromium)
    gtk  → PyGObject + libwebkitgtk  (WebKitGTK)

Detecting this *before* opening a window matters because the alternative is a
traceback from deep inside a GUI toolkit, which tells a person nothing about what
to install. Every failure path here ends in a sentence that names a package.

Nothing in this module imports a GUI toolkit at module scope: `--check`, the tests
and `--browser` all have to work on a machine with no display and no engine
installed.
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass

BACKENDS = ("qt", "gtk")

#: What each pywebview backend needs, in the terms a person would install them.
BACKEND_REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "qt": ("PyQt6", "PyQt6-WebEngine"),
    "gtk": ("gi",),
}

BACKEND_INSTALL_HINTS: dict[str, str] = {
    "qt": 'pip install "pywebview[qt]"   (PyQt6 + PyQt6-WebEngine, Chromium engine)',
    "gtk": 'pip install "pywebview[gtk]"  (PyGObject + libwebkitgtk-6.0 from your distribution)',
}

#: pywebview's own import name for each backend's Python bindings.
BACKEND_MODULES: dict[str, tuple[str, ...]] = {
    "qt": ("PyQt6", "PyQt6.QtWebEngineWidgets"),
    "gtk": ("gi",),
}


@dataclass(frozen=True)
class BackendStatus:
    """What one backend needs and whether this machine has it."""

    name: str
    available: bool
    missing: tuple[str, ...]
    install_hint: str
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "available": self.available,
            "missing": list(self.missing),
            "install_hint": self.install_hint,
            "reason": self.reason,
        }


def module_present(name: str) -> bool:
    """True when `name` can be imported, without importing it.

    `find_spec` is used rather than a real import because importing a GUI toolkit
    has side effects — Qt in particular can abort the process when there is no
    display — and detection must be safe to run anywhere.
    """
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, ModuleNotFoundError):
        return False


def have_display() -> bool:
    """True when there is something to open a window on."""
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def check_backend(name: str) -> BackendStatus:
    """Inspects one backend without initialising it."""
    if name not in BACKENDS:
        return BackendStatus(
            name=name,
            available=False,
            missing=(),
            install_hint="",
            reason=f"'{name}' is not a backend Ideno knows. Use one of: {', '.join(BACKENDS)}.",
        )

    missing = tuple(module for module in BACKEND_MODULES[name] if not module_present(module))
    if missing:
        return BackendStatus(
            name=name,
            available=False,
            missing=missing,
            install_hint=BACKEND_INSTALL_HINTS[name],
            reason=f"Missing Python module(s): {', '.join(missing)}.",
        )

    if name == "gtk" and not _webkit_present():
        # PyGObject without a WebKit typelib is the most common half-installation:
        # `import gi` succeeds and the failure only appears when a window is created.
        return BackendStatus(
            name=name,
            available=False,
            missing=("libwebkitgtk (WebKit-6.0 typelib)",),
            install_hint=BACKEND_INSTALL_HINTS[name],
            reason="PyGObject is installed but no WebKitGTK typelib was found.",
        )

    if not have_display():
        return BackendStatus(
            name=name,
            available=False,
            missing=(),
            install_hint=BACKEND_INSTALL_HINTS[name],
            reason="No display: neither $DISPLAY nor $WAYLAND_DISPLAY is set.",
        )

    return BackendStatus(
        name=name,
        available=True,
        missing=(),
        install_hint=BACKEND_INSTALL_HINTS[name],
        reason="Ready.",
    )


def _webkit_present() -> bool:
    """Looks for a WebKitGTK typelib without loading GTK."""
    try:
        import gi  # noqa: PLC0415 - optional dependency, probed at runtime

        repository = getattr(gi, "require_version", None)
        if repository is None:
            return False
        for version in ("6.0", "5.0", "4.1", "4.0"):
            try:
                gi.require_version("WebKit", version)
                from gi.repository import WebKit  # noqa: F401, PLC0415

                return True
            except (ValueError, ImportError, AttributeError):
                continue
    except ImportError:
        return False
    return False


def available_backends() -> list[str]:
    return [status.name for status in (check_backend(name) for name in BACKENDS) if status.available]


def choose_backend(requested: str | None) -> tuple[str | None, list[BackendStatus]]:
    """Picks a backend, or explains why none could be picked.

    `requested` is what the user asked for with `--gui`; ``auto`` tries Qt first
    because Chromium's rendering of a modern CSS layout is closer to what the UI was
    developed against, and falls back to WebKitGTK.
    """
    statuses = [check_backend(name) for name in BACKENDS]

    if requested and requested != "auto":
        chosen = next((status for status in statuses if status.name == requested), None)
        if chosen is None:
            return None, statuses
        return (chosen.name if chosen.available else None), statuses

    for status in statuses:
        if status.available:
            return status.name, statuses
    return None, statuses


def pywebview_installed() -> bool:
    return module_present("webview")


def explain_unavailable(statuses: list[BackendStatus]) -> str:
    """The message shown when no window can be opened."""
    lines = ["Ideno could not find a usable web engine on this machine."]
    lines.append("")
    for status in statuses:
        lines.append(f"  {status.name}: {status.reason}")
        if not status.available:
            lines.append(f"        install: {status.install_hint}")
    lines.append("")
    lines.append("Ideno can also run in your existing browser, with no web engine installed:")
    lines.append("  python3 -m ideno_desktop --browser")
    lines.append("")
    lines.append("In browser mode the workspace is kept in the browser's own storage;")
    lines.append("in a window it is kept as JSON files under your XDG data directory.")
    return "\n".join(lines)
