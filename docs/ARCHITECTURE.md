# Ideno Architecture (v0.1)

This document explains the structure, the boundaries, and the reasoning behind
the choices that were not obvious. It describes what is in the repository
today — nothing here is aspirational.

---

## 1. The one-sentence version

Ideno is a **state machine over an Idea Case**, driven by model-generated
proposals that are translated into typed operations and applied by a single
guarded mutator, with the human holding the accept/reject authority.

---

## 2. Layers

```
┌──────────────────────────────────────────────────────────────┐
│ src/ui          React client. Imports from core ONLY as types │
├──────────────────────────────────────────────────────────────┤
│ src/server      Express. Validation, error mapping, wiring    │
├──────────────────────────────────────────────────────────────┤
│ src/core        IDENO CORE — no provider-specific code at all │
│   orchestrator · state_manager · patch · versioning · context │
├───────────────┬──────────────────────┬───────────────────────┤
│ src/reasoning │ src/research         │ src/plugins           │
│ stages ↔ ops  │ fetch → verify → evi │ registry + canonical  │
├───────────────┴──────────────────────┴───────────────────────┤
│ src/ai          AIRuntime  →  AIProvider  →  adapters         │
└──────────────────────────────────────────────────────────────┘
```

The dependency rule is one-directional: `core` never imports from `ai/providers`,
`server` or `ui`. `core/orchestrator.ts` depends on the `AIRuntime` *interface*
only. Swapping Puter for a local model touches one file in `src/ai/providers`
and one environment variable.

### Why the UI may only `import type` from core

`src/core` reaches for `node:crypto`. A value import from the client would pull
Node built-ins into the browser bundle. Type-only imports are erased at compile
time, so the client gets exact, always-current API types with zero runtime
coupling. The production bundle is 26 modules; no core module is among them.

---

## 3. The Idea State

`src/core/schemas.ts` is the single source of truth. Everything else — the
orchestrator, the stages, the HTTP API, the UI, any future plugin — is defined
in terms of it.

Ten collections: `requirements`, `assumptions`, `constraints`, `unknowns`,
`evidence`, `research_items`, `alternatives`, `decisions`,
`rejected_approaches`, `open_questions`. Plus `relations`, `current_state`,
`version_history`, `changesets`, `conversation`.

Every item carries three orthogonal axes. Conflating them is the failure mode
the whole product exists to avoid:

| Axis | Values | Question it answers |
|---|---|---|
| `epistemic_status` | `known`, `assumed`, `unknown`, `evidence_supported`, `model_suggestion`, `user_decision` | How much do we actually know? |
| `origin` | `user`, `model`, `research`, `system` | Who introduced it? |
| `status` | `active`, `superseded`, `invalidated`, `rejected` | Does it still count? |

A model-authored item can never be `known` unless it carries a `source_quote`
that really occurs in the user's message — verified in code, at apply time.

### Evidence has no `model` source type

`EvidenceSource` is `url | user | document`. A model assertion without a source
is not evidence; it is a research question, and Ideno records it as one. This
is a schema-level decision precisely so that no prompt change can undo it.

---

## 4. The turn

`Orchestrator.runTurn()`:

1. **Append the user turn first.** If reasoning dies, the message is not lost.
2. **UNDERSTAND** (temp 0.2) — extract structure. Hard-fails the turn: without
   it there is nothing to act on. A `system` turn records why.
3. **Translate** stage output → `DraftEntry[]`.
4. **Plan** the rest of the stages from the extracted intent.
5. **IMPACT** (temp 0.1) — what does this break, weaken, or reinforce?
6. **Loop-back check** — if IMPACT reported invalidations, exploration was not
   planned, and active alternatives exist, EXPLORE is added with a focus
   string. This is the non-linearity requirement; `plan.reasons` records it.
7. **CRITIQUE** (0.3) ‖ **EXPLORE** (0.6) via `Promise.allSettled`. Either may
   fail without failing the turn; the turn is marked `degraded`.
8. **Consolidate** into a `set_field current_state` operation.
9. **Queue a ChangeSet** (pending unless `autoAccept`).
10. **Select at most one question** — deterministic, no model call.
11. **Compose the reply** — deterministic, no model call.

### No fifth composition call

The user-facing message is assembled in TypeScript from stage summaries,
invalidation labels, alternatives, a change summary and the question. One less
call, one less failure mode, and the prose cannot drift from the state it
claims to describe.

### Question selection is deterministic

`src/reasoning/questions.ts`. No LLM:

```
score = impact
      + 0.15 if it blocks something
      + 0.10 if recently raised
      − 0.20 if it already has supporting evidence
      − 0.50 if Ideno already asked it
ask when score ≥ 0.45, at most one per turn
```

Asking is a product decision about interrupting a human. It should be
inspectable and tunable, not re-litigated by a model every turn. This is what
implements "ask only the single highest-impact unknown" and "no interrogation".

---

## 5. Why the model never writes state

Stage schemas (`src/reasoning/schemas.ts`) are **not** the operation schemas. A
stage describes findings in its own vocabulary; `src/reasoning/translate.ts`
turns that into operations.

Two reasons:

- **Safety.** A hallucinated item id or an illegal transition cannot be
  expressed in the stage schema, let alone applied.
- **Compliance.** Small local models follow small, domain-shaped contracts far
  better than they follow a general operation grammar.

### Local references

An `add` may carry `ref: "a1"`; later operations in the same batch cite `"@a1"`.
The model cannot know ids that do not exist yet, and this is how it says
"relate the constraint I am adding to the assumption I am also adding".
Translators use disjoint prefixes (`n*` understand, `c*` critique, `r*`
research) so refs stay unique across a merged changeset. Unresolvable refs are
dropped, never guessed.

