# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
semantic versioning.

## 0.2.0 — 2026-10-07

Two things are being delivered together, at the user's request: a **hardening
pass** over v0.1 (fix real defects only) and a **hybrid feature increment**
(version branching, streaming, real research sources, a Three.js canonical
renderer, a multi-idea workspace) plus a new requirement added mid-flight:
**Ideno must run as a Linux desktop application with Python in the stack and a
web engine as the renderer, not only as a website.**

The plan, the ordering and the reasoning are in `docs/V0_2_PLAN.md`. This entry
records what landed, what was measured, and what was **not** verified.

### Added — hardening (Part A, complete)

Every defect below was **reproduced by execution** on the v0.1 code before it was
fixed; the measurements are recorded here so the fix can be checked against them
rather than taken on trust.

- **Split storage layout (`WORKSPACE_SCHEMA_VERSION = 2`).** A workspace is now a
  small index record (`ideno.workspace.index.v2`) plus one record per idea
  (`ideno.session.v2.<id>`), instead of one blob for everything
  (`ideno.workspace.v1`). Saving one idea no longer depends on the size of the
  others, and a corrupt idea cannot take the rest of the workspace with it.
- **Forward migration** (`state_manager/migration.ts`) from the v0.1 blob and from
  branchless data. Idempotent, never destructive, and it refuses a workspace
  written by a *newer* Ideno rather than guessing at a format it does not know.
- **Quota-aware saving.** A write that fails because the store is full is retried
  after dropping the oldest dispensable snapshot, up to 64 rounds. `isQuotaError`
  recognises the ways browsers actually report this (`QuotaExceededError`,
  `NS_ERROR_DOM_QUOTA_REACHED`, code 1014, quota-ish messages) so a *broken* store
  is not mistaken for a *full* one. When nothing is left to prune the user gets an
  actionable message — export now, it is still complete in memory.
- **Snapshot pruning policy** (`prunableVersions`): the original idea, every branch
  head, every labelled version and the newest eight versions per branch are never
  dropped. A pruned version keeps its record and gains `snapshot_pruned: true`, so
  history still reads as an account of what happened and the UI says "snapshot no
  longer stored" instead of showing an empty diff and implying nothing changed.
- **Bounded append-only collections.** The transcript and the change log are now
  pruned at append time (oldest first; `pending` reviews last). Their limits are
  configurable per deployment (`SessionLimits`) and checked on load, import and
  export.
- **Session guards.** `StateManager.guard` is a token that changes whenever the
  open idea changes. An orchestrator turn captures it and passes it back with each
  mutation, so opening another idea mid-turn fails that turn cleanly instead of
  writing its changes into a different idea.
- **Coalesced persistence** (`coalesceMs`, `flush()`), enabled by the UI at 400 ms
  with a `pagehide` flush and an `app.dispose()` for embedding pages.
- **Branch data model** (schema and pure functions only in this pass; the UI comes
  with the branching feature): `Branch` records, `branch_id` on every version,
  `branchLineage`, `branchVersions`, `commonAncestor`, `compareBranches`,
  `lineageSince`, `prunableVersions`, `suggestBranchName`.
- **`validateBranchIntegrity`**, checked before every commit: branch pointers,
  active branch, duplicate ids and duplicate names. `IdeaCaseBodySchema` cannot
  express these because the versions they point at live outside the body.
- **22 new regression tests** (`tests/hardening.test.ts`), one group per defect,
  each asserting the *behaviour* that was broken rather than the implementation
  that replaced it.
- **Turn-isolation and research-loop tests** (`tests/orchestrator.test.ts`), which
  needed the scripted provider to be able to defer a response: `ScriptedResponder`
  may now return a promise, because a concurrency bug cannot be reproduced with a
  synchronous test double at all.

### Fixed

- **Persistence was quadratic, and a long session became unsavable (D1/D2).**
  Measured on v0.1, one user-originated change per iteration: 2.7 ms/op at 50,
  4.1 ms at 100, 13.9 ms at 200, 26.3 ms at 400 — 10.5 s for 400 changes against
  0.47 s with persistence disabled. Two causes: every mutation re-parsed the
  *entire* workspace (all snapshots ever taken) through zod, and the whole
  workspace was one `localStorage` blob, which crosses the ~5 MB per-origin budget
  at about 170 edits. From that point on nothing could be saved at all, and the
  only copy of the idea was in that blob. After the fix: 2.4 / 3.2 / 7.8 / 13.7
  ms/op at the same four points.
  **Honestly stated:** the residual growth is still superlinear, because each
  commit deep-clones the body into a snapshot and each save serialises the whole
  record. v0.2 removes the *fatal* consequence (nothing saves) and cuts the
  constant factor roughly in half; it does not make the cost flat. Delta-encoded
  snapshots would, and are recorded as a recommendation rather than built.
- **The version cap threw mid-turn and lost the change it had just applied (D3).**
  `#pushVersion` raised `IdenoStateError('capacity')` *after* `#commit` had written
  the new state, so a successful change surfaced as a failure and no version
  recorded it. `MAX_VERSIONS` is now 400 (from 1000) and reaching it prunes the
  oldest dispensable snapshot instead of throwing.
- **The transcript could outgrow its schema bound, silently making the workspace
  unsavable (D4).** Reproduced: at 2001 entries `toWorkspace()` returned `null`,
  every subsequent save wrote nothing, and the only user-visible symptom was a
  generic warning. Same for the change log at 4001 entries (D5), which was also
  measured at 8.9 MB.
