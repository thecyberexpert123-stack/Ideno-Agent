# Agent experience log

What actually happened while building Ideno v0.1: the decisions that were hard,
the mistakes that were made, how they were caught, and what changed as a result.
This is written to be useful to the next person (human or agent) who picks the
project up, so it records wrong turns as well as right ones.

---

## 1. Starting point

The repository contained exactly one file: a 14-byte `README.md` reading
`# Ideno-Agent`. One commit, no dependencies, no configuration, no CI. So "inspect
the existing stack and reuse what is there" resolved to: choose a stack, and be
able to justify every part of it.

The first useful act was checking what the environment could actually do — Node
22.22.3, npm reaching the registry, and **no network route to `js.puter.com` or
`api.puter.com`**. That single fact shaped the whole test strategy: the Puter
integration could never be exercised live here, so it had to be tested against a
fake SDK implementing the documented surface, and the honest limitations had to be
written down instead of implied.

---

## 2. Mistake: invented URLs

Early on, two `fetch_page` calls were made against URLs that were **constructed
rather than observed** — proxy-style URLs with plausible-looking signatures. Both
returned `SignatureDoesNotMatch`. No harm done, but it is exactly the failure mode
this project is designed to resist: a confident-looking citation that was never
real.

The correction was procedural: from then on, every documentation claim came from a
URL that had actually appeared in a search result or a fetched page, and every API
claim came from an artifact that could be read locally. `docs/RESEARCH.md` exists
partly as a record of that discipline — including a section titled "Not verified".

**Lesson:** if a fact cannot be traced to something that was actually read or
executed, it belongs in the assumptions column, not the facts column.

---

## 3. The docs and the shipped package disagreed

Puter's documentation page shows `puter.ai.chat(prompt, testMode, options)` among
its syntax forms, and a widely-copied tutorial calls
`puter.ai.chat(messages, false, options)`. Writing that call and typechecking it
against the installed SDK produced:

```
error TS2769: No overload matches this call.
  The last overload gave the following error.
  Type 'false' has no properties in common with type 'ChatOptions'.
```

The shipped `types/modules/ai/chat.d.ts` says that for a **messages array** the
signature is `chat(messages, options, testMode?)`. The types were right and the
prose was describing a different overload.

**Lesson:** verify against the artifact you are actually going to consume, not
against the description of it. Installing the package and reading its `.d.ts`
settled in minutes what arguing from documentation would not have settled at all.
It also produced two facts that shaped the design: `ChatOptions` has **no
`response_format`** (so structured output cannot rely on the provider) and **no
abort signal** (so cancellation has to be a promise race, with the billing
consequence documented).

---

## 4. The bug that justified the whole validation layer

The first run of the state-manager suite failed 17 of 40 tests. Most traced back to
one root cause, and it was subtle enough to have shipped:

`ChangeRecord.draft` was typed as an untagged union of every draft schema. Zod
tries union members in order. Every item draft accepts `{text: string}` and
defaults everything else — so a **constraint** draft parsed successfully as a
**requirement**, silently losing `category` and `hard`, and then blew up three
layers later when it was written into the constraints collection with an illegal
status.

Nothing crashed at the point of the mistake. The corruption surfaced as a confusing
downstream rejection, which is the worst possible place to discover it.

Two fixes, both structural:

1. `DRAFT_SCHEMA_FOR_KIND` — validation dispatched on the change kind, with a schema
   refinement so a persisted `ChangeRecord` re-validates its draft against the right
   schema on load.
2. `buildChangeRecords` parses the incoming change set through `ChangeSetSchema`
   first, so a caller handing over a plain object is held to the same contract as a
   model response arriving through the orchestrator.

**Lesson:** unions of "anything shaped roughly like this" are how structured data
systems quietly lose fields. If a discriminator exists, use it. And write the test
that asserts the *specific* fields survived, not just that something was stored.

---

## 5. Fighting the type system where it was right

Several frictions were worth keeping:

- **Circular inference.** `IdeaCase` referenced `VersionRecord`, which snapshotted
  an `IdeaCase`. TypeScript inferred `any` and said so (`TS7022`). The tempting fix
  is `z.lazy` plus a type annotation; the real fix was noticing the cycle only
  existed because the case and the snapshot were the same type. Splitting out
  `IdeaCaseBody` made the graph acyclic and deleted the need for laziness entirely.
