# Ideno

**An idea-development system.** You describe a rough idea; Ideno builds and
maintains a structured, versioned **Idea State** — requirements, constraints,
assumptions, unknowns, evidence, alternatives, decisions — and keeps that
state, not the chat transcript, as the source of truth.

It is explicitly *not* a chat assistant with a sidebar. The conversation is an
input channel. The product is the state.

> **v0.1 — first working prototype.** The core loop, the state model, the
> review/versioning workflow, source-verified research and the HTTP/UI stack
> are implemented and tested. See [Scope](#what-v01-does-and-does-not-do).

---

## Why this exists

A chat assistant forgets, contradicts itself, and presents guesses in exactly
the same voice as facts. For developing an idea over days or weeks, those three
properties are fatal. Ideno's answer:

| Problem | What Ideno does |
|---|---|
| Context lost between sessions | The idea lives in a persisted, schema-validated document, not in a transcript |
| Guesses indistinguishable from facts | Every item carries an **epistemic status**: `known`, `assumed`, `unknown`, `evidence_supported`, `model_suggestion`, `user_decision` |
| Silent drift | Nothing mutates state without an explicit, reviewable changeset and a version bump |
| "Research" that is really recall | A claim becomes evidence **only** if Ideno fetched a source and found the quote in it |
| New information ignored | Impact analysis runs every turn and can re-open earlier stages |

---

## Quick start

```bash
npm install
cp .env.example .env     # then set ONE provider block (see below)
npm run dev              # API on :8787, UI on :5173
```

Open <http://localhost:5173>.

Ideno needs one AI provider. The cheapest path is a local model — no key, no
data leaving the machine:

```bash
# .env
IDENO_OPENAI_BASE_URL=http://localhost:11434/v1
IDENO_OPENAI_MODEL=qwen2.5:14b-instruct
```

Any OpenAI-compatible `/chat/completions` endpoint works (OpenAI, OpenRouter,
Groq, Together, vLLM, LM Studio, llama.cpp, Ollama). Puter is also supported
via `IDENO_PUTER_AUTH_TOKEN`. Without a provider the UI still runs and tells
you exactly what is missing — it just cannot reason.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API + UI with reload |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` over everything |
| `npm run lint` | ESLint (flat config, type-aware) |
| `npm run verify` | typecheck + lint + test — the gate before any commit |
| `npm run build` | Server to `dist/`, client to `dist/ui/` |
| `npm start` | Run the built server; it also serves the built client |

---

## The loop

```
USER IDEA → UNDERSTAND → STRUCTURE → RESEARCH/EVIDENCE → CONSTRAINT ANALYSIS
          → CRITIQUE → ALTERNATIVES → UPDATED IDEA STATE → HUMAN FEEDBACK → ↺
```

It is **re-entrant, not a pipeline**. Each turn the orchestrator plans which
stages to run from what you actually said. If impact analysis finds that a new
constraint invalidates an existing alternative, exploration is re-entered in the
same turn even though it was not originally planned — that is the non-linearity
requirement, and it is covered by a test.

Stages are: **UNDERSTAND** (extract structure), **IMPACT** (what does this new
information break?), **CRITIQUE** (contradictions, unrealistic assumptions,
failure points), **EXPLORE** (alternative approaches), and **RESEARCH**
(explicit, source-backed).

---

## How a change reaches the state

```
model output ──► stage schema ──► translator ──► ChangeSet (pending)
                 (Zod)            (plain TS)           │
                                                       ▼
                                           you accept / reject per entry
                                                       │
                                                       ▼
                                   applyOperations ──► new version
```

Four properties fall out of this shape:

1. **The model cannot write state.** It returns findings in its own vocabulary;
   ordinary TypeScript turns those into operations. A hallucinated id or an
   illegal transition is not expressible.
2. **Nothing is silent.** Every proposal is a changeset you can accept
   wholesale, in part, or not at all, with affected areas shown.
3. **`applyOperations` is the only mutator**, and it enforces the epistemic
   invariants — see below.
4. **Every applied batch is a version** with a visible diff.

### The invariants the applier enforces

These are checks in code, not instructions in a prompt:

- `evidence_supported` requires at least one resolvable evidence id. Otherwise
  the item is downgraded.
- `known` / `user_decision` claimed by a non-user origin requires a
  `source_quote` that **actually occurs in your message**. If it does not, the
  quote is stripped and the claim is downgraded.
- Evidence items are forced to `evidence_supported` — there is no
  `source: 'model'`, by design.
- Unresolvable references, self-relations and duplicates are dropped
  individually; a bad operation never aborts the rest of the batch.

---

## Research

Research is a fetch-first pipeline, because the failure mode being designed
against is a model answering from memory and calling it a source.

1. The URL is fetched **server-side** (scheme allowlist, DNS resolved up front,
   private/loopback/link-local ranges refused, redirects re-validated per hop,
   size cap, content-type allowlist, timeout).
2. The model only ever sees text that was actually retrieved.
3. Every claim must carry a verbatim `excerpt`, and each excerpt is checked
   against the fetched document. **Claims whose quote is not in the source are
   discarded** and reported as warnings.

What survives becomes evidence with `fetched_by_ideno: true`. A URL you merely
mention is recorded with `retrieved_at: null` and is visibly *not retrieved*.

---

## Project layout

```
src/
  core/          Ideno Core — zero provider-specific code
    schemas.ts       canonical Idea State + operation schemas (source of truth)
    patch.ts         the ONLY mutator; enforces the epistemic invariants
    orchestrator.ts  plans and runs a turn; re-enters stages when needed
    state_manager.ts single writer; turns, changesets, decisions, versions
    versioning.ts    linear versions with diffs (branch-ready schema)
    context.ts       renders state as model context — never a transcript dump
    store/           CaseStore interface + file and in-memory implementations
  ai/            runtime interface + provider adapters (openai_compatible, puter)
  reasoning/     stage schemas, prompts, and stage → operation translators
  research/      source fetcher (SSRF-hardened) + evidence extraction
  plugins/       registry + the canonical representation contract
  server/        Express app, config, routes
  ui/            React client: conversation left, Idea State right
  tests/         171 tests
docs/
  ARCHITECTURE.md
  adr/0001-provider-topology.md
```

---

## What v0.1 does and does not do

**Implemented and tested**

- The full loop, non-linear re-entry, impact analysis
- Idea State schema with epistemic status and item lifecycle
- Changeset review (per-entry accept/reject) and linear versioning with diffs
- Deterministic single-question selection — Ideno asks only the
  highest-impact unknown, and only when it clears a threshold
- Source-verified research with SSRF defences
- Failure handling: provider unavailable/unconfigured, timeout, malformed
  output (one corrective re-ask, then graceful degradation), empty response,
  research failure, conflicting information, insufficient evidence
- React UI: conversation, live Idea State, review card, version timeline

**Deliberately not in v0.1**

- Autonomous background agents, multi-agent systems
- Vector DBs or elaborate memory — structured state *is* the memory
- CAD/physics engines, 3D renderers
- Authentication, multi-user, marketplaces
- Branching versions (the schema allows it; nothing builds it)

**Prepared but not implemented, by design:** the plugin extension points
(Research, 3D, CAD, Coding, Simulation, Data, Visualization). The registry is
real and only lists genuinely registered plugins, so v0.1 reports exactly one:
the research plugin. `src/plugins/canonical/schema.ts` defines the
renderer-independent representation a future 3D/CAD plugin would consume —
objects, dimensions, connections, constraints, each traceable to the Idea State
items it came from, never free-form natural language. It is a contract only;
there is no extractor and no renderer.

---

## Security notes

- No authentication. Ideno v0.1 is a **localhost-first, single-user** tool.
  Do not expose it to a network without putting authentication in front of it.
- Provider credentials are read from the environment by the server and are
  never sent to the browser; the capabilities endpoint reports only whether a
  credential is set. There is a test asserting that.
- The research fetcher resolves DNS and rejects private address ranges before
  connecting. **Known limitation:** a DNS-rebinding race between validation and
  connection remains possible, because Node's `fetch` does not accept a
  pre-resolved address. Mitigating it properly needs a custom agent.
- Frame-blocking headers are intentionally not set, so the UI can run in a
  development preview iframe. Add them when authentication is added.

---

## Licence and credits

This project uses Express, React, Zod, Vite and Vitest. Puter.js integration
follows the Node.js usage documented at <https://docs.puter.com>.