- **A session opened mid-turn received that turn's changes (D6).** Mutations
  resolved `this.#session` at call time while the turn held a reference from when
  it started.
- **Rejecting a queue serialised the workspace once per record (D7).**
  `rejectAllPending` now resolves every record, then persists once.
- **Stale reads inside a turn.** `#executeOperation` derived the question decision
  and the research scan from a body captured *before* the change set was applied,
  so both operated on the previous state — an unknown that the same turn resolved
  could still generate a question about itself. Both now re-read the live body.
- **A research question that was answered stayed open forever**, so every research
  turn re-queried the same question and spent the user's model budget retrieving
  the same findings. Questions that came back with usable findings are now marked
  `answered` in the same validated change set as the evidence, so the closure is
  reviewable and reversible like anything else. A question whose source returned
  nothing usable stays open.
- **A response arriving after cancellation was still applied.** Puter's `chat()`
  takes no abort signal, so a cancelled turn's response can land late; it is now
  dropped instead of mutating state nobody is watching.
- **`createBranch` handed back a `Branch` object that went stale immediately**,
  because `#switchTo` replaced `session.idea` wholesale. Restores and branch
  switches now assign field by field, so the object a caller holds stays live.
- **A flaky UI test.** With coalesced writes an app that was never torn down could
  still have a pending save when the next test cleared `localStorage`; the suite
  failed roughly one run in three. Apps are now tracked and disposed in
  `afterEach`, which is what an embedding page does anyway. Five consecutive full
  runs are green.

### Changed

- `createIdeaCase` takes an optional `root` (branch + version 0 pair from
  `createHistoryRoot`) and returns an `IdeaCase` as before; the pair is minted
  together because a branch points at its head version and a version records its
  branch, and minting them separately is how you get a branch whose head does not
  exist.
- `VersionRecord.snapshot` is nullable and `snapshot_pruned` was added. Callers
  that read a snapshot must handle its absence; `diffVersions` throws
  `MissingSnapshotError` rather than returning an empty diff, and `restoreVersion`
  refuses with an explanation.
- `LoadOutcome` / `OpenOutcome` carry migration notes, and `importJson` now adds
  the imported idea as a **new** session instead of replacing the open one, so
  importing a file cannot destroy the idea being worked on.
- `exportJson` validates in full (and refuses to write a file a future Ideno would
  reject); `toWorkspace` deliberately does not, because it is on the save path.
- `VersionTrigger` gained `'branch'`; `STATE_ERROR_CODES` gained
  `'session_changed'`.

### Added — Linux desktop host (`desktop/`, complete)

A new requirement arrived mid-release: **the stack must run on Linux machines as an
application, not only as a website, with Python and a web engine.** The answer is a
Python host around the same bundle rather than a second implementation of the
product: one artefact, two delivery mechanisms, and nothing in the UI that knows
which one it is running under.

- **`desktop/ideno_desktop`** — a Python package (`pyproject.toml`, `ideno` entry
  point, `python -m ideno_desktop`), Python 3.9+, runtime dependency `pywebview`
  (BSD-3) with the web engine left as an extra, because which of PyQt6-WebEngine or
  PyGObject+WebKitGTK to install is a fact about the user's machine and guessing
  wrong means pulling 200 MB of Qt into a system that already has GTK.
- **Modes**: window (default), `--browser` (loopback server plus the user's own
  browser, no engine needed), `--dev` (against `vite dev`, `--strictPort` so the
  window can never be pointed at whatever else answers on the announced port),
  `--build`, `--debug`, `--gui qt|gtk`, `--width/--height/--port/--data-dir`.
- **`--check`** reports the Python version, whether each engine is usable and what
  to install if not, whether the bundle is built, where npm/node are, and where
  ideas will be stored. It runs with no display and no engine installed, because
  the moment it is needed is the moment a window failed to appear.
- **XDG storage** (`~/.local/share/ideno/v1/workspace/`): one JSON document per
  idea plus a small index — the same layout the web app already writes, so the two
  modes read each other's data. Atomic writes (temp file, `fsync`, `os.replace`),
  owner-only files, and a failed write leaves the previous copy intact.
- **This removes the hard limit, not just the inconvenience.** Browser storage
  gives an origin ~5 MB; measured on this codebase, 30 user edits produce a 201 KB
  record, so a browser workspace becomes unsavable at roughly 170 edits. On disk
  the ceiling is the filesystem's.
- **Loopback static server** binding `127.0.0.1` only, `GET`/`HEAD` only (other
  methods get `501`), paths resolved and re-checked against the served root,
  explicit MIME types for the module bundle, immutable caching for hashed assets
  and `no-store` for the entry point, `nosniff` and `no-referrer` headers.
- **A six-method bridge** (`info`, `snapshot`, `read`, `write`, `remove`, `list`)
  exposed as `window.pywebview.api`, taking **keys, not paths**: `^[A-Za-z0-9._-]+$`,
  no `.` or `..`, re-validated after resolution. Nothing raises across it — every
  answer is `{ok, error?, kind?}` — and a full disk is reported as `kind: "quota"`
  so the web app's prune-and-retry recovery still applies on the desktop.
- **Protocol versioning both ways** (`PROTOCOL_VERSION` / `DESKTOP_PROTOCOL_VERSION`):
  a host and a bundle from different releases fail with a sentence naming both
  versions instead of corrupting a workspace.
