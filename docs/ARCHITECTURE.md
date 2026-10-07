# Ideno architecture

This document records the structure, the invariants the structure exists to
protect, and the decisions behind it — including the alternatives that were
rejected and why.

---

## 1. The problem this architecture solves

An idea-development system fails in characteristic ways:

| Failure | Architectural answer |
| --- | --- |
| The model quietly rewrites what the user meant | Every change is a validated record; the user's own words and the model's inferences take different paths |
| The state drifts into something internally inconsistent | Every mutation is applied to a clone, then the whole body is re-validated before commit |
| A model hallucinates an id and corrupts a reference | Core mints all ids; unresolvable references are pruned and the pruning is reported |
| A guess is presented as research | Evidence provenance is derived from origin, and the field is absent from the model's contract |
| The conversation becomes the memory | The IdeaCase is the source of truth; the transcript is context, bounded and droppable |
| One provider's quirks leak everywhere | `AIProvider` is the only provider-facing type Core can see |
| The user is interrogated | One question per turn, enforced in code, with suppression recorded |
| Nobody can say what changed | A snapshot per version, and diffs computed from snapshots rather than summaries |

---

## 2. Module map

```
src/
├── core/                          depends on: zod only. No DOM, no network, no provider.
│   ├── schemas/
│   │   ├── common.ts              ids, timestamps, provenance, impact, affected areas
│   │   ├── idea_state.ts          the eleven collections + IdeaCase + VersionRecord
│   │   ├── changes.ts             drafts, ChangeSet, TurnPlan, ChangeRecord
│   │   ├── session.ts             transcript, session, workspace
│   │   ├── settings.ts            behaviour settings only (no provider names)
│   │   └── format.ts              one way to render a validation failure
│   ├── idea_state/
│   │   ├── create.ts              factories, title derivation, snapshots
│   │   ├── collections.ts         the registry: labels, schemas, terminal statuses
│   │   └── selectors.ts           deriveCurrentState, rankUnknowns, decideQuestion, stats
│   ├── state_manager/
│   │   ├── apply.ts               change set → records → body (validate, mint, prune)
│   │   ├── state_manager.ts       the only mutator: review policy, versions, persistence
│   │   └── store.ts               Store interface, localStorage probe, memory fallback
│   ├── versioning/diff.ts         snapshot diffs, per-field, with a human summary
│   ├── orchestrator/orchestrator.ts   the turn loop
│   ├── ids.ts                     id + clock (injectable for deterministic tests)
│   └── errors.ts                  IdenoStateError
├── ai/
│   ├── provider_interface/provider.ts  AIProvider, ChatTurn, capabilities, availability
│   ├── runtime/
│   │   ├── runtime.ts             AIRuntime: contract, timeout, extract, validate, repair
│   │   └── json_extract.ts        JSON from prose, fences, stray braces, trailing commas
│   ├── providers/{puter,openai_compatible,scripted}.ts
│   ├── settings.ts                provider ids and provider configuration
│   ├── settings_store.ts          settings persistence + API-key handling
│   ├── errors.ts                  AIError + typed codes + user-facing hints
│   └── factory.ts                 the only file that knows concrete providers exist
├── reasoning/
│   ├── prompts.ts                 the product's point of view, per operation
│   ├── context.ts                 state digest, transcript window, pending digest
│   └── operations.ts              prepareOperation: state + conversation → messages
├── research/evidence.ts           ResearchSource, registry, gap analysis, evidence drafts
├── render/canonical.ts            quantity parsing, CanonicalScene, projection
├── plugins/registry.ts            plugin + renderer + research-source extension points
├── ui/                            dom.ts (safe builder), components/, app.ts, styles.css
└── demo/greenhouse.ts             the scripted acceptance scenario
```

**Dependency direction is one-way:** `ui → orchestrator → reasoning → ai →
core/schemas`. The core *state* modules never import from `ai`, `ui`, `reasoning` or
a provider; `core/orchestrator` is the single composition point in core that
coordinates the runtime and the reasoning layer, and it depends only on their
interfaces. `render` and `research` depend only on `core`.

This is enforced by `tests/architecture.test.ts`, which reads the sources and fails
if a provider name appears in `src/core` or `src/reasoning`, if a concrete provider
adapter is imported outside `src/ai`, if the Puter SDK is imported statically, if a
core state module imports upward, if the reasoning layer touches the DOM, or if any
UI file assigns to `innerHTML`. The rule "the core does not depend on one AI
provider" is a test, not an intention.

