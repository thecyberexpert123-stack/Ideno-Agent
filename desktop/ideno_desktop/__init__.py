"""Ideno's Linux desktop host.

Ideno's product is a web UI. This package is what makes it a *desktop application*
on Linux rather than only a website: Python owns the window, the process lifetime,
the loopback server that delivers the bundle, and — the part that actually matters
for the product — persistence to real files under the user's XDG data directory
instead of a browser's ~5 MB localStorage quota.

Layout
------
``paths.py``
    Where data lives (XDG).
``storage.py``
    Atomic, key-scoped file storage; the bridge has no policy.
``bridge.py``
    The ``window.pywebview.api`` surface.
``backend.py``
    Which web engine this machine can run, detected before anything is imported.
``build.py``
    Locating and building the web bundle.
``serve.py``
    A loopback static server for that bundle.
``cli.py``
    Argument parsing, testable without a display.
``app.py``
    Orchestration: what to serve, whether a window is possible, then the window.

Run it with ``python3 -m ideno_desktop`` (see ``--help`` and ``--check``).
"""

from __future__ import annotations

__version__ = "0.2.0"

__all__ = ["__version__"]