- **`src/ui/desktop_bridge.ts`** — the only file in the TypeScript tree that knows
  the host exists. It produces a `Store`, so the State Manager, the settings store
  and the UI have exactly one persistence path. `initDesktopStore()` returns null in
  a browser, which is the common case and not an error.
- **78 Python tests** (`desktop/ideno_desktop/tests/`) that run **with or without
  pywebview installed**: the toolkit is imported inside the function that opens a
  window, never at module scope, and engine detection uses `importlib.util.find_spec`
  rather than a real import, because importing Qt with no display can abort the
  process. `test_serve.py` starts a real server on a real loopback socket and makes
  real HTTP requests.
- **17 TypeScript tests** (`tests/desktop_bridge.test.ts`) against a fake host
  speaking the same protocol: boot-time load, cache-served reads, ordered write
  mirroring, failure reporting, a host that dies mid-session, partial loads, and a
  State Manager writing ideas to the host as files.
- **Two new architecture rules**, one of which immediately caught two real
  violations in its own author's code: knowledge of the desktop host must stay
  inside `desktop_bridge.ts` and the composition root, and the core may not reach
  for `fetch`, `XMLHttpRequest`, `localStorage`, `require()` or a `node:` builtin
  (`state_manager/store.ts` is the named exception — it *is* the storage seam).
  Comment stripping is now block-aware, so a boundary rule cannot be defeated by
  reformatting.

**Verified by execution** on headless Linux with no display and no web engine:
`--check`; the refusal message and exit code 1 when no engine is usable; the real
built bundle served over loopback (index `200 text/html no-store`, JS
`200 text/javascript immutable`, CSS `200 text/css`, three traversal probes `404`
with nothing leaked, `POST`/`DELETE` `501`, missing file `404`, the lazily imported
Puter chunk reachable); `--browser` mode end to end including data-directory and log
creation; `pip install ./desktop` producing a working `ideno` entry point from an
unrelated working directory; all 78 Python and 320 TypeScript tests.

**Not verified, stated plainly:** that a window opens and renders. `$DISPLAY` and
`$WAYLAND_DISPLAY` are unset here and neither PyQt6 nor PyGObject is installed, so
`webview.create_window` / `webview.start` were never executed. They are written
against pywebview 6.2.1's signatures, read from the installed distribution rather
than from prose, and every failure path *before* them is tested — but "a window
appears and the UI works inside it" remains an unverified claim until it is run on a
machine with a desktop.

### Added — several ideas in one workspace (B1, complete)

- **`StateManager`** grew `listIdeas()`, `openSession(id)`, `archiveSession(id)`,
  `removeStoredSession(id)`, `closeSession()` and `activeSessionId`. One session is
  in memory at a time; the index is what the switcher renders, so listing ten ideas
  does not load ten ideas.
- **`closeSession()`** is the non-destructive half of what `resetSession()` does: it
  flushes and lets go of the open idea while everything stored stays put. "New idea"
  now calls that, and the confirmation dialog is gone — there is nothing left to
  confirm, because starting another idea no longer costs you this one. An idea is
  created when it is *stated*, not when a button is pressed, so `original_idea`
  stays the user's own words and the workspace never fills with empty ideas.
- **Archiving, not deleting.** An archived idea keeps its files, is listed behind a
  disclosure, and can be unarchived. The only destructive action remains the
  explicit "clear this browser's data" in Settings.
- **`src/ui/components/workspace.ts`** — the switcher: title, phase, version count,
  pending-review count and last-updated per idea, with the open one marked and
  un-openable.
- **`listIdeas()` reflects the open idea from live state, not from storage.** Found
  by a test: writes are coalesced, so the stored index can lag the session in memory
  by a few hundred milliseconds, and a switcher built from storage alone showed a
  stale title, phase and review count for the idea the user was actually looking at.
  Every other idea is still read from storage, which is the only place it exists.

### Added — branching version history (B2, complete)

- **Fork, switch, label, archive, compare.** `createBranch`, `switchBranch`,
  `renameBranch`, `setBranchDescription`, `archiveBranch`, `labelVersion`, plus the
  pure functions in `core/versioning/branch.ts`.
- **A fork copies nothing.** A branch is a named pointer at an existing version, so
  two timelines share every snapshot below the fork. That is what makes branching
  affordable inside a storage budget, and it is why the panel says "nothing was
  copied" when you fork.
- **Switching branches creates no version**, because nothing about the idea changed
  — only which point in its history is being looked at. The branch you came from
  keeps its own tip, so switching back returns you exactly where you were.
- **Comparison runs from the divergence point**, not between two tips. Diffing two
  tips would list everything the *other* branch did as though it were missing here,
  which reads as nonsense; `compareBranches` finds the merge-base and says in the UI
  which version that was.
- **Per-branch numbering for reading (`main#3`), globally monotonic numbering for
  ordering.** The displayed position is derived, not stored: two stored numbers for
  one fact would eventually disagree.
- **Archiving the last open branch is refused** — an idea always needs somewhere to
  continue from — and archiving the branch you are on switches you to another first.
- **Labels protect versions from pruning**, and the tooltip says so, which gives the
  user a way to keep a snapshot they care about.
- **Inline editors instead of `window.prompt`.** This was a portability defect
  waiting to happen: jsdom returns `undefined` from `prompt`, and an embedded web
  engine may never show a dialog at all, so labelling and forking would have worked
  in a browser and silently done nothing in the desktop window. `openInlineEditor`
  behaves identically in every host, keeps Enter/Escape local to the field, stops
  the row's own click handler from firing while you type, and is testable.