Provider *configuration* follows the same split: `core/schemas/settings.ts` holds
behaviour (review mode, temperature, timeout, context window) and
`ai/settings.ts` holds provider ids and endpoint configuration, so the orchestrator
is typed against `BehaviourSettings` and cannot see a provider field.

### Deviations from the suggested layout, and why

The brief proposed `src/reasoning/{understand,critique,explore,update}` as separate
modules and `src/tests/`. Three deliberate changes:

1. **One `reasoning/operations.ts` + `reasoning/prompts.ts` instead of four operation
   modules.** All six operations share one output contract, one context builder and one
   preparation path; what actually differs between them is the instruction text. Four
   files would have been four copies of the same twelve lines around different strings,
   and adding an operation would have meant touching four places instead of one enum
   entry and one prompt.
2. **`src/render/` and `src/plugins/` as siblings of `core`, not inside it.** They are
   consumers of the Idea State (projection, extension points), not part of the state
   machine, and keeping them out preserves the rule that core has no DOM and no
   renderer knowledge.
3. **Top-level `tests/` rather than `src/tests/`.** Conventional for Vite projects, it
   keeps production sources free of test-only files, and `tsconfig.json` includes both
   so tests are typechecked with the same strictness as the app.

Also added beyond the suggestion: `src/demo/` (the scripted acceptance scenario, shared
by the tests and the labelled offline demo) and `src/core/schemas/format.ts` (one way to
render a validation failure, used by every layer that validates untrusted data).

---

## 3. Invariants

These hold everywhere, and tests exist for each:

1. **The IdeaCase always validates.** A batch whose result fails
   `IdeaCaseBodySchema` is discarded whole; the previous state stands.
2. **Core mints ids and timestamps.** Drafts cannot carry `id`, `created_at`,
   `updated_at`, `origin_operation` or `source_message_id`; those keys are not in
   the draft schemas.
3. **Provenance of decision and evidence is derived, never claimed.**
   `user_decision` comes from `decided_by === 'user'`; `evidence_supported` comes
   from `origin ∈ {user_supplied, research_source}` plus a non-empty locator.
4. **Nothing is deleted.** Items move to a terminal status
   (`dropped`, `invalidated`, `rejected`, `superseded`, …), so history stays
   explainable and a diff can show *why* something disappeared.
5. **References resolve or are pruned, with a note.** An id the model invented
   cannot enter the state.
6. **At most one question per turn**, and never a low-impact one, one about a
   resolved unknown, or one already asked.
7. **A turn stops on failure.** No follow-up operation runs after an error.
8. **Versions are append-only.** Restoring creates a new version whose parent is
   the current head.
9. **Model text is never markup.** All rendering goes through `textContent`;
   evidence locators become links only when they parse as `http(s)`.

---

## 4. Key decisions

### 4.1 One structured output contract, not one per operation

`TurnPlanSchema` is the only shape a model returns, whichever operation is
running:

```jsonc
{
  "operation": "update",
  "classification": "revision",
  "reasoning_summary": "…one or two sentences, a conclusion not a transcript…",
  "user_message": "…what the human reads…",
  "changes": { "constraints_added": [], "items_invalidated": [], "…": "…" },
  "question": { "text": "…", "why_it_matters": "…", "impact": "high" } | null,
  "followups": ["critique"]
}
```

*Rejected alternative:* a separate schema per operation (`CritiqueResult`,
`ExploreResult`, …). It would mean four prompts, four validators, four repair
paths and four sets of tests for no gain in expressiveness — critique output is
already expressible as findings plus invalidations.

The JSON Schema shown to the model is generated from this same zod schema
(`z.toJSONSchema`), so the contract in the prompt cannot drift from the contract
in the validator. A test asserts the schema stays representable.

### 4.2 Drafts are validated by kind, not by union

`ChangeRecord.draft` is `unknown` at the type level and validated by a refinement
that dispatches on `record.kind` to `DRAFT_SCHEMA_FOR_KIND[kind]`.

This was a real bug, not a hypothetical: an untagged union of draft schemas tries
members in order, and every item draft accepts `{text}` with everything else
defaulted. A constraint draft therefore parsed as a *requirement*, silently losing
`category` and `hard`, and then failed when it reached the constraints collection.
Dispatching on kind removed the ambiguity, and `buildChangeRecords` now parses the
whole change set through `ChangeSetSchema` first, so callers get the same
normalisation whether they hand over a model response or a plain object.

