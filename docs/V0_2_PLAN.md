# Ideno v0.2 — hardening pass plus the hybrid increment

Status: **complete.** Part A (hardening, A1–A5), Part B (B1–B5) and the Linux desktop
host added mid-flight are all implemented, tested and documented. `CHANGELOG.md`
records what actually shipped, including the measurements behind each fix and what was
*not* verified; `docs/ARCHITECTURE.md` §8 records what each addition actually touched
versus what v0.1 predicted.

A requirement was added after this plan was written and is now delivered: Ideno must
run on Linux machines as an application, with Python in the stack and a web engine as
the renderer, not only as a website. It is described in `desktop/README.md` and in
the 0.2.0 changelog entry. It is not a sixth feature alongside B1–B5; it changes what
B1 is for, because on the desktop the storage ceiling that motivated the split layout
disappears entirely.

The user asked for two things in one go:

1. **A deep self-review / hardening pass** — fix real defects only, no new features.
2. **A v0.2 that is a hybrid of all five recorded candidates** — version branching,
   streaming, a real research source, a Three.js canonical renderer, and a
   multi-idea workspace.

They are not independent. Three of the five features (multi-idea, branching,
research) all change what gets persisted, and the hardening pass found that
persistence is the weakest part of v0.1. So the work is ordered: fix the
foundation, then build on it.

---

## Part A — Hardening (defects found by execution, not by reading)

Every item below was reproduced in a scratch test before it was accepted as a
defect. Reproduction numbers are recorded here so the fix can be checked against
them.

### A1. Persistence is quadratic, and a long session becomes unsavable

Measured with `MemoryStore`, one user-originated change per iteration, persist on:

| iterations | per-op cost | persisted bytes | versions |
|---|---|---|---|
| 50 | 2.7 ms | 474 KB | 51 |
| 100 | 4.1 ms | 1.7 MB | 101 |
| 200 | 13.9 ms | 6.5 MB | 201 |
| 400 | 26.3 ms | 6.6 MB | 201 |

The same 400 iterations with `persist: false` take 473 ms instead of 10 537 ms.
Two causes, both in the v0.1 design:

- `#persist()` calls `toWorkspace()`, which re-parses the **entire** workspace —
  every version snapshot ever taken — through `WorkspaceSchema` on every single
  mutation. Cost is O(total history) per mutation, i.e. quadratic overall.
- The whole workspace is stored as **one** `localStorage` blob under
  `ideno.workspace.v1`. Browsers give an origin roughly 5 MB, so a session of
  about 170 user edits cannot be saved at all.

Fix:

- Keep full zod validation where it is a real gate — on load, on import, and on
  export. On the hot path, serialise directly; the state is already
  schema-valid by construction because `#commit` validates the body it writes.
- Split storage into `ideno.workspace.index.v2` (small: id, title, phase,
  timestamps) plus `ideno.session.v2.<id>` per idea. Only the open session is
  ever loaded or written. This is also the prerequisite for multi-idea (B1).
- Quota-aware recovery: on a write failure that looks like a quota error, prune
  the oldest dispensable version snapshots and retry, telling the user what was
  dropped. Only when that still fails does persistence degrade to a warning.

### A2. `MAX_VERSIONS` throws mid-turn and loses the change that was just applied

`#pushVersion` throws `IdenoStateError('capacity')` after `#commit` has already
written the new state, so the user sees a failure for an operation that
succeeded, and no version records it. Fix: prune the oldest *unlabelled,
non-head* snapshot and continue. History stays complete as a list of versions;
only the pruned snapshots are no longer diffable, and each pruned version is
marked so the UI says so instead of showing an empty diff.

### A3. Unbounded transcript / change log silently make the workspace unsavable

Reproduced: after 2001 transcript entries, `toWorkspace()` returns `null`
(the `SessionSchema` caps are `2000` and `4000`) and every subsequent save
writes nothing. The user loses the whole idea on reload with only a generic
warning. Fix: bound both collections at append time by pruning the oldest
entries, keep every `pending` change record, and emit one integrity notice the
first time pruning happens.

### A4. A session switch during an in-flight turn writes into the wrong idea

`Orchestrator.#runTurn` holds a reference to the session it started with, but
`StateManager` mutations resolve `this.#session` at call time. If the user opens
another idea while a turn is in flight, the turn's changes land in the newly
opened session. Fix: `StateManager` exposes a `guard` token that changes when
the active session changes; a turn captures it at the start and every mutation
it performs is checked against it, failing the turn cleanly instead of
cross-contaminating two ideas.

### A5. Smaller correctness and cost fixes

- `#executeOperation` reads `bodyOf(idea)` from a reference captured *before*
  the change set was applied, so `decideQuestion` and the research scan operate
  on stale state. Re-read after applying.
- `#gatherResearch` scans `body.research_items` captured before the model call;
  re-read from the live state.
- `rejectAllPending` commits and persists once per rejected record (a full
  serialisation each). Batch it into one pass and one persist.
- Research that retrieves findings never marks the research item `answered`, so
  the same question is re-queried on every research turn. Close the loop.

---

## Part B — v0.2 features (the hybrid)

The five candidates are built as one coherent increment rather than five
isolated ones. The story they tell together:

> Several ideas live in one workspace. Each idea has a branching version
> history, so an alternative can be explored as its own timeline without
> losing the one it forked from. While Ideno thinks, you see what it is
> forming. When it researches, it retrieves from real sources and records only
> citations that survive verification. And when an alternative has geometry,
> you can look at it in 3D — projected from the canonical representation, never
> from prose.