---

## 6. `applyOperations` — the only mutator

`src/core/patch.ts`. Clones its input, never aborts a batch, returns
`{ ideaCase, outcomes, changed }` where `outcomes` explains every operation
that was altered or skipped.

Enforced invariants (all test-covered):

- `evidence_supported` requires ≥ 1 resolvable evidence id, else downgraded
- `known` / `user_decision` from a non-user origin requires a `source_quote`
  passing `quoteOccursIn` (normalised substring, ≥ 4 chars); failing quotes are
  stripped and the status downgraded
- evidence items are forced to `evidence_supported`
- unresolvable refs, self-relations and duplicate relations are dropped
- duplicate text is skipped via a normalised identity
- 150 items per collection, hard cap
- `selected` is exclusive among alternatives
- `invalidate` does not cascade — invalidation is a human-reviewable judgement,
  not a graph traversal

---

## 7. Concurrency and persistence

`CaseStore` takes a **mutator**, not a finished case:

```ts
update(id, (current) => next): Promise<IdeaCase>
```

The store owns the read-modify-write critical section, so no caller can clobber
a concurrent write. `KeyedMutex` serialises per case id; unrelated cases stay
fully concurrent. The file store writes to a temp file and renames, so a crash
mid-write cannot truncate a case. A ten-way concurrent update test asserts no
lost writes against both implementations.

`StateManager` is the single writer above that. `ChangeSet.turn_id` points at
the **user** turn, so quotes are re-verified against the user's own words at
accept time — not at propose time.

---

## 8. Context construction

`src/core/context.ts` renders the Idea State as model context — never a
transcript dump. Items appear as `[id] (status, origin)` lines, so the model
can cite real ids; items being added in the same turn appear under
`## BEING ADDED THIS TURN` with their `@refs`; closed and invalidated items are
listed separately so the model stops proposing them. A 14,000-character budget
degrades by dropping the least relevant sections first.

A test asserts that generated ids are visible in the prompt, by having the
scripted provider read them back out.

---

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| No provider configured | 503 `provider_not_configured`, with setup text; UI shows a banner; no mutation |
| Provider unreachable | 503, retried once with bounded backoff |
| Timeout | `AbortController`, 504 `provider_timeout`, distinguished from caller cancellation |
| Malformed JSON | fence strip → balanced-value extract → one corrective re-ask with the exact validation errors → else the stage fails |
| Empty response | `empty_model_output`, enforced in the runtime so every adapter inherits it |
| A non-critical stage fails | Turn completes, `degraded: true`, failures reported per stage |
| Research fetch fails | `research_status: 'failed'` + error + timestamp; **no evidence invented** |
| Conflicting information | Critique emits a conflict as an open question rather than silently picking |
| Insufficient evidence | Claims stay `model_suggestion`; they do not become evidence |

JSON recovery is deliberately conservative: no quote fixing, no trailing-comma
repair, no key inference. Repairing malformed JSON means inventing content.

---

## 10. Plugins

`PluginRegistry` is real and backs `/api/capabilities`; it lists only genuinely
registered plugins. v0.1 registers exactly one: `research.url`.

`src/plugins/canonical/schema.ts` defines `CanonicalDocument` — objects,
connections, constraints, each requiring a non-empty `derived_from` list of
Idea State item ids. A future 3D/CAD/simulation plugin consumes *this*, never
natural-language instructions, so the renderer is interchangeable and every
rendered element is traceable to the state it came from.

**There is no extractor and no renderer in v0.1.** The contract exists because
defining it later would force a breaking change; implementing it now would be
unjustified scope.

---

## 11. Technology choices

| Choice | Why | Alternative rejected |
|---|---|---|
| TypeScript 5.9 (not 7.0) | 7.0 is the Go-native compiler port; typescript-eslint and plugin compatibility unverified | TS 7 — revisit when the ecosystem catches up |
| Zod 4 | One schema definition drives runtime validation, static types, and the JSON Schema sent to providers | Hand-written validators; `ajv` + separate types |
| Express 5 | Async errors propagate to the error middleware natively, removing a whole class of unhandled rejection | Fastify (fine, but no advantage here); bare `node:http` |
| React 19 + Vite 8 | The Idea State panel is genuinely stateful; Vite's proxy keeps the browser same-origin | Server-rendered templates — too awkward for live state |
| No UI component library | ~700 lines of CSS, zero dependency surface, full control of the epistemic colour language | MUI/Chakra — large dependency for a two-pane layout |
| JSON files for storage | Inspectable, diffable, zero setup, trivially backed up; `CaseStore` makes swapping it a one-file change | SQLite — justified at multi-user scale, not now |
| Vitest | Native ESM + TypeScript, no transform config | Jest — heavier ESM story |

Total production dependencies: **two** (`express`, `zod`), plus an optional
`@heyputer/puter.js`.

---

## 12. Known limitations

1. **DNS-rebinding TOCTOU** in the research fetcher (see README).
2. **No historical state reconstruction.** `VersionRecord.operations` stores
   everything needed, but replaying it faithfully requires re-minting the exact
   ids assigned at the time. Diffs per version are available; "show me the
   state at v2" is not. No schema change is needed to add it.
3. **No authentication.** Single-user, localhost-first.
4. **No streaming.** Turns are request/response; a slow local model shows a
   thinking indicator for the whole turn.
5. **No live-provider verification.** The suite proves Ideno's own behaviour
   with a scripted provider. Prompt quality against a real model is unverified
   in CI and must be checked by hand.