### 4.3 Review policy: what the human said applies, what the model inferred waits

```
assisted (default)  user_stated / user_decision / your own actions → applied
                    everything the model inferred                  → Accept / Reject
strict              everything the model touched                   → Accept / Reject
```

*Rejected alternatives:*
- **Queue everything.** Faithful to a literal reading of "let the user inspect
  changes", but the five-step acceptance scenario would need ~40 clicks, and
  re-approving your own sentence is not governance.
- **Apply everything, allow undo.** Smoother, but a hallucinated constraint would
  be in the state — and in the version history — before anyone looked.

Proposals are still **visible in the state panel in place**, styled as proposals,
so the idea appears to develop immediately while nothing unreviewed becomes fact.
The model also sees the pending queue in its context, which stops it re-proposing
the same thing next turn.

### 4.4 Full snapshots per version

Each `VersionRecord` holds a complete `IdeaCaseSnapshot` plus `parent_id` and the
ids of the change records it applied. "What changed" is a diff of two snapshots
(`versioning/diff.ts`), so it is exact and reproducible — a model's own summary of
its edit is not evidence about its edit.

*Trade-off accepted:* storage grows quadratically with version count. At v0.1
scale (tens of versions, thousands of characters) that is irrelevant next to the
value of trivially correct diffs and restores. `parent_id` is already a link, so
history can become a tree — and snapshots can become deltas — without a data
migration. Version history is capped at 1000 and refuses loudly rather than
silently dropping the link chain.

### 4.5 Static app, providers in the browser

No server means no secret handling, no auth, no session store, no deployment
surface — and Puter's user-pays model is designed for exactly this. The
OpenAI-compatible adapter therefore calls the endpoint from the browser, which is
why the key-persistence opt-in and the loopback-only-`http` rule exist.

*Rejected alternative:* a Node proxy holding keys server-side. It would be the
right call for a multi-user product, and it is the first thing to add if Ideno
ever gets accounts. For a single-user prototype it would add a deployment, a
secret store and a CORS surface to protect one key that the user can keep in their
own browser.

### 4.6 Puter via npm, loaded lazily

`@heyputer/puter.js@2.6.4` is a normal dependency, imported with a dynamic
`import()` inside the adapter. It ships its own TypeScript declarations, so the
adapter is typed against the real SDK rather than `any`, and the version is pinned
by the lockfile instead of trusting an unpinned CDN script.

The dynamic import keeps it in its own chunk: `dist/` contains a ~247 KB app bundle
and a 492 KB Puter chunk. The chunk is fetched only while Puter is the selected
provider — but because Puter is the default, the boot-time availability check does
load it on a normal first visit. Switching to another provider in Settings means it is
never fetched. Tests and the scripted demo never load it.

### 4.7 Vanilla DOM, no framework

The UI is ~1200 lines across seven files, built with a 100-line safe DOM helper.
React would have added two dependencies and a build-time transform to render
derived views of an immutable state — which is exactly what a `render(container,
…children)` call already does. The helper's real job is security: there is no
`innerHTML` in the codebase, so there is no place to forget to escape.

Panels re-render wholesale (they are cheap, derived views). The conversation grows
incrementally, and **the DOM itself is the render counter** — `querySelectorAll('.message').length`
rather than an index variable. An index desynced once already (a detached
conversation element caused every message to render twice); deriving the count
from the DOM removes that class of bug permanently.

### 4.8 `current_state` is derived, never asserted

`deriveCurrentState(body)` computes the phase from the data: a critical open
finding outranks everything (`blocked`); no analysis at all is `seed`; a selection
plus active decisions plus no open high-impact unknown is `decided`; and so on. A
model cannot declare "we are done". The badge in the header cannot disagree with
the state behind it.

---

## 5. Failure handling