### B1. Multi-idea workspace

- Storage layout from A1: index + per-session records, `WORKSPACE_SCHEMA_VERSION = 2`.
- Migration: a v1 blob (`ideno.workspace.v1`, single session) is read, converted
  to the v2 layout, and left in place until the first successful v2 write. A
  corrupt session is reported and skipped, not fatal to the rest.
- `StateManager`: `listIdeas()`, `openSession(id)`, `newSession(idea)`,
  `archiveSession(id)`, `activeSessionId`. One session is in memory at a time;
  the index is what the switcher renders.
- UI: idea switcher in the header, "New idea" from the start screen and from the
  switcher, archive (never silent deletion).

### B2. Version branching

- `BranchSchema` on the case body: `id`, `name`, `parent_branch_id`,
  `head_version_id`, `created_at`, `archived`, `description`.
- `VersionRecord` gains `branch_id`, an optional `label`, and a nullable
  snapshot (A2's pruning marker).
- Per-branch version numbering for display; the stored `number` stays globally
  monotonic so ordering never depends on which branch you are looking at.
- Operations: `createBranch`, `switchBranch`, `renameBranch`, `labelVersion`,
  `archiveBranch`, `compareBranches`, `lineage`, `commonAncestor`.
- Switching a branch loads that branch's head snapshot — it does not create a
  version, because nothing about the idea changed.
- Migration adds a single `main` branch containing the existing linear history.
- UI: branch selector and fork action in the Versions panel, labels, and a
  branch-vs-branch diff reusing `diffBodies`.

### B3. Streaming

- `AIProvider.completeStream?(request): AsyncIterable<StreamChunk>` — optional, so
  a provider that cannot stream is still a valid provider and the runtime falls
  back to `complete`.
- `AIRuntime.structured` accepts `on_progress`, streams when the capability and
  the method are both present, and still validates the **full** accumulated text
  before anything touches the state. Streaming changes what the user sees while
  waiting; it never changes the mutation contract.
- `parsePartialJson` produces a best-effort view of an incomplete document and
  reports `complete: false`. Used for the live preview only, never for state.
- Orchestrator emits `preview` events; the conversation pane shows what is
  forming ("adding 2 constraints, 1 unknown…") and then the real reply.
- The scripted provider gains chunked delivery so this is tested without a network.

### B4. Real research sources

Two adapters behind the existing `ResearchSource` interface, both verified
against documentation rather than assumed:

- **Wikipedia** (`src/research/sources/wikipedia.ts`) — REST endpoints
  (`/w/rest.php/v1/search/page` and `/api/rest_v1/page/summary/<title>`)
  documented as CORS-enabled. Deterministic, no sign-in, testable with a stubbed
  `fetch`. Findings carry the page URL as locator and are capped at a modest
  confidence because a summary is not a full read of the source.
- **Puter web search** (`src/ai/research/puter_web_search.ts`) — Puter documents
  `tools: [{ type: "web_search" }]` for OpenAI models, and OpenAI documents
  `annotations[].url_citation { url, title, start_index, end_index }`. The SDK's
  `ChatMessage` type has no `annotations` field, so the payload is read as
  `unknown` and validated by a zod schema. **Nothing is recorded unless a
  citation carries a parseable http(s) URL**, and a finding whose cited span is
  not actually present in the returned text is dropped with a note. An empty
  annotation array yields zero findings and an honest message — never a
  synthesised citation.

Both are opt-in in Settings; Wikipedia is on by default, Puter web search off
(it needs Puter sign-in and an OpenAI-routed model).

### B5. Three.js canonical renderer

- `three` (MIT, current release) added as a dependency, dynamically imported so
  it stays in its own chunk and is never downloaded unless the 3D view is opened.
- `src/render/layout.ts` — a **renderer-independent, deterministic** placement
  pass: canonical scene → positioned objects (mm), links, bounds, scale. This is
  where "where does this box go" is decided, so a future SVG or CAD exporter
  inherits the same layout instead of inventing another.
- `src/plugins/renderers/three.ts` — the plugin: boxes, cylinders, spheres and
  tubes from parsed dimensions; wireframe placeholders for `custom` / `assembly`
  with an explicit note that the geometry is not specified; colour-coded links by
  connection kind; a ground grid scaled to the bounds; orbit controls; resize and
  disposal handled.
- WebGL absence is detected and reported honestly. jsdom has no WebGL, so the
  plugin's tested surface is registration, activation, layout consumption and
  graceful failure — not pixels.
- No natural language reaches the renderer. The only input is a `CanonicalScene`.

---

## Order of work and gates

1. Part A (storage, capacity, guards) + regression tests for each defect.
2. B1 multi-idea (needs the new storage layout).
3. B2 branching (needs B1's schema bump to avoid two migrations).
4. B3 streaming.
5. B4 research sources.
6. B5 layout + Three.js renderer.
7. UI wiring for all of the above, demo extension, docs, CHANGELOG.

Gate after every stage, and at the end: `tsc --noEmit` clean, `vitest run` green,
`vite build` succeeds, dev preview serves. The v0.1 MVP acceptance scenario must
still pass unchanged — it is the regression test for the whole product idea.

## Deliberately out of scope

Recorded as recommendations, not built: delta-encoded snapshots (would replace
full snapshots with a base + change chain), merge between branches, background
agents, multi-user collaboration, a plugin marketplace, and any automated
verification against a live model — which remains impossible from this sandbox
because `api.puter.com` is not reachable from it.