- **`noUncheckedIndexedAccess`** turned roughly a dozen silent `possibly undefined`
  accesses into compile errors, mostly in array-first-element reads. Every one was a
  real latent crash.
- **`noUnusedLocals`** caught three pieces of dead scaffolding I had written to
  silence other errors — including two exported constants whose only purpose was to
  make an unused-variable warning go away. Deleting them was the fix; exporting them
  would have been junk in a public surface.
- **Zod v4 defaults on nested objects.** `.default({})` does not compile when the
  inner fields have their own defaults: the default value must satisfy the *output*
  type. Writing the defaults out explicitly was mildly annoying and completely
  clearer.

---

## 6. Where the design was genuinely uncertain

### How much should the user have to click?

The brief asks for two things that pull against each other: "the state should update
when Ideno changes its understanding" and "allow the user to inspect changes rather
than silently changing everything", with an Accept/Reject example. Apply everything
and the review is theatre; queue everything and the five-step acceptance scenario
needs about forty clicks.

The resolution was to notice that the two categories are not symmetric. A constraint
the user literally typed is not a proposal awaiting approval — it is their input, and
asking them to approve it is friction, not governance. An assumption Ideno derived is
a claim about the world that could be wrong, and that *is* worth a decision. Hence
`assisted` (default) versus `strict`, with the rule stated in code
(`shouldAutoApply`) and tested.

Two follow-on effects only appeared once the scenario was running:

- Proposed items had to be **visible in the state panel in place**, or the first turn
  looks like nothing happened. They render styled as proposals with their own
  Accept/Reject.
- The scripted demo depends on ids that only exist once earlier proposals are
  accepted. That is not a demo artefact — it is the real dependency a user resolves by
  reviewing the queue. The demo therefore accepts and **says so in the transcript**,
  rather than hiding the mechanism.

### Where does critique output live?

The brief's canonical list has no home for "these two recorded items contradict each
other". Forcing it into `assumptions` or `unknowns` would have been dishonest data
modelling. Adding a `findings` collection was a deviation from the specified
minimum — justified because the brief says "at minimum", and because critique is an
explicit requirement that has to land somewhere queryable.

### Should a research plugin ship?

It would have been easy to wire Puter's `web_search` tool and call the result
research. The citation payload is not documented in a way that supports per-claim
attribution, and community reports describe annotations arriving empty. Shipping that
would have put **fabricated citations into a system whose entire purpose is to
distinguish known from assumed** — the one unforgivable defect here. So v0.1 ships the
interface, the registry, the evidence pipeline and manual evidence entry, and
`docs/RESEARCH.md` records precisely why the automated source is missing.

---

## 7. Bugs the acceptance test caught that no unit test would have

Running the five-step scenario end to end produced failures that were about
*interaction*, not logic:

- **Ordering of review and assertion.** Turn 2 invalidates a constraint, but the
  invalidation is an inference, so it is still pending when the test looked for it.
  The test was wrong, and fixing it made the review policy's behaviour explicit in the
  assertions rather than incidental.
- **A question asked but never recorded as asked.** The model proposes an open
  question and asks it in the same turn; the question item was still pending when
  `markQuestionAsked` looked for it, so the next turn happily asked again. The fix was
  to derive "already asked" from the transcript at apply time — one source of truth,
  no duplicate bookkeeping.
- **The UI rendered every message twice.** A render counter desynced from the DOM when
  the conversation pane was detached (the demo starts with no session, so the left pane
  briefly shows the start screen). Rather than patch the counter, it was deleted: the
  DOM is now the counter. That removes the whole class of bug instead of one instance.

**Lesson:** a scenario test is not a bigger unit test. It finds the defects that live
in the seams between components that each behave correctly alone.

---

## 8. The parser that refused my own data

The canonical projection reported: `Could not parse the flow dimension "200 mL/min" of
"Peristaltic pump"; it was omitted.`

That was my demo content, not a model's. A flow rate had been written into a
`dimensions` map whose contract is lengths normalised to millimetres. The tempting fix
was to loosen the parser; the correct one was to move the value into `properties`,
where non-geometric attributes belong.