| Situation | Behaviour |
| --- | --- |
| Provider unreachable / SDK fails to load | Availability check before any call; UI offers the other providers. Nothing is lost. |
| Puter not signed in | Availability reports `action: 'sign_in'`; the orchestrator attempts one interactive sign-in, then reports honestly if it fails (iframes often block the popup). |
| Model unavailable / 404 | `AIError('model_unavailable')` with a settings hint |
| 401 / 403 | `auth_required` |
| 429 | `rate_limited` |
| 5xx | `provider_unavailable` |
| Timeout | Wall-clock budget in the runtime, cooperative abort to the provider. The turn stops; a late response cannot mutate state afterwards. |
| Empty response | `empty_response`; one repair attempt, then failure |
| Prose instead of JSON | Extraction (direct → fenced → balanced → trailing-comma repair); on failure, one repair round-trip carrying the validation issues |
| Malformed after repair | State untouched. The raw text is kept on the transcript entry behind a disclosure, so the human still sees what the model said |
| Invalid change set | Rejected before anything is queued |
| One bad record in a batch | That record is skipped with a reason; the rest apply |
| Whole batch invalid | Batch discarded, records marked rejected with the reason, integrity event raised |
| Collection at capacity | Change refused with a note; state stays valid |
| Conflicting information | Recorded as a `contradiction` finding plus invalidation of the affected items — a conflict becomes visible state, not a silent overwrite |
| Insufficient evidence | Claims stay `model_inferred` / `model_suggestion`; a research question is raised; the Spec panel lists what the idea rests on without evidence |
| Storage unavailable (Safari private mode) | Probed at boot; falls back to memory and says so |
| Corrupt or newer workspace | Reported with the reason; the app starts a fresh session and leaves the stored bytes untouched |

`AIError.describe()` never renders as HTML, and the raw model text is only ever
inserted as `textContent`.

---

## 6. Extension points (prepared, not implemented)

```ts
interface IdenoPlugin {
  id; name; version; capabilities: PluginCapability[];
  activate(ctx: IdenoPluginContext): void | Promise<void>;
}

interface IdenoPluginContext {
  registerResearchSource(source: ResearchSource): void;
  registerRenderer(renderer: CanonicalRenderer): void;   // consumes CanonicalScene
  getState(): IdeaCase | null;                            // read-only
  getCanonicalScene(): CanonicalProjection | null;
  subscribe(listener: (event: StateEvent) => void): () => void;
}
```

Capabilities: `research`, `render3d`, `cad`, `code`, `simulation`, `data`,
`visualization`.

The research hook is already load-bearing: on a `research` turn the orchestrator
calls `runResearch` over the highest-priority open questions, converts findings into
evidence drafts, merges them into the same validated batch as the model's proposal,
and reports retrievals and failures as integrity notes. Registering a source is
therefore the only missing step for real research — no core change is required.

There is deliberately **no mutation hook**. A plugin cannot write to the Idea
State; changes enter through validated change records, so provenance, review and
versioning cannot be bypassed by an extension. Activation failures are isolated
per plugin and surfaced in the Spec tab.

A renderer receives a `CanonicalScene` — explicit objects, normalised millimetre
dimensions, resolved connections, sourced constraints — never an instruction in
natural language. That is the whole point of the projection: two renderers
disagreeing about how to draw something still agree about what exists.

---

## 7. Testing strategy

275 tests, 12 files, no network, no keys, no model:

| Suite | Covers |
| --- | --- |
| `schemas` | provenance discipline, defaults, caps, the JSON-Schema representability of the contract |
| `idea_state` | title derivation, phase derivation, unknown ranking, question suppression |
| `state_manager` | review policy, accept/reject, versioning, restore, persistence, corrupt storage |
| `versioning` | field-level diffs, summaries, snapshot isolation |
| `orchestrator` | **the MVP acceptance scenario end to end**, follow-ups, budgets, every failure mode, context bounds |
| `providers` | Puter adapter against a fake SDK, OpenAI-compatible against a fake fetch, HTTP status mapping |
| `json_extract` | fences, prose, stray braces, strings containing braces, trailing commas |
| `research` | source registry, per-source failure isolation, evidence integrity, gap analysis, and a live research turn through the orchestrator |
| `canonical` | unit parsing, projection, unresolvable geometry, renderer independence |
| `plugins` | registration, activation isolation, extension-point surface |
| `ui` | jsdom: provenance markers, inline proposals, XSS inertness, safe links, review cards, diffs, spec, the evidence form, and a full app boot that runs the demo through the real DOM |
| `architecture` | the module boundaries themselves, by reading the sources (see §2) |

Determinism comes from two seams: an injectable `Clock` and the `ScriptedProvider`.
The scripted provider is also the offline demo — one implementation, two honest
uses, and it is labelled as scripted wherever it appears.