### Added — streaming responses (B3, complete)

- **`AIProvider.completeStream?()`** — optional, returning
  `{ chunks: AsyncIterable<StreamChunk>, model, provider_id }`. A provider that
  cannot stream is still a fully valid provider: the runtime asks for the *method*,
  not for the advertisement in `capabilities()`, and falls back to `complete` when
  either is missing.
- **`AIRuntime.completeStreaming`** assembles the whole document and hands it to the
  same extraction, schema validation and repair round-trip as a non-streamed call.
  **Streaming changes what the user sees while waiting and nothing else** — a
  half-arrived document can never reach the Idea State, and a test asserts exactly
  that by streaming a response whose prefix is a valid but wrong plan.
- **Progress is throttled** to 120 ms, with one unthrottled report at the end of the
  stream. Without that final report a response arriving in under the interval
  reported only its first chunk — the one with the least in it — so the preview was
  a description of nothing. Found by test.
- **`parsePartialJson`** closes what is still open (strings, brackets), discards a
  dangling `"key":` or trailing comma, and trims a character at a time within a
  bounded budget. It reports `complete` separately, and never claims a prefix is
  complete — that is the one assertion a caller might act on.
- **`reasoning/preview.ts`** turns a partial plan into one sentence: "Proposing 2
  constraints, 1 unknown…". It only reports what the partial document already
  contains, uses "proposing"/"proposed" and never "added" or "recorded", because at
  that point nothing has been applied and the human has reviewed nothing.
- **Puter streaming**, written against the shipped declarations of
  `@heyputer/puter.js@2.6.4`: `chat(messages, {stream: true})` resolves to
  `AsyncIterable<ChatResponseChunk>`, and each chunk carries a `type` discriminator.
  Text and reasoning are mapped; `usage` becomes a `finish` chunk; `compaction`,
  `image` and `tool_use` are dropped rather than forwarded, because a consumer that
  had to know about them would not be provider-neutral. An `error` chunk ends the
  stream as a failure — a stream that stopped early and reported success would hand
  the runtime a truncated document to validate.
- **Cancellation during a stream.** Obtaining the iterable is raced against the abort
  signal and the iteration checks it between chunks. The upstream request still
  cannot be revoked, which remains a Puter limitation with a billing consequence.
- **Scripted streaming** (`streaming: { chunks, chunk_delay_ms }`) so the whole path
  is testable offline. A provider that cannot deliver text in pieces cannot exercise
  the code that handles text arriving in pieces. `splitIntoPieces` never cuts a
  surrogate pair.
- **UI**: the thinking indicator gains a visibly provisional second line, in its own
  element, italic and muted, with a tooltip saying it is not yet validated. It is
  cleared on `turn_complete` *and* on failure, so a stale "proposing…" can never
  outlive the turn it described.

**Not done, deliberately:** the OpenAI-compatible provider does not stream. Its
`FetchLike` test seam exposes `text()` and `json()` but no readable body, and adding
SSE parsing would mean changing that seam. The provider reports
`streaming: false` and the runtime falls back, which is the abstraction working as
designed rather than a gap in it. Recorded as a recommendation.

### Added — a Three.js renderer for the canonical representation (B5, complete)

- **`three@0.186.1`** (MIT) added as a dependency and **`@types/three@0.186.0`**
  (MIT) as a dev dependency — Three.js ships no declarations of its own, verified by
  inspecting the installed package rather than assumed. `npm audit`: 0 vulnerabilities.
- **`src/render/layout.ts`** — a renderer-independent, deterministic placement pass:
  canonical scene → positioned objects in millimetres, links, bounds, notes. This is
  where "how big is this, and where does it go" is decided, so a future SVG diagram or
  OpenSCAD exporter inherits the same arrangement instead of inventing another one and
  disagreeing with the 3D view.
- **`src/plugins/renderers/three.ts`** — the plugin: boxes, cylinders and spheres from
  resolved dimensions; wireframe bounding volumes for `assembly` and `custom`, whose
  shape is genuinely not stated; colour-coded connections by kind; a ground grid scaled
  to the bounds; orbit controls; resize observation; and disposal of every geometry,
  material, control, render loop and context.
- **Geometry is coloured by how completely it was specified**: solid when every axis
  was given, semi-transparent when an axis had to be filled in, wireframe red when no
  dimension could be read at all. The difference between "this is 400 mm wide" and
  "Ideno does not know how wide this is" is visible without reading a note.
- **A missing axis is filled from the smallest known one**, and named in the notes.
  That is the conservative direction: a balcony constraint is violated by drawing
  something too big, not too small.
- **Connections are lines, not pipes.** A pipe has a diameter and no diameter was ever
  stated, so drawing one would put a number in front of the user that exists nowhere in
  the idea.
- **Three.js is loaded only when the 3D view is opened.** Verified in the production
  build, not assumed from the config: `three.module-*.js` is a separate 737 KB chunk
  (187 KB gzipped) with `OrbitControls` separate again, and the main app chunk grew
  only from 290 KB to 302 KB — the plugin glue, referencing the library lazily.
- **The mount element is owned by the application, not by the component.** Panels here
  re-render wholesale, and a WebGL context cannot survive being rebuilt on every state
  change: browsers cap the number of live contexts and the failure presents as a blank
  canvas with no error. The mount is created once and *moved* into the panel, so the
  canvas and its context survive; the viewer is disposed on toggle-off, on idea switch
  and on teardown.
