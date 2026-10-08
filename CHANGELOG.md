# Changelog

All notable changes to Ideno are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-08

First working prototype. The complete vertical slice is implemented, typed,
linted and tested: a rough idea becomes a structured, versioned, reviewable
Idea State through a re-entrant reasoning loop.

### Added — project setup

- ESM TypeScript project targeting Node ≥ 22; `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `NodeNext` resolution.
- Build split into `tsconfig.build.json` (server → `dist/`) and Vite
  (client → `dist/ui/`), so server types never leak into the browser bundle.
- Flat ESLint 10 config with type-aware `typescript-eslint` rules.
- Vitest configured for the Node environment over `src/tests/**/*.test.ts`.
- `npm run verify` = typecheck + lint + test, as the pre-commit gate.
- Production dependencies deliberately limited to **two**: `express`, `zod`
  (plus optional `@heyputer/puter.js`).

### Added — Ideno Core (`src/core`)

- `schemas.ts` — the canonical Idea State. `SCHEMA_VERSION = 1`; ten
  collections; every item carries three orthogonal axes (`epistemic_status`,
  `origin`, `status`). Five operations: `add`, `update`, `invalidate`,
  `relate`, `set_field`, with a local-reference (`ref`/`@ref`) mechanism so a
  proposal can link items it is creating in the same batch.
  `EvidenceSource` is `url | user | document` — there is intentionally no
  `model` source.
- `patch.ts` — `applyOperations`, the **only** mutator. Clones its input,
  never aborts a batch, and reports an outcome per operation. Enforces the
  epistemic invariants in code: evidence ids must resolve, a non-user `known`
  claim must quote the user verbatim (`quoteOccursIn`), evidence is forced to
  `evidence_supported`, unresolvable refs and self-relations are dropped,
  duplicates are skipped, 150 items per collection, `selected` is exclusive.
- `state_manager.ts` — the single writer. Case lifecycle, conversation turns,
  changeset creation and resolution, version commits. `ChangeSet.turn_id`
  references the **user** turn so quotes are re-verified at accept time.
- `orchestrator.ts` — plans and runs a turn; re-enters EXPLORE when impact
  analysis invalidates an existing alternative; composes the reply
  deterministically, with no extra model call.
- `versioning.ts` — linear versions with per-version diffs; `parent_id` is
  present so branching can be added without a migration.
- `context.ts` — renders state as model context with item ids, additions in
  flight, and closed items, under a 14,000-character budget. Never a
  transcript dump.
- `store/` — `CaseStore` interface plus file and in-memory implementations.
  `update()` takes a mutator so the store owns the critical section.
  Atomic temp-file-and-rename writes; path traversal refused.
- `async_lock.ts` (`KeyedMutex`), `ids.ts` (prefixed short ids),
  `errors.ts` (14-code taxonomy with HTTP mapping), `logger.ts`,
  `idea_state.ts` (construction and read helpers).

### Added — AI runtime (`src/ai`)

- `AIRuntime`: provider resolution, timeout, bounded retry with backoff,
  schema-validated structured completion, and one corrective re-ask carrying
  the exact validation errors. Blank completions and timeouts are classified
  here so every adapter inherits the behaviour.
- `json.ts` — conservative recovery of JSON from model output: code-fence
  stripping and balanced-value extraction, with **no** quote fixing, trailing
  comma repair or key inference.
- `providers/openai_compatible.ts` — one adapter for OpenAI, OpenRouter, Groq,
  Together, vLLM, LM Studio, llama.cpp and Ollama. Sends no token-limit field
  unless configured (the portable choice), and probes `response_format`,
  permanently falling back when the server rejects it.
- `providers/puter.ts` — opt-in, lazily initialised Puter adapter.

### Added — reasoning (`src/reasoning`)

- Stage schemas distinct from the operation schemas, so the model describes
  findings and TypeScript performs the translation.
- UNDERSTAND (0.2), IMPACT (0.1), CRITIQUE (0.3), EXPLORE (0.6) with shared
  identity and epistemic rules in the prompts.
- `translate.ts` — stage results → draft changeset entries. `basis` maps to
  epistemic status (`stated→known`, `implied→assumed`, `inferred→model_suggestion`);
  model-supplied ids are filtered to those that actually resolve.
- `questions.ts` — deterministic, no model call. At most one question per
  turn, above a threshold, never repeating one already asked.

### Added — research (`src/research`)

- `UrlSourceFetcher` — scheme allowlist, DNS resolved up front with every
  address checked against private/loopback/link-local/CGNAT/multicast ranges
  (v4 and v6, including `::ffff:` mapped forms), manual redirect handling with
  per-hop re-validation (max 3), 15 s timeout, 1.5 MB streaming cap,
  content-type allowlist. HTML extraction strips scripts, styles, comments,
  `noscript`, `template` and `svg`.
- `ResearchService` — fetch first, then extract. Every claim must carry a
  verbatim excerpt, and `excerptOccursIn` discards any claim whose quote is not
  actually in the retrieved document. Survivors become `evidence_supported`
  evidence with `fetched_by_ideno: true`; failures set `research_status:
  'failed'` with the error and a timestamp, and invent nothing.

### Added — plugins (`src/plugins`)

- `PluginRegistry` backing `/api/capabilities`; only genuinely registered
  plugins are listed (v0.1 registers one: `research.url`).
- `canonical/schema.ts` — the renderer-independent `CanonicalDocument`
  contract for future 3D/CAD/simulation plugins. Every object, connection and
  constraint must declare the Idea State items it derives from. **Contract
  only: no extractor, no renderer in v0.1.**

### Added — HTTP API (`src/server`)

- `GET /api/health`, `GET /api/capabilities`
- `GET|POST /api/cases`, `GET|DELETE /api/cases/:id`
- `POST /api/cases/:id/turns`
- `POST /api/cases/:id/changesets/:csId/decision` (`acceptAll` or `acceptedEntryIds`)
- `GET /api/cases/:id/versions`, `GET /api/cases/:id/versions/:index`
- `POST /api/cases/:id/research`
- Zod-validated bodies returning 422 with field-level detail; the error
  taxonomy mapped to status codes; 512 kB body cap; `nosniff` and
  `no-referrer` headers; `x-powered-by` disabled. Frame-blocking headers are
  intentionally omitted so the UI can run in a development preview iframe.
- `main.ts` installs `unhandledRejection` / `uncaughtException` guards and
  graceful shutdown.

### Added — UI (`src/ui`)

- Two-pane workspace: conversation left, live Idea State right.
- Colour-coded epistemic badges with hover explanations on every item;
  origin and confidence shown; invalidated items struck through.
- Pending-change review card: per-entry checkboxes, affected areas, applier
  notes, accept-all / accept-subset / reject-all. Manual review is the
  default, per spec.
- Version timeline with per-version diffs, including what you rejected.
- Research dialog explaining the verification rule, reporting how many claims
  were accepted and how many were discarded as unverifiable.
- Provider panel that states exactly which environment variables are missing.
- Zero UI dependencies beyond React; ~700 lines of hand-written CSS.
- The client imports from `src/core` **as types only**, so the API contract is
  compile-time checked while nothing from core enters the bundle.

### Tests

**171 tests across 7 files**, all passing.

- `orchestrator.mvp.test.ts` — the specification's acceptance scenario end to
  end (greenhouse → balcony → no cloud → alternatives → decision), including
  that the non-linear re-entry into EXPLORE actually fires.
- `patch.test.ts` (21) — every applier invariant.
- `core.test.ts` (20) — ids, schema contracts, state helpers, versioning,
  `KeyedMutex` (serialisation, isolation, poisoning, cleanup).
- `store.test.ts` (23) — both stores against one contract, including a
  ten-way concurrent update with no lost writes, corrupt-file handling and
  path-traversal refusal.
- `ai.test.ts` (39) — JSON recovery, repair loop, provider failover, HTTP
  status mapping, `response_format` fallback, secret non-leakage, timeout vs.
  cancellation.
- `research.test.ts` (48) — SSRF address classification, redirect
  re-validation, extraction, and the excerpt-verification guarantee including
  a mixed batch where one fabricated claim is dropped and a real one kept.
- `api.test.ts` (17) — the HTTP stack over a real socket using the production
  wiring, including the full create → turn → review → partial accept →
  version cycle and the no-provider degradation path.

### Fixed during development

- `MemoryCaseStore` and `FileCaseStore` raised a raw `ZodError` when asked to
  persist invalid state, which the HTTP layer could only report as an
  unexplained 500. Added `validateCase()` in `store/store.ts`; both stores now
  raise a typed `validation_failed`. Found by the store contract tests.
- **Dev server could not boot the client.** The Vite proxy key `'/api'` is a
  prefix match, so it also captured `/api.ts` — the URL of the client's own
  `src/ui/api.ts` module. The request was proxied to the API server, which
  answered with the SPA fallback, so the browser received HTML where it
  expected JavaScript and the app never mounted. Anchored the proxy to
  `'^/api/'` (a regular-expression key). Verified by walking the entire
  12-module dev graph and asserting every module is served as JavaScript.

### Known limitations

- DNS-rebinding TOCTOU remains possible in the research fetcher.
- No historical state reconstruction (`materializeVersion`); per-version diffs
  are available, full replay is not. No schema change needed to add it.
- No authentication — single-user, localhost-first.
- No streaming responses.
- **No live-provider call has been made.** The development environment has no
  egress to any model host. The suite verifies Ideno's own behaviour with a
  scripted provider; prompt quality against a real model is unverified.
