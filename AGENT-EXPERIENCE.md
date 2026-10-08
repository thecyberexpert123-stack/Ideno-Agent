# Agent Experience Log

A candid record of how Ideno v0.1 was built: what was decided and why, what
went wrong, what the tests caught, and what remains unverified. Written for the
next person — possibly me — who has to change this code.

---

## v0.1 — 2026-10-08

### The framing decision that shaped everything

The brief said: *not ChatGPT with a sidebar*. It would have been easy to build
exactly that and call the sidebar an "Idea State". The structural difference
turned out to be one rule:

> **The model never writes state.**

Stages return findings in their own vocabulary (`src/reasoning/schemas.ts`);
plain TypeScript translates those into operations
(`src/reasoning/translate.ts`); one guarded function applies them
(`src/core/patch.ts`). Everything else followed. A hallucinated item id is not
*rejected* — it is **not expressible**. That is a much stronger guarantee than
any amount of prompt discipline, and it is why the epistemic rules are tests
rather than instructions.

The second-order benefit was unexpected: the stage contracts got small, which
is exactly what small local models need to comply.

### Research: the specification's hardest requirement

"Never present an unsupported model guess as research" cannot be achieved by
asking a model not to. A model asked to "research X" will answer from memory in
a tone indistinguishable from citation.

The pipeline is therefore ordered so the guarantee is structural:

1. Fetch the source **first**. The model only ever sees retrieved text.
2. Require a verbatim `excerpt` on every claim.
3. Check each excerpt against the document. If it is not there, the claim dies.

Step 3 is seven lines (`excerptOccursIn`) and it is the whole feature. A test
feeds a mixed batch — one real quote, one fabricated — and asserts exactly one
survives.

Deciding the normalisation threshold took some thought: too strict and
whitespace differences kill real quotes; too loose and a paraphrase sneaks
through. Normalising whitespace and case with a 12-character minimum rejects
paraphrases while tolerating formatting.

### What the tests actually caught

Writing tests after the implementation found three things. Honest accounting:

1. **A real defect.** Both stores called `IdeaCaseSchema.parse()` and so threw a
   raw `ZodError` on invalid state. The HTTP layer could only map that to an
   unexplained 500, losing the typed taxonomy the whole error design exists for.
   Fixed with a shared `validateCase()` raising `validation_failed`.
   *The store contract test found this, not inspection.*

2. **Two cases of testing at the wrong layer.** I wrote provider-level tests
   asserting that an empty completion and an abort produce typed errors. They
   failed — because both are handled once in `AIRuntime`, deliberately, so that
   every adapter inherits them. The implementation was right and the test was
   wrong. I moved the assertions to the runtime and added a comment in the
   adapter explaining why it rethrows a raw abort. Worth recording: a failing
   test is not automatically a defect.

3. **A bug no test would have caught, found by being suspicious.** After
   everything was green I poked the running dev server by hand instead of
   trusting the build. `/api.ts` — the client's own API module — was being
   served as HTML. Vite's proxy key `'/api'` is a *prefix* match, so it
   captured `/api.ts` and forwarded it to Express, which answered with the SPA
   fallback. The browser got HTML where it expected JavaScript and the app
   would never have mounted. Three things conspired: a prefix-matching proxy,
   a UI module whose name collides with the API namespace, and a catch-all
   fallback that returns 200 instead of 404. Every automated check passed
   throughout — typecheck, lint, 171 tests, and the production build, which is
   unaffected because built assets have hashed names. Fixed by anchoring the
   proxy to `'^/api/'`, then verified by walking all twelve dev modules and
   asserting each one is served as JavaScript. **Lesson: "the build succeeds"
   and "the app runs" are different claims.**

4. **A sloppy security assertion.** My first "no credentials in the payload"
   test regex-matched `/key|token|secret/` and failed on the *field name*
   `openaiApiKeySet` — a boolean, not a credential. The weak test was replaced
   with a real one: configure an actual secret, then assert the secret *value*
   never appears in the response. That test has teeth; the first one did not.

### The sandbox fought back

**`api.puter.com` is unreachable here.** Discovering *how* it fails mattered:
`init()` fires a background request whose rejection nobody awaits, surfacing as
an unhandled rejection ~90 seconds later — which by default kills a Node ≥ 15
process. A provider that is merely *configured but unreachable* must not be
able to take down the server. Hence: the Puter adapter is constructed only when
a token exists, initialised lazily on first use, and `main.ts` installs an
`unhandledRejection` guard. Three mitigations for one empirically observed
behaviour, none of which I would have written from the documentation alone.