- **The 3D view is offered alongside the canonical JSON, not instead of it.** A drawing
  is a claim about the idea; the scene it was projected from stays on screen so the
  claim can be checked.
- **WebGL availability is probed before any Three.js constructor runs**, so an engine
  built without WebGL gets a sentence explaining itself and a pointer to the same data
  in another form, instead of an exception from inside a library.

**Not verified, stated plainly:** that the 3D view draws correctly. This environment has
no GPU and jsdom has no WebGL, so the tested surface is the layout mathematics, the
plugin's registration, its failure paths, and its teardown — not pixels. The layout is
where every modelling decision lives, and it is tested directly; the drawing of it is
not.

### Added — real research sources (B4, complete)

v0.1 had a research registry, a gap analysis and an evidence pipeline, but no source
to feed them — every research turn honestly said "no source is registered". Two now
exist, and the bar for both is the one the pipeline was built for: **nothing is
recorded that was not retrieved.**

- **`src/research/sources/wikipedia.ts`** — provider-neutral, so it lives in
  `src/research`. Uses the **Action API** (`/w/api.php`) rather than the REST API,
  because MediaWiki's own documentation shows the Action API being called from browser
  JavaScript with `origin=*`, while its REST API examples are server-side `requests`
  calls. The choice is about which endpoint's *cross-origin* use is documented, not
  style. Anonymous (`origin=*`), no account, no key.
  One request per question via `generator=search` + `prop=extracts|info`, returning the
  lead section, the canonical URL and the revision.
- **Permanent citations where possible**: `?oldid=<lastrevid>`, which points at the
  exact revision the extract came from. Never appended to a URL that already carries a
  query, because two `oldid`s would cite something other than what was read. Without a
  revision the plain article URL is used — a real URL to the current revision beats a
  constructed guess at an old one.
- **Confidence is capped at 0.45** for Wikipedia. That is not an estimate of how
  reliable Wikipedia is; it is a statement about how much of the source was read. Four
  sentences cannot support a claim as strongly as the article they came from, and the
  relevance text says so in terms.
- **`src/ai/research/puter_web_search.ts`** — provider-specific, so it lives in
  `src/ai`. Calls `puter.ai.chat` with `tools: [{ type: "web_search" }]`, capped at
  confidence 0.6.
- **No citation, no finding.** Puter documents the tool; OpenAI documents that answers
  carry `annotations` of type `url_citation`; Puter's *shipped* `ChatMessage`
  declaration has no `annotations` field, and the array is frequently empty in
  practice. So annotations are read as `unknown` from every place either API puts them
  (the message, a content block, the top level), validated, and an empty array yields
  zero findings plus the sentence *"an uncited answer is a model suggestion, not
  research"* — never a synthesised citation.
- **A citation is only accepted if its `start_index`/`end_index` span actually appears
  in the returned text.** That catches the case a real URL cannot: a citation attached
  to a claim the source did not make. Non-`http(s)` URLs, missing titles, spans that
  are absent, out of order, out of range, fractional, or too short to be a claim are all
  dropped individually and each drop is reported.
- **The model gate is checked before any call.** `web_search` is documented for
  OpenAI-routed models, so with any other model the source returns zero findings and a
  reason *without calling the model* — otherwise the tool would be ignored and the
  answer would look like an ordinary uncited response, which is indistinguishable from
  a source that found nothing.
- **Settings**: `research.wikipedia` (default on — the only source that works the
  moment Ideno is opened) and `research.puter_web_search` (default off — it only
  produces anything with the right provider *and* model *and* sign-in). The Settings
  panel states what each one sends and where, and what it needs, rather than letting a
  user discover the preconditions by getting nothing back.
- **`syncResearchSources` in `src/ai/factory.ts`**, beside `createAIRuntime`, for the
  same reason: it is the one module allowed to know which concrete implementations
  exist. The composition root calls it and names no provider — the architecture test
  that enforces this failed on my first attempt, which put the wiring in `app.ts`, and
  moving it was the fix rather than an exemption. Plugin-registered sources are left
  alone, so a third-party research plugin survives a settings change.
- **Schemas validate shape, not values.** A page with an empty title or a citation with
  an empty URL is skipped individually; a strict `min(1)` would have failed the whole
  response and cost every other page that was fine. Found by test, and it is the kind of
  mistake that only shows up against a real service returning one odd row.

**Not verified, stated plainly:** neither live service was reached. This sandbox has no
route to `en.wikipedia.org` or `api.puter.com`, so no request in either source has ever
been observed succeeding against the real thing. Both are tested against injected
transport (a fake `fetch`, a fake SDK) covering the documented response shapes and every
failure mode I could enumerate. The parsing is defensive *because* of that, not in spite
of it — and if a real response arrives in a shape neither source expects, the result is
a thrown error or zero findings with a sentence, never a plausible-looking fabrication.

### Changed — the web app now asks

- `Store` gained a third kind, `desktop_file`, because "will this survive a reload?"
  has a different answer on disk than in memory and the UI says so.
- `StateManager.setStore(store)` moves persistence without losing the open session:
  the pending coalesced write is flushed to the *old* store first, so nothing is
  dropped by the switch, and the session is written to the new one immediately.
- `App.dispose()` is now async and awaits the host's outstanding writes; `app.start()`
  adopts desktop storage before reading anything, so a run has exactly one
  authoritative storage location.

### Fixed — found while building the above

