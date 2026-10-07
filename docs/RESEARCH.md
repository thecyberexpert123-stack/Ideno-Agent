# Research log

Everything Ideno is built against that could be checked, was checked. This file
records what was verified, how, and — just as importantly — **what could not be
verified**, so nobody mistakes an assumption for a fact later.

Verification dates: 2026-10-05.

---

## 1. Puter.js — the default provider

### Sources

| Source | What it was used for |
| --- | --- |
| <https://docs.puter.com/AI/chat/> (fetched) | `chat()` syntax, the full options list, response normalisation, function calling, `web_search` tool |
| <https://docs.puter.com/AI/listModels/> (fetched) | `listModels()` return shape, model variants (`:free`, `:flex`, `:priority`) |
| `@heyputer/puter.js@2.6.4` — installed from npm and read locally: `package.json`, `README.md`, `index.d.ts`, `types/modules/ai/chat.d.ts`, `types/modules/ai/types.d.ts`, `types/modules/ai/models.d.ts`, `types/modules/Auth.d.ts`, `src/index.js`, `src/init.cjs` | The authoritative typed surface actually shipped to consumers |
| <https://www.npmjs.com/package/@heyputer/puter.js> | Confirms npm is a first-class integration path alongside the CDN |

### Verified facts

1. **`chat()` overloads.** The shipped declarations give
   `chat(messages: ChatMessage[], options: ChatOptions, testMode?: boolean)`.
   Note the order: the docs page also lists `chat(prompt, testMode, options)`
   forms, but for a **messages array** the second argument is `options`. Ideno
   calls `puter.ai.chat(messages, options)`.
2. **`normalize: true`** forces the OpenAI-style response shape on any vendor, so
   `message.content` is a string. Without it, models released before 2026-09-01
   keep their vendor-native shape (Anthropic returns an array of content blocks).
   The adapter passes `normalize: true` **and** still handles the array form
   defensively, because normalisation is a server-side behaviour.
3. **There is no `response_format` option.** `ChatOptions` (verified in
   `types/modules/ai/types.d.ts`) contains: `model`, `temperature`, `max_tokens`,
   `vision`, `driver`, `provider`, `tools`, `normalize`, `response`,
   `reasoning_effort` / `reasoning.effort`, `verbosity` / `text.verbosity`,
   `image_config`, `compaction`, `context_management`. **No native JSON mode.**
   → Consequence: structured output cannot rely on the provider. Ideno extracts
   JSON from free text (`ai/runtime/json_extract.ts`), validates it with zod, and
   does one repair round-trip. The runtime still passes a `json_mode` *hint* for
   providers that do support it.
4. **There is no abort signal in `ChatOptions`.** → Cancellation is implemented by
   racing the promise (`abortable()` in the adapter). The upstream request cannot
   be revoked; this is documented as a limitation in the README because it has a
   billing consequence.
5. **`puter.ai.listModels(provider?)`** resolves to records that always carry `id`
   and `provider` and may carry `name`, `aliases`, `context`, `max_tokens`, `cost`.
   → The adapter maps and de-duplicates defensively, tolerating entries without an
   `id`, and never assumes a fixed model list.
6. **`puter.auth.isSignedIn(): boolean`** and
   **`puter.auth.signIn(options?)`** exist; `signIn` can reject with
   `{error: 'not_available_in_app'}` or `{error: 'unsupported_origin'}`.
   → The adapter reports `action: 'sign_in'` rather than failing, and surfaces the
   rejection message verbatim.
7. **Browser bundling works.** Verified by running a real Vite 8 library build
   against `import { puter } from '@heyputer/puter.js'`: build succeeded
   (~600 KB), with two benign warnings from the SDK's own polyfills
   (`lib/polyfills/localStorage.js`, `lib/polyfills/xhrshim.js`) that mix
   `module.exports` with ESM `export`.
8. **The Node-only dependency is not in the browser path.** `open` (which spawns
   processes) is required only from `src/init.cjs`, the Node entry point, not from
   `src/index.js`. → Safe to bundle for the browser; no shim needed.
9. **The SDK is code-splittable.** A dynamic `import()` produces a separate chunk:
   the production build emits a 243 KB app bundle and a 492 KB Puter chunk that is
   only fetched when Puter is selected.

### Not verified (and why it matters)

- **No live Puter call was made.** `js.puter.com` and `api.puter.com` are
  unreachable from the build sandbox (`curl` returns no connection), so
  authentication, real model ids, rate limits and billing behaviour were **not**
  exercised. The adapter is tested against a fake SDK that implements the
  documented and typed surface exactly. Anyone with network access should smoke
  test: sign in → send the greenhouse message → confirm a plan comes back.