**Probe scripts cannot live in `/tmp`.** Node resolves modules by walking up
from the script's directory, so `/tmp/probe.cjs` cannot `require` anything from
the project. Obvious in hindsight; cost ten minutes.

### Things I decided not to build

Recording these so they are not mistaken for oversights:

- **Browser-side orchestration** (ADR 0001). Puter's keyless model is genuinely
  attractive, but the applier has to be authoritative or the invariants become
  suggestions. A local OpenAI-compatible endpoint delivers the same "no key, no
  data leaves the machine" property and is testable.
- **A browser-bridge provider.** It would make the keyless path work. It is
  also unverifiable in this environment, and I will not ship code I cannot
  exercise. `AIProvider` is an interface; it can be added without touching core.
- **`materializeVersion(case, index)`.** Faithful replay needs the exact ids
  minted at the time. `VersionRecord.operations` stores everything required, so
  it can be added later without a schema change. Per-version diffs ship; full
  historical reconstruction does not.
- **A fifth model call to compose the reply.** The reply is assembled in
  TypeScript from stage summaries. One less failure mode, and the prose cannot
  drift from the state it describes.
- **An LLM for question selection.** Deciding whether to interrupt a human is a
  product decision. It should be a tunable scoring function someone can read,
  not a per-turn model judgement. Five lines of arithmetic, zero latency.
- **A UI component library.** The entire visual language of this product is
  "these six epistemic statuses never look alike". That is CSS custom
  properties, not a design system. ~700 lines, zero dependencies.
- **Seeding a demo case so the preview looks impressive.** The output would be
  generated by a scripted test provider. Showing it as if it were real product
  output is exactly the kind of fabrication this project is built to prevent.
  The UI shows its honest empty state.

### What I got wrong along the way

- **First `KeyedMutex` implementation** raced the queue tail against a `Symbol`
  marker to decide when to clean up the map. I could not convince myself it was
  correct, which is reason enough to delete it. Replaced with an explicit
  `waiting` counter. "I cannot explain why this is correct" is a bug report.
- **The scripted test provider initially keyed replies by stage purpose alone.**
  That broke the moment a test replayed the same turns in a different order.
  Fixed by making the routing key injectable, so the MVP test routes on
  `"<purpose>:<turn>"` by parsing the user message out of the prompt. Side
  benefit: it proves the context builder really does expose item ids, because
  the scripted replies read generated ids back out of the prompt.
- **`exactOptionalPropertyTypes` is off.** With it on, every optional field
  needs a conditional spread. I had already written a dozen
  `...(x === undefined ? {} : { x })` before deciding the ceremony was not
  buying anything here. Honest trade-off, not an oversight.

### Verification status — exactly what was and was not run

Run, with output observed:

- `npx tsc -p tsconfig.json --noEmit` → exit 0
- `npx eslint .` → 0 problems
- `npx vitest run src/tests/` → **7 files, 171 tests, all passed**
- `npm run build` → server to `dist/`, client to `dist/ui/` (26 modules,
  249 kB JS / 18 kB CSS); confirms no core module reaches the bundle
- Both servers started; `GET /api/capabilities` and `POST /api/cases` verified
  through the Vite proxy at `:5173`, confirming the browser never needs to know
  the API port
- The dev module graph walked end to end (12 modules from `main.tsx`), each
  asserted to be served as JavaScript rather than an HTML fallback

**Not run, and not claimable:**

- **No call to a real model, ever.** No egress to any model host from this
  environment. Everything about prompt quality, model compliance with the stage
  schemas, and whether the repair loop actually recovers real-world malformed
  output is **unverified**. The suite verifies Ideno's behaviour *given* model
  output, which is a different claim.
- No browser-based UI testing. The UI compiles, builds, type-checks against the
  live API contract, and serves — but no automated interaction test exists.
- No load, soak or multi-user testing.

### For whoever picks this up

1. **Point it at a local model first** (Ollama / LM Studio, two environment
   variables). That is the fastest way to find out whether the prompts hold up,
   which is the single largest unverified risk.
2. **`src/core/patch.ts` is load-bearing.** Change it only with a test in hand.
3. **If you add a provider,** implement `AIProvider` and register it in
   `src/server/container.ts`. Do not let provider specifics leak upward — the
   whole topology depends on that boundary holding.
4. **If you add a plugin,** register it honestly. A registry that lists things
   that do not work is worse than an empty one.