- **Saved research preferences were ignored on the desktop until Settings was opened.**
  The app registers sources in its constructor, but on the desktop the real settings are
  not readable until after it — so a user who had switched Wikipedia off would have it
  consulted anyway. Settings are now re-synced once the desktop store is adopted.

- **`el()` ignored `value` on `<option>`.** Every option in a generated `<select>`
  therefore carried an empty value, so the branch switcher could not tell which
  branch had been chosen. The helper now sets `value` for `option` as it already did
  for `input`, `textarea` and `select`.
- **`archiveBranch` archived nothing.** It captured the `Branch` object, then called
  `#switchTo`, which rebuilds the case body through the schema and replaces the
  `branches` array with fresh objects — so the flag was set on a detached copy. The
  flag is now set *before* the switch. This is the same stale-reference class of bug
  as the one `createBranch` had, and it is the reason both are now covered by tests
  that assert the state after the call rather than the return value.
- **The branch comparison never appeared.** The compare `<select>` mutated the view
  object without asking for a re-render, so the panel was a pure function of inputs
  that one control was editing behind its back. Comparison is now an action
  (`onCompare`) like every other control in the panel.

### Status of the v0.2 plan

All five features (B1–B5) and the whole hardening pass (A1–A5) are implemented, with
the Linux desktop host added on top. What remains is recorded as recommendations rather
than built, because each is a separable piece of work and none is required by the brief:

- Delta-encoded version snapshots, to make persistence cost flat rather than
  superlinear (see D1/D2 above for why the current fix is necessary but not sufficient).
- Streaming for the OpenAI-compatible provider, which needs its `FetchLike` test seam
  widened to expose a readable body.
- A `.desktop` entry, an AppImage or Flatpak manifest, and a single-instance lock, so
  the desktop app can be launched from a menu rather than a terminal.

### Verification of the shipped artifact

Everything above is verified against `src/` through vitest. That leaves a gap: the
production bundle is a different artifact — Rollup chunking, dynamic-import
resolution and Three.js's CJS/ESM interop (which emits a build warning) only exist
in `dist/`.

The built bundle was therefore booted directly: `dist/index.html` loaded in jsdom,
the entry chunk imported from disk, and the five-step acceptance scenario driven
through the real DOM of the *built* app. It passed — start screen rendered, demo
entry point found among 9 buttons, all five steps completed, the balcony and
no-cloud constraints present, both alternatives present, the step-5 decision
carrying `Your decision` provenance, 5 user and 5 Ideno messages, and the History
and Spec tabs both rendering. No `window` errors were raised.

This is a throwaway harness, not a committed test: it depends on jsdom shims
(`ResizeObserver`) and on Node-global patching that would be fragile in the suite.
It is recorded here because the result matters, not because the script does.

**Still not verified, unchanged:** a real browser engine was never used (no Chromium
in this environment, and its shared libraries cannot be installed — Debian mirrors
are unreachable, egress is allowlisted to npm). So WebGL rendering, the Puter sign-in
popup, and browser-native `localStorage` quota behaviour remain unproven.

### Repository note

The sandbox this is being developed in re-cloned from `origin` **three times** during
the release. Each time the local commits were discarded; each time the files survived
in the working tree. The first two resets lost the eight granular v0.1 commits and
then the five v0.2 feature commits, so this release is recorded in two commits
(`a5bb8cd`, `d32592b`) on top of the initial one. The granular history could not be
recovered.

After the third reset the branch was restored from `origin` with
`git update-ref` + `git reset --mixed`, which moves the ref and the index without
touching the working tree — no files at risk. **The lesson, recorded so it is not
relearned: push after every coherent commit.** Unpushed local history in this
environment should be treated as provisional.

## 0.1.0 — 2026-10-05

First working prototype. The repository previously contained only a `README.md`
with the project name; everything below is new.

### Scope of this release

Prove that the core innovation works: a **persistent, structured, evolving
representation of an idea**, with intelligence built around it rather than a chat
window with a sidebar. The MVP acceptance scenario (§15 of the brief) runs end to
end and is covered by a test.

### Added — core Idea State

- **Canonical schemas** (`src/core/schemas/`) as the single definition of the
  state: eleven collections (requirements, assumptions, constraints, unknowns,
  evidence, research items, alternatives, decisions, rejected approaches, open
  questions, critique findings), plus `IdeaCase`, `VersionRecord`, `Session`,
  `Workspace` and `Settings`. Types are inferred from the schemas, so there is no
  second definition to drift.
- **Provenance model** with six epistemic labels — `user_stated`,
  `model_inferred`, `unknown`, `evidence_supported`, `model_suggestion`,
  `user_decision` — on every item, and a narrower `ModelClaimableProvenance` that
  structurally prevents a model from awarding itself `user_decision`.
- **`findings` collection.** The brief's canonical list is a minimum; critique
  output such as a contradiction between two recorded items has no honest home in
  any of the other collections, so it got one.
- **Collection registry** (`idea_state/collections.ts`): labels, per-collection
  schemas, terminal statuses, closed-status set, item lookup by id, and one
  display-text mapping. Diffing, applying, context building, projection and the UI
  all walk the state through it.
- **Derived views** (`idea_state/selectors.ts`): `deriveCurrentState` (phase
  computed from data, never asserted by a model), `rankUnknowns` (impact → blocked
  area count → age), `computeStats`, `openFindings`, and `decideQuestion`.
- **Injectable clock and id minting** (`core/ids.ts`) so version histories are
  byte-reproducible in tests.