- **Popup behaviour inside a cross-origin iframe** (how this preview is served) is
  a browser policy question, not an API one. Ideno handles the rejection and
  offers the other providers; it cannot guarantee the popup will be allowed.
- **`web_search` citations.** Puter documents `tools: [{type: "web_search"}]` for
  OpenAI models, but does not document a citation payload shape that Ideno could
  attribute per claim. OpenAI's own Responses API documents
  `annotations[].url_citation` (<https://developers.openai.com/api/docs/guides/tools-web-search>),
  and community reports show annotations frequently arriving empty.
  → **Decision: ship no automated research source in v0.1.** Inventing a citation
  parser against an undocumented shape is exactly how fabricated evidence enters a
  state whose whole purpose is to distinguish known from assumed. The
  `ResearchSource` interface, registry and evidence pipeline are complete, so
  adding a verified source later is additive.

---

## 2. Schema and validation — zod 4

| Check | Method | Result |
| --- | --- | --- |
| Latest version | npm registry `dist-tags` | `latest: 4.6.5` (published 2026-10-02) |
| `z.toJSONSchema` exists | executed in Node against the installed package | ✔ function; produces draft 2020-12 JSON Schema, `additionalProperties: false` |
| `safeParse` error shape | executed | ✔ `error.issues[]` with `path: PropertyKey[]` and `code` |
| `z.iso.datetime()` | executed | ✔ present (the v4 replacement for `z.string().datetime()`) |
| Zero runtime dependencies | npm metadata | ✔ |

Two consequences shaped the code:

- Issue paths are `PropertyKey[]` (a `symbol` is possible), so
  `core/schemas/format.ts` stringifies path segments instead of assuming strings.
  A naive `{path: (string|number)[]}` annotation does not compile.
- Because `z.toJSONSchema` can throw on unrepresentable types, the runtime wraps it
  (`safeToJsonSchema`) and degrades to the hand-written contract in the prompt. A
  test asserts `TurnPlanSchema` stays representable, so a future field cannot
  silently strip the contract out of the prompt.

Rejected alternative: hand-written validators. They would have been more code,
less precise, and would not have given the prompt its JSON Schema for free.

---

## 3. Toolchain

| Package | Version chosen | How verified |
| --- | --- | --- |
| `typescript` | 5.9.3 | registry + `tsc -v` |
| `vite` | 8.3.2 | registry + `vite --version`; rolldown-based build ran successfully |
| `vitest` | 5.0.3 | registry + executed 275 tests |
| `jsdom` | 27.0.1 | registry + executed the DOM suite |

`jsdom` is the only dependency added purely for tests, and only after the UI had
grown real logic (provenance markers, inline proposals, safe link rendering,
version diffs). Vitest's per-file `// @vitest-environment jsdom` keeps the core
suites on the faster Node environment, so `structuredClone` and other Node globals
behave identically in both.

Rejected: ESLint/Prettier. The strict `tsconfig` (`strict`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitOverride`, `useUnknownInCatchVariables`) already catches the classes of
defect a linter would, and adding ~50 packages to a prototype with no contributors
yet is not a trade worth making now. Recorded as a recommendation, not
implemented.

Rejected: React. See `docs/ARCHITECTURE.md` §4.7.

---

## 4. Compatibility details checked rather than assumed

- **Regex lookbehind.** `deriveTitle` originally split sentences with
  `/(?<=[.!?])\s+/`. A lookbehind inside a regex literal is a *parse-time*
  `SyntaxError` on Safari before 16.4, which would take the whole bundle down for
  a cosmetic feature. Replaced with `/^[^.!?]*[.!?]?/`.
- **`structuredClone`** is available in Node 22 and in jsdom 27 (asserted by a
  test that runs the state manager under the DOM environment).
- **Buttons inside forms** default to `type="submit"`; the DOM helper sets `type`
  explicitly so a toolbar button cannot submit the composer.
- **`AbortSignal.any`** was avoided in favour of a manual controller + timer, so
  cancellation behaves identically on older browsers and in tests.

---

## 5. Domain content in the demo script

The greenhouse scenario contains engineering claims (wicking beds, peristaltic pump
flow rates, Li-ion pack sizes, IP ratings, twin-wall polycarbonate). **These are
illustrative content for a scripted demo, not researched facts**, and the demo is
labelled as scripted everywhere it appears. No claim in the script is stored with
`evidence_supported` provenance: alternatives and their specs enter the state as
`model_suggestion`, exactly as a real model's proposals would.

That distinction is the reason the script exists in `src/demo/` rather than in
`src/reasoning/`: it is sample output, not product logic.
