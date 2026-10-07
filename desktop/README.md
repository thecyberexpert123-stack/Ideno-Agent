# Ideno on Linux

Ideno's product is a web UI. This package is what makes it a **desktop application**
on Linux rather than only a website: Python owns the window, the process lifetime,
the local server that delivers the bundle, and — the part that matters most for the
product — persistence to real files instead of a browser's ~5 MB `localStorage`
quota.

One bundle, two delivery mechanisms. Nothing about the UI changes between them.

```
python -m ideno_desktop        # a window, in a web engine
python -m ideno_desktop --browser   # your own browser, no web engine needed
```

---

## Requirements

| | |
|---|---|
| Python | 3.9 or newer |
| Node.js | 20 or newer, only to build the web bundle (once) |
| Web engine | only for window mode — see below |

Ideno's UI is a static bundle, so the web app is built once and then served from
disk. There is no server component and no backend to run: Python is the host, not a
web service.

## Install

```bash
cd Ideno-Agent

# 1. Build the web app once.
npm ci
npm run build

# 2. Install the desktop host. Pick the engine your machine already has.
python3 -m venv .venv && source .venv/bin/activate
pip install ./desktop            # then install an engine extra:
pip install "pywebview[qt]"      #   Chromium, via PyQt6-WebEngine
#  — or —
pip install "pywebview[gtk]"     #   WebKitGTK, via PyGObject
                                 #   (also needs your distribution's libwebkitgtk)
```

On Debian/Ubuntu the GTK route additionally needs the system package
`libwebkitgtk-6.0-4` (older releases: `libwebkit2gtk-4.1-0`). The Qt route is
self-contained in the wheel, which is why it is the default when both are possible.

Then run it:

```bash
ideno                    # the installed entry point
python3 -m ideno_desktop # equivalently, from the repository
```

### Check what your machine can do first

```bash
ideno --check
```

This reports the Python version, whether each web engine is usable and what to
install if it is not, whether the bundle has been built, where npm and node are, and
where your ideas will be stored. It runs with no display and no engine installed,
because the moment you most need it is the moment a window failed to appear.

---

## Where your ideas live

Window mode stores the workspace as JSON files under the XDG data directory:

```
~/.local/share/ideno/v1/
├── ideno.log                          diagnostics from the last run
└── workspace/
    ├── ideno.workspace.index.v2       which ideas exist, which one is open
    ├── ideno.session.v2.<id>          one file per idea
    └── ideno.settings.v1              provider and behaviour settings
```

Override the location with `--data-dir PATH` or `$IDENO_DATA_DIR`.

Each file is a complete, self-describing JSON document written **atomically** (write
to a temporary file, `fsync`, `os.replace`), so a crash or a full disk mid-write
leaves either the previous good copy or the new one — never a truncated file. Files
are created owner-only (`0600`): an idea under development is private notes, not a
world-readable document.

In `--browser` mode there is no bridge, and the workspace stays in the browser's own
storage instead. The app detects which situation it is in at boot; there is no
separate build and nothing to configure.

### Why this removes a hard limit

In a browser, an origin gets roughly 5 MB of `localStorage`. Ideno's version history
stores a full snapshot per version, and measured on this codebase, 30 user edits
produce a 201 KB record — so a browser workspace hits the ceiling after about 170
edits, after which *nothing* can be saved. On the desktop the same data goes to
disk, where the limit is the filesystem's.

The web app still defends itself when it is in a browser: it coalesces writes, and
when a write fails for lack of space it prunes the oldest snapshots that are not a
branch head, not labelled, and not the original idea, retrying until the current
state fits — and tells you what it dropped. See `CHANGELOG.md` (0.2.0, D1/D2) for
the measurements.

---

## Modes

| Flag | What it does | Needs |
|---|---|---|
| *(default)* | Opens a window in a web engine | pywebview + an engine |
| `--gui qt` / `--gui gtk` | Forces an engine instead of auto-detecting | that engine |
| `--browser` | Serves the app on loopback and opens your browser | a browser |
| `--dev` | Runs against `vite dev` with hot reload | npm |
| `--build` | Builds the bundle with npm, then starts | npm |
| `--debug` | Enables the engine's inspector and verbose logging | — |
| `--width` / `--height` | Initial window size (default 1440×900) | — |
| `--port N` | Fixed port (default: an arbitrary free one) | — |
| `--data-dir PATH` | Where the workspace files go | — |
| `--check` | Reports what this machine can run, then exits | nothing |