### Added — state manager and versioning

- **`StateManager`**, the only component permitted to mutate an idea: session
  lifecycle, transcript, change enqueueing, review resolution, user-initiated
  actions (evidence, decisions, selection, unknown resolution), version restore,
  export/import, subscriptions and persistence.
- **Two-stage change pipeline** (`state_manager/apply.ts`):
  `buildChangeRecords` normalises a change set through its own schema, mints every
  id, resolves `temp_id` evidence citations, prunes references to ids that do not
  exist, and derives provenance; `applyRecords` writes records into a clone one at
  a time and re-validates the whole body before commit.
- **Review policy** with two modes: `assisted` (default — what the user said
  applies, what the model inferred waits) and `strict` (everything waits). Changes
  the user made directly are never queued.
- **Versioning**: a full snapshot per version, `parent_id` links (branching-ready),
  summaries derived from an actual diff, append-only history, and restore as a new
  version.
- **Field-level diffing** (`versioning/diff.ts`) across scalars and all eleven
  collections, ignoring bookkeeping fields (`id`, `created_at`, `updated_at`), with
  a one-line human summary.
- **Persistence**: `Store` interface, `LocalStorageStore`, `MemoryStore`, and a
  boot-time probe so Safari private mode degrades to memory with a warning instead
  of breaking. Workspaces carry a `schema_version`; corrupt or newer data is
  reported and left untouched.

### Added — AI layer

- **`AIProvider` interface** (`ai/provider_interface/`): messages, capabilities,
  availability with a suggested user action, model catalogue, completion, optional
  sign-in and an optional per-session `reset` (declared on the interface so the UI
  never has to import a concrete adapter to call it).
- **`AIRuntime`**: builds the output contract from the same zod schema it validates
  against (`z.toJSONSchema`), enforces a wall-clock timeout with cooperative
  cancellation, extracts JSON, validates, and performs **one repair round-trip**
  that feeds the validation issues back to the model. Failure leaves the state
  untouched and carries the raw text for the UI.
- **JSON extraction** (`ai/runtime/json_extract.ts`): direct → fenced (including an
  unterminated fence) → balanced spans (nested scanning, string-aware) → trailing
  comma repair. Reports precisely why it failed, with a bounded excerpt.
- **Typed failures** (`ai/errors.ts`): ten error codes, each with a user-facing hint
  and a retryability classification, plus one normaliser for the inconsistent shapes
  providers reject with.
- **Puter adapter**: dynamic import (separate lazy chunk), `normalize: true`,
  defensive text extraction for both string and content-block responses, sign-in
  flow, model catalogue mapping, promise-race cancellation.
- **OpenAI-compatible adapter**: works with OpenAI, OpenRouter, Azure, vLLM,
  llama.cpp, LM Studio and Ollama; optional native JSON mode; HTTP status →
  typed error mapping; `FetchLike` seam for tests.
- **Scripted adapter**: deterministic responses with optional latency and error
  injection. Powers the test suite and the labelled offline demo.
- **Factory** (`ai/factory.ts`): the only file that knows concrete providers exist.

### Added — reasoning

- **Structured context** (`reasoning/context.ts`): a compact, id-carrying state
  digest with abbreviated keys and a legend, three degradation levels under a
  character budget (ids and provenance are never dropped), a bounded transcript
  window, and a digest of pending changes so Ideno does not re-propose them.
- **Operation prompts** (`reasoning/prompts.ts`): one core system prompt encoding
  the product's rules (human decides; honest epistemics; never fabricate; at most
  one question; contradictions must be surfaced; no chain-of-thought) plus
  per-operation instructions for `understand`, `update`, `critique`, `explore`,
  `research` and `decision`.
- **`prepareOperation`**: pure function from state + conversation to the exact
  messages a provider receives, so the whole prompt surface is testable without a
  model.

### Added — orchestrator

- **Turn loop**: derive the operation from the state, check provider availability
  (attempting one interactive sign-in when that is the only blocker), call the
  runtime, validate, enqueue, decide the question, reply, then run up to two
  follow-up operations **against the state the first one produced**.
- **Question discipline in code**: low-impact, already-asked and already-resolved
  questions are suppressed, and the suppression is recorded.
- **Failure containment**: a turn stops at the first failure; the human sees a
  system notice with the error code, the hint, and (for malformed responses) the
  unusable model text behind a disclosure.

### Added — research, rendering, plugins

- **Evidence pipeline** with `claim / source / relevance / confidence / timestamp`,
  origins `user_supplied | research_source | model_recall`, and the rule that only
  the first two can earn `evidence_supported`.
- **`ResearchSource` interface + registry + `runResearch`** with per-source failure
  isolation, and `analyzeEvidenceGap` listing what the idea rests on that nobody has
  checked.
- **The research path is wired live, not just declared.** A `research` turn queries
  every registered source over the highest-priority open questions, converts the
  findings into evidence drafts, merges them into the same validated batch as the
  model's proposal, caps them at the per-turn evidence limit, and reports retrievals,
  discards and per-source failures as integrity notes. With no source registered it is
  a no-op, and the model has already been told not to invent evidence.
- **Canonical representation** (`render/canonical.ts`): unit parsing and
  normalisation to millimetres, `CanonicalScene` (objects, resolved connections,
  sourced constraints), and a conservative projection that reports everything it
  could not resolve.
- **Plugin registry** with seven capability slots, read-only state access, research
  source and renderer registration, isolated activation failures — and no mutation
  hook, so no plugin can bypass provenance, review or versioning.