---

## 8. What changed in v0.2, and what it actually touched

The table in v0.1 predicted where each addition would land. This is what happened,
which is worth recording because two predictions were wrong in an instructive way.

| Addition | Predicted to touch | Actually touched |
| --- | --- | --- |
| Research source | one file, nothing else | one file per source, **plus** settings, the factory and the Settings panel. The registry seam held; the *configuration* of a source did not exist yet, and configuration is never free |
| Three.js renderer | new plugin, "everything" untouched | new plugin **plus a new `src/render/layout.ts`**. See decision 4.9 — the renderer needed a placement pass that no renderer should own |
| Branching versions | `state_manager` + `versioning` | that, **plus schemas** (a version needs a branch id, a snapshot had to become nullable) and the UI |
| Streaming | provider + runtime | that, **plus** the orchestrator (a preview event), a new reasoning module, and the conversation component. The *state* contract is genuinely unchanged, which was the point of the prediction |
| Multi-idea workspace | `WorkspaceSchema` gains `cases[]` | **wrong, and the wrongness mattered.** Nesting every idea in one document is what made saving O(all ideas) and put a hard ceiling on the workspace. v0.2 splits storage into an index plus one record per idea; see decision 4.6 |
| Linux desktop application | not predicted | a new Python package, a new UI module, and two new architecture rules |

Still open, and where each would land:

| Next step | Touches | Does not touch |
| --- | --- | --- |
| Delta-encoded snapshots | `versioning` + `state_manager` persistence | schemas, UI, reasoning |
| Streaming for the OpenAI-compatible provider | widen its `FetchLike` seam to expose a readable body, then one adapter method | core, runtime contract |
| `.desktop` entry / AppImage / single-instance lock | `desktop/` only | everything else |
| Second provider | one adapter, one factory case, one enum entry | core |
| Server-side keys | a proxy in front of `openai_compatible`; the adapter's `FetchLike` seam already allows it | core |

### 4.6 Storage is an index plus one record per idea

v0.1 stored the entire workspace as a single document. Two consequences were
measured rather than predicted: saving one idea re-serialised every other, and the
single blob crossed a browser's ~5 MB origin budget at about 170 edits — past which
*nothing* could be saved and the only copy of the idea was the blob that would not
fit.

v0.2 writes `ideno.workspace.index.v2` (ids, titles, phase, counts) plus
`ideno.session.v2.<id>` per idea. Listing ten ideas does not load ten ideas, and a
corrupt idea cannot take the others with it.

*Rejected alternative:* keeping one document and compressing it. Compression moves
the ceiling; it does not remove the coupling, and it makes the stored data harder for
a person to inspect — which matters more on the desktop, where the files are the
product's persistence layer.

### 4.7 The bridge has no policy

The Python host exposes six methods that read and write named documents and report
what happened. Deciding *what* to save, when to prune a snapshot and what a quota
failure means stays in the TypeScript State Manager, where that logic is written once
and tested once.

*Rejected alternative:* a Python side that prunes snapshots when the disk is full. It
would be a second authority over the same data, and the two would eventually disagree
about which version of somebody's idea was expendable.

### 4.8 A turn carries a guard

`StateManager.guard` changes whenever the open idea changes. An orchestrator turn
captures it before its first `await` and passes it with every mutation, so opening
another idea mid-turn fails that turn instead of writing its changes into the idea
that replaced it.

This is the async equivalent of the invariant that Core is the only writer: knowing
*who* is writing is not enough when a write can arrive after the world moved.

### 4.9 Layout is not a renderer's job

`src/render/layout.ts` sits between the canonical scene and any renderer, and decides
how a named dimension maps onto an axis, where objects go, and what happens when a
dimension is missing.

The alternative — letting each renderer place objects — was rejected because a 3D view
and a 2D diagram of the same idea would then disagree, and neither could be checked
against the other. It also puts the placement rules somewhere they can be tested
without a GPU, which in this project turned out to be the only place they could be
tested at all.

### 4.10 Streaming previews are decoration, structurally

A streamed response is assembled in full and validated exactly as a non-streamed one.
The partial parse that drives the preview lives in a different module
(`reasoning/preview.ts`) from the one that decides what is written, is worded as a
proposal ("proposing", never "added"), and is discarded when the turn ends.