`--dev` points the window at Vite's dev server, so a change to a `.ts` file reloads
the running desktop app. It uses `--strictPort`: silently picking a different port
would leave the window pointed at whatever else answers on the one it announced.

---

## Security posture

Stated plainly, because this package opens a listening socket and exposes a bridge
into the filesystem.

**The HTTP server binds `127.0.0.1` and never `0.0.0.0`.** Nothing outside the
machine can reach it. It is still reachable by other local processes and other users
of a shared machine — the same exposure any local dev server has. What it serves is
the application bundle, not your ideas. Only `GET` and `HEAD` are accepted (anything
else gets `501`), paths are resolved and re-checked against the served root before
being read, responses carry `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`, and hashed build assets are immutable-cached while
the entry point is `no-store`.

**The bridge takes keys, not paths.** `window.pywebview.api` exposes six methods —
`info`, `snapshot`, `read`, `write`, `remove`, `list` — and every storage method
accepts a *key* which must match `^[A-Za-z0-9._-]+$`, must not be `.` or `..`, and
is re-validated after path resolution to confirm it still lands inside the workspace
directory. A bridge that accepted paths would be a filesystem proxy for whatever
ends up running in the page.

**The bridge has no policy.** It reads and writes documents and reports what
happened. Deciding what to save, when to prune, and what a quota failure means stays
in the TypeScript State Manager, where that logic is written once and tested once.
Duplicating it in Python would create two authorities over the same data.

**Nothing raises across the bridge.** An exception crossing into a web engine becomes
a JavaScript rejection whose shape depends on the backend, so every method returns
`{"ok": false, "error": ..., "kind": ...}` and unexpected failures are logged with
their traceback on the Python side, where someone can act on them.

**Errors keep their meaning.** A full disk is reported with `kind: "quota"`, which is
what lets the web app's prune-and-retry recovery run on the desktop too. Turning it
into a generic I/O error would reduce "your disk is full" to "your idea is gone".

**Protocol versioning.** The bridge reports `protocol: 1` and the UI refuses a host
that reports anything else, naming both versions. A host and a bundle from different
releases of Ideno fail with a sentence instead of corrupting a workspace.

**No API keys travel through Python.** Model calls go from the web engine to the
provider directly (Puter bills the signed-in user; an OpenAI-compatible key stays in
the page). The host stores what the app writes and never sees a credential it did not
need.

---

## Tests

```bash
cd desktop
python3 -m unittest discover -s ideno_desktop/tests -t .
```

78 tests, and they run **with or without pywebview installed** — the GUI toolkit is
imported inside the function that opens a window, never at module scope, because
importing Qt on a machine with no display can abort the process. Detection uses
`importlib.util.find_spec` rather than a real import for the same reason.

What they cover: key validation and path-traversal refusal, atomic-write behaviour
including that a failed write leaves the previous copy intact, error classification
(`ENOSPC`/`EDQUOT`/`EFBIG` → quota, `EACCES`/`EROFS` → permission), snapshot
semantics with a partially readable directory, engine detection and selection, CLI
validation, bundle location and build orchestration, bridge error containment, and
the startup messages. `test_serve.py` starts a real server on a real loopback socket
and makes real HTTP requests, asserting MIME types, cache headers, traversal
refusals and method refusal.

The TypeScript half of the same contract is tested in `tests/desktop_bridge.test.ts`
against a fake host speaking the same protocol, which is how both sides are verified
without a display.

---

## What has and has not been verified

Recorded because the difference matters.

**Verified by execution** (headless Linux, no display, no web engine installed):
`--check`; the refusal message and exit code when no engine is usable; the loopback
server serving the real built bundle with correct types, cache headers, traversal
refusals and method refusals; `--browser` mode end to end including data-directory
and log creation; all 78 Python tests; the TypeScript bridge tests; that the package
installs from `pyproject.toml` and provides an `ideno` entry point that works from
an unrelated working directory.

**Not verified:** that a window actually opens and renders. This machine has neither
a display server (`$DISPLAY` and `$WAYLAND_DISPLAY` are both unset) nor a web engine
(PyQt6 and PyGObject are absent), so `webview.create_window` / `webview.start` were
never executed. The calls are written against pywebview 6.2.1's verified signatures
and every failure path before them is tested, but "a window appears and the UI works
inside it" is an unverified claim until someone runs it on a desktop. Run
`ideno --check` first: it will tell you exactly which engine is missing.