### Added — UI

- **Two-pane application**: conversation on the left, live Idea State on the right
  with tabs for State, Review, History and Spec.
- **Safe DOM builder** (`ui/dom.ts`). There is no `innerHTML` in the codebase; text
  only reaches the DOM through `textContent`. Evidence locators become links only
  when they parse as `http(s)`.
- **State panel** with provenance markers on every item, per-collection metadata
  chips, closed items shown struck through rather than hidden, **proposals rendered
  in place with Accept / Reject**, alternative selection, inline unknown resolution,
  and an inline **Add evidence** form that refuses to record a claim without a title,
  a locator and a relevance — because an unsourced claim is a suggestion, not
  evidence.
- **Review queue** in the shape the brief specified: change kind, the quoted change,
  an "Affected:" list of areas and items, the rationale, and Accept / Reject — plus
  Accept all, Reject all, and a "recently decided" audit trail including rejections
  with their reasons.
- **History tab**: versions newest-first with trigger and time, a diff of the
  selected version against its parent grouped by collection, per-field before →
  after, and restore with confirmation.
- **Spec tab**: the projected canonical scene as JSON, everything that could not be
  projected, registered plugins, and the evidence-gap summary.
- **Start screen** with the provenance legend, provider status, the labelled offline
  demo, and export/import of the workspace.
- **Settings split**: `core/schemas/settings.ts` holds behaviour (review mode,
  temperature, timeout, context window) and `ai/settings.ts` holds provider ids and
  endpoint configuration, with persistence in `ai/settings_store.ts`. The orchestrator
  is typed against `BehaviourSettings`, so it cannot see a provider field — which is
  what makes "the core contains no provider-specific logic" checkable rather than
  aspirational.
- **Settings modal**: provider selection, Puter model catalogue (with a text
  fallback), OpenAI-compatible base URL / model / key, native JSON mode opt-in,
  explicit key-persistence opt-in with its trade-off stated, review policy,
  temperature, timeout and context window.

### Added — demo, tests, docs

- **Scripted greenhouse scenario** (`src/demo/greenhouse.ts`): five turns that read
  the live state so later turns can reference ids earlier turns created — including
  component graphs for all three alternatives.
- **275 tests across 12 suites**, covering schemas, derived views, the state
  machine, diffing, the orchestrator (including the full MVP scenario and every
  failure mode), JSON extraction, both real provider adapters, the runtime,
  research integrity and the live research turn, canonical projection, the plugin
  surface, the rendered DOM in jsdom (including a full app boot that runs the demo
  and one that records evidence through the UI), and the architecture itself.
- **Architecture tests** (`tests/architecture.test.ts`) that read the sources and
  fail if a provider name reaches `src/core` or `src/reasoning`, if a concrete
  adapter is imported outside `src/ai`, if the Puter SDK is imported statically, if a
  core state module imports upward, if the reasoning layer touches the DOM, or if any
  UI file assigns to `innerHTML`.
- **Documentation**: this changelog, `README.md`, `docs/ARCHITECTURE.md`
  (structure, invariants, decisions and rejected alternatives),
  `docs/RESEARCH.md` (verified sources, and what could not be verified), and
  `AGENT-EXPERIENCE.md`.

### Fixed during development

Defects found by tests while building, recorded because each one changed a design:

- **Draft union coerced constraints into requirements.** An untagged union of draft
  schemas matched the first member that accepted `{text}`, silently dropping
  `category` and `hard`. Replaced with kind-dispatched validation
  (`DRAFT_SCHEMA_FOR_KIND` + a schema refinement) and a normalising parse of the
  whole change set.
- **Circular schema inference** between `IdeaCase` and `VersionRecord` made
  TypeScript infer `any`. Restructured into an acyclic `IdeaCaseBody →
  VersionRecord → IdeaCase`, removing the need for `z.lazy`.
- **`AnyItemStatusSchema` omitted alternative and evidence statuses**, so an
  alternative could not be marked `selected` through a generic update and evidence
  invalidation only worked by accident.
- **A question asked before its open-question item was accepted stayed `unasked`**,
  so it could be asked again. Asked questions are now derived from the transcript at
  apply time.
- **A valid update carrying one field illegal for its collection was discarded
  whole.** Updates now apply the legal fields, report the ignored ones, and only
  fall back when nothing legal remains.
- **The conversation rendered every message twice** after the pane was re-attached,
  because a render counter desynced from the DOM. The DOM is now the counter.
- **The start screen's button never enabled while typing**, because the draft
  updated without syncing the button. Fixed without re-rendering the screen, so the
  caret stays put.
- **A flow rate was recorded as a dimension** in the demo's pump component. The
  canonical parser correctly refused to treat "200 mL/min" as a length; the data was
  moved to `properties` rather than the parser being loosened.
- **Sentence splitting used a lookbehind regex**, a parse-time `SyntaxError` on
  Safari < 16.4 that would have taken the whole bundle down.
- **A rejected approach the user rejected was queued for the user's approval.**
  Provenance for rejections now follows who rejected them.

### Known limitations

See `README.md` → "What v0.1 deliberately does not do". In short: no automated
research source ships; Puter sign-in can be blocked in a cross-origin iframe;
Puter requests cannot be cancelled upstream; one idea at a time; full snapshots per
version; no live-provider smoke test was possible from the build sandbox.

<!-- No release link yet: v0.1.0 has not been tagged on the remote. -->