The structural point is that there is no code path from a partial document to the Idea
State. A test asserts it by streaming a response whose prefix is a valid but wrong
plan.

---

## 9. Acceptance criteria and risk register

### Acceptance criteria for v0.1, and how each was verified

| # | Criterion | Verification |
| --- | --- | --- |
| 1 | A rough idea becomes a structured Idea State with all specified collections | `tests/orchestrator.test.ts` (MVP scenario), `tests/state_manager.test.ts` |
| 2 | New information updates constraints and revisits affected assumptions | MVP scenario steps 2 and 3: the balcony constraint supersedes a vaguer one; the no-cloud constraint invalidates the control-path assumption and raises a hidden-dependency finding |
| 3 | Alternatives can be generated and one selected, with rejections recorded and reasons kept | MVP scenario steps 4 and 5 |
| 4 | The state — not the transcript — is the memory | `reasoning/context.ts` digest + `tests/orchestrator.test.ts` ("sends the structured state, not a transcript dump"); transcript window is bounded and independently tested |
| 5 | Every meaningful modification creates a version, and versions can be diffed and restored | `tests/versioning.test.ts`, `tests/state_manager.test.ts` |
| 6 | Model output is validated before it touches the state, and malformed output cannot corrupt it | `tests/orchestrator.test.ts` failure-handling suite; `validateBody` gate in `state_manager` |
| 7 | Known / assumed / unknown / evidenced / suggested / decided are distinguished everywhere | Provenance on every item, derivation rules in `apply.ts`, `tests/schemas.test.ts`, `tests/research.test.ts`, UI markers in `tests/ui.test.ts` |
| 8 | No unsupported guess is presented as research | `EvidenceDraftSchema` has no provenance field; `deriveProvenance` downgrades `model_recall`; `tests/research.test.ts` |
| 9 | Ideno asks at most one question, only when it matters | `decideQuestion` in code + prompt rule; `tests/idea_state.test.ts`, `tests/orchestrator.test.ts` |
| 10 | The core does not depend on one provider | Two real adapters behind one interface (`tests/providers.test.ts`) plus `tests/architecture.test.ts`, which fails the build if a provider name or adapter import ever reaches `src/core` |
| 11 | The UI makes the state visible and reviewable | `tests/ui.test.ts` (jsdom), including a full app boot |
| 12 | A canonical, renderer-independent representation exists | `tests/canonical.test.ts`, projected from the developed greenhouse state |

### Risk register

| Risk | Likelihood | Impact | Mitigation in place | Still open |
| --- | --- | --- | --- | --- |
| A model ignores the output contract | High | Medium | JSON extraction, zod validation, one repair round-trip, state untouched on failure, raw text shown to the user | Real-world repair success rate is unmeasured — needs live transcripts |
| A model fabricates a source or a number | High | High | Provenance derivation, no `evidence_supported` without a real locator, prompt rule 3, evidence-gap panel | A model can still assert a false *number* inside a requirement; only review catches that |
| A model invents item ids | High | Low | Core mints ids; references pruned with a note | — |
| Provider unreachable / auth blocked in an iframe | Medium | Medium | Availability gate, typed errors with hints, two alternative providers, offline demo | Cannot be fully mitigated from inside an iframe |
| Review fatigue — the user stops reading and clicks Accept all | Medium | High | `assisted` policy applies the user's own words; proposals are bounded per turn (max 12 per collection, 6 alternatives); the review card states *why* | A behavioural risk; needs real usage data |
| State grows past what one prompt can hold | Medium | Medium | Three-level digest degradation under a character budget; bounded transcript window; ids and provenance never dropped | Very long-lived ideas will need summarisation or delta context |
| `localStorage` quota or private mode | Low | Medium | Boot probe, memory fallback, warning surfaced, export/import | — |
| Version snapshots grow quadratically | Low | Low (at v0.1 scale) | 1000-version cap that refuses loudly; `parent_id` already supports delta encoding later | Deliberate trade-off, documented |
| Prompt drift as operations are added | Medium | Medium | One contract for all operations; JSON Schema generated from the validator; a test asserts it stays representable | — |
| Supply-chain risk from a browser SDK with a large dependency tree | Low | High | Pinned version + lockfile, dynamic import, `open` verified as Node-only, no secrets in the app | The SDK executes in the page; that trust is inherent to Puter's model and is documented |