It was a small thing, but it is the anti-fabrication rule working on its author: the
system refused to silently reinterpret a number it did not understand, and reported
the refusal where it would be seen.

---

## 9. Tooling notes worth keeping

- Vitest's `test` block in `vite.config.ts` needs `defineConfig` from
  `vitest/config`, not from `vite`. The error is easy to misread as a config mistake.
- Per-file `// @vitest-environment jsdom` kept the DOM suite isolated. The core suites
  stay on Node, which is faster and avoids any question about which `structuredClone`
  is in scope. A test asserts the state manager still works under jsdom, because that
  question deserved an answer rather than an assumption.
- Vite 8's rolldown build handles the Puter SDK's mixed CJS/ESM polyfills with two
  warnings. They come from the SDK's own files, the build succeeds, and the warnings
  are documented rather than suppressed.
- A dynamic `import()` inside the provider adapter is what keeps a 492 KB SDK out of
  the main bundle. That was verified by inspecting `dist/`, not assumed from the
  configuration.

---

## 9b. A rule worth making executable

Late in the build I checked the brief's hardest structural requirement — "the Ideno
core must never contain provider-specific logic" — with a grep. It failed:
`core/schemas/session.ts` carried `puter_model` and an `openai` block. Settings are
data rather than logic, so it was defensible, but "defensible" is not the same as
"clean", and the orchestrator was reading a `Settings` type that included fields it
had no business knowing about.

The fix was a small split: behaviour settings (review mode, temperature, timeout,
context window) stayed in core; provider ids and endpoint configuration moved to
`ai/settings.ts`; the orchestrator now takes `() => BehaviourSettings` and cannot see
a provider field even by accident.

Then I made the rule a test. `tests/architecture.test.ts` loads the sources through
Vite's `import.meta.glob(..., {query: '?raw'})` and asserts that no provider name
appears in `src/core` or `src/reasoning`, that no concrete adapter is imported
outside `src/ai`, that the Puter SDK is only ever imported dynamically, that core
state modules do not import upward, that the reasoning layer never touches the DOM,
and that no UI file assigns to `innerHTML`.

It paid for itself immediately: the DOM check flagged `src/reasoning/context.ts`,
which turned out to contain `const window = transcript.slice(-turns)` — a local
variable shadowing the global in the one layer that must stay DOM-free. Renaming it to
`recent` was trivial; finding it by reading would not have been.

**Lesson:** architectural rules that are only written down decay. The ones worth
keeping are cheap to encode as tests, and the test usually finds something on the day
it is written.

---

## 10. What I would do differently

1. **Write the acceptance scenario test first.** It was written after the core and
   immediately found four interaction defects. Writing it first would have made the
   review-policy consequences visible during design rather than during debugging.
2. **Model the draft/kind relationship earlier.** The union bug cost the most time of
   anything in this build, and it was a design choice made in the first hour.
3. **Keep a render counter out of the DOM from the start.** Any duplicated bookkeeping
   between state and view will eventually disagree.
4. **Write the architecture tests first, not last.** They found a shadowed `window`
   and a provider-coupled settings schema, both of which had been in place for hours.
5. **Budget more time for the prompts.** They are the least testable and most
   consequential part of the system, and v0.1 has only validated that they are
   well-formed and correctly assembled — not that a given model follows them well. That
   needs a live provider and a review of real transcripts, which the sandbox could not
   do.

---

## 11. Verification honesty — what was and was not proven

**Proven by execution:** 275 tests pass (`npm test`); `tsc --noEmit` is clean under
strict settings; `vite build` succeeds and emits the expected chunks; the dev server
serves the app and transforms every module; the full application boots in jsdom, runs
the scripted scenario, renders the resulting state, persists it and restores it on a
second boot.

**Not proven:** any live model call. No Puter request, no OpenAI-compatible request,
and no real model's adherence to the prompt contract was exercised, because the build
sandbox has no route to those services. Cross-browser rendering was not checked
beyond the production build and jsdom. The Puter sign-in popup inside an iframe is
expected to be blocked by browser policy in some contexts; that path is handled and
reported, but it could not be observed here.

Anyone picking this up should do that smoke test first: point Ideno at a provider with
network access, send "I want to build a small autonomous greenhouse.", and read what
comes back.
