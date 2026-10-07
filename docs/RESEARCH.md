# Research log

Everything Ideno is built against that could be checked, was checked. This file
records what was verified, how, and — just as importantly — **what could not be
verified**, so nobody mistakes an assumption for a fact later.

Verification dates: 2026-10-05 (v0.1), 2026-10-07 (v0.2 — sections 6 to 10).

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


---

## 6. Wikipedia / MediaWiki — which endpoint a browser may actually call

### Sources

| Source | What it was used for |
| --- | --- |
| <https://www.mediawiki.org/wiki/API:REST_API/Reference> (fetched) | REST search result shape: `{id, key, title, excerpt, matched_title, description, thumbnail}`; `excerpt` carries `<span class="searchmatch">` markup |
| <https://www.mediawiki.org/wiki/API:Info> (fetched) | Action API page fields, `inprop=url` → `fullurl`/`canonicalurl`, `lastrevid`, `touched` |
| <https://www.mediawiki.org/wiki/API:Tutorial> (fetched) | **MediaWiki's own browser example calls `/w/api.php?...&origin=*`**; parameter list incl. `generator=search`, `prop=extracts|info`, `exintro`, `explaintext`, `exsentences`, `redirects`, `formatversion=2` |
| <https://api.wikimedia.org/wiki/API_reference/Core/Search/Search_content> (fetched) | `api.wikimedia.org` search is **scheduled for gradual deprecation from July 2026** |

### What this decided

- **The Action API, not REST.** `WikipediaSource` calls `/w/api.php` with `origin=*`
  because that is the combination MediaWiki's own documentation shows being used from
  browser JavaScript. The REST endpoints are documented with server-side examples
  (`requests`), so using them from a browser would rest on an assumption about CORS
  headers I could not verify.
- **Not `api.wikimedia.org`.** Deprecation from July 2026 was read off the reference
  itself, which is close enough to be a maintenance liability for a new dependency.
- **Citations are permalinks.** `/wiki/<title>?oldid=<pageid>` is derived from the
  returned `pageid`, so a finding points at the revision that was actually read rather
  than a page that may change later.
- **Confidence is capped at 0.45** (`MAX_SUMMARY_CONFIDENCE`), because an introductory
  extract is a tertiary summary. It never reaches the threshold at which the orchestrator
  would treat a claim as well-supported.
- Extracts are cleaned with tags removed (not replaced by a space — that produced
  `"wet ."`) and whitespace collapsed.

**Not verified: a live call.** This sandbox has no route to `en.wikipedia.org`, so the
source is tested against an injected `FetchLike`, including malformed JSON, an empty
result set, a page with no extract and a non-2xx response.

## 7. Puter `web_search` — the citation payload

### Sources

| Source | What it was used for |
| --- | --- |
| <https://docs.puter.com/AI/chat/> (fetched) | `stream`, `tools`, `normalize`; **no `response_format`**; **no abort signal**; `web_search` documented as `{model:'openai/gpt-5.6-luna', tools:[{type:'web_search'}]}` |
| `@heyputer/puter.js@2.6.4`, `types/modules/ai/chat.d.ts` (read locally) | Streaming overload → `Promise<AsyncIterable<ChatResponseChunk>>`; `ChatResponseChunk.type` ∈ `text|reasoning|image|tool_use|compaction|extra_content|usage|error`. **`ChatMessage` has no `annotations` field.** |
| OpenAI web-search documentation (fetched) | Chat Completions puts `message.annotations[] = {type:'url_citation', url_citation:{url,title,start_index,end_index}}`; the Responses API nests it differently |

### What this decided

- **Citations are read as `unknown` and validated.** Because the shipped Puter types do
  not declare `annotations`, nothing about their shape can be assumed. `findingsFromResponse`
  walks the value defensively and requires a citation whose `[start_index, end_index)` span
  actually appears in the answer text (`citedSpan`). A URL that is not `http(s)`, a span that
  does not match, or a missing title drops that citation individually rather than failing the
  whole response.
- **Confidence is capped at 0.6** (`MAX_WEB_SEARCH_CONFIDENCE`): a model's own annotation of
  its own answer is weaker than a page the user can open.
- **Off by default, and the model has to look right.** `webSearchModelLooksSupported` checks
  the configured model before the call, because the tool is documented against OpenAI-routed
  models only.
- Community reports that `annotations` is frequently empty are the reason for the gating, not
  an excuse for it: zero findings plus "this answer had no citations" is a correct result.

**Not verified: a live call**, for the same reason as Wikipedia.

## 8. Three.js — the one new runtime dependency

### Sources

| Source | What it was used for |
| --- | --- |
| npm registry metadata for `three@0.186.1` (fetched) | Version currency, licence (MIT), package contents |
| `three@0.186.1` as installed (read locally: `package.json`, `build/three.module.js`, `examples/jsm/controls/OrbitControls.js`) | The actual module surface: `Scene`, `PerspectiveCamera`, `WebGLRenderer`, mesh/geometry/material classes, `OrbitControls` as a separate ESM path |
| `@types/three@0.186.0` | **Three ships no declarations** — verified by reading the installed package's `package.json` (`types` absent) |

### What this decided

- **Dynamically imported, chunked, and never in the main bundle.** `createThreeRenderer`
  takes `loadThree`/`loadControls` thunks, so the plugin registers without loading ~737 KB.
  The production build confirms three separate chunks (`three.module-*.js` 737 KB,
  `OrbitControls` 19.9 KB, main 312 KB).
- **`@types/three` is a devDependency, pinned to the same minor.** Not optional: without it
  `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess` cannot check the renderer.
- **`webglAvailable()` gates registration.** No WebGL, or a failed context, degrades to the
  text renderer with a visible reason rather than a blank canvas.
- Justification against the dependency-discipline rule: MIT licence, the de-facto standard for
  browser 3D with continuous releases, no transitive runtime dependencies, and the alternative
  (hand-rolling WebGL) is far larger and far less maintainable than the dependency it replaces.

**Not verified: rendering.** There is no GPU in this environment. Tested instead: layout
mathematics (axis assignment, diameter vs. sphere spans, missing-axis fallback, placeholder
when no dimension exists, camera distance, grid step), plugin registration, failure paths and
teardown (`dispose()` releases geometries, materials and the renderer).

## 9. pywebview — the Linux desktop host

### Sources

| Source | What it was used for |
| --- | --- |
| `pywebview 6.2.1`, wheel unpacked and installed into a venv, then read (not prose) | `webview.start(func, args, localization, gui, debug, http_server, http_port, user_agent, private_mode, storage_path, menu, server, server_args, ssl, icon)`; `create_window(..., js_api, width, height, min_size, background_color, text_select, zoomable, confirm_close, server, http_port)`; `gui` accepts `'qt' | 'gtk'` on Linux; dispatches a **`pywebviewready`** window event when the JS bridge is live; exports `Menu` but **no `MenuItem`**; runtime deps only `bottle`, `proxy_tools`, `typing_extensions` |

### What this decided

- **`js_api` + `pywebviewready`, not polling.** The web layer waits for the documented event
  before trusting `window.pywebview.api`, so a half-initialised bridge cannot be called.
- **Engines are extras, not core dependencies.** `[qt]` = PyQt6 + PyQt6-WebEngine,
  `[gtk]` = PyGObject. `pyproject.toml` therefore declares only `pywebview>=5.0` and leaves
  the engine choice to the packager, which is also why `ideno --check` reports the engine
  situation instead of guessing.
- **No `MenuItem`.** The menu code was written against what the installed package actually
  exports; an earlier draft imported a name that does not exist.
- **Loopback static server, GET/HEAD only.** Verified by execution against the real server
  object: correct MIME types, cache headers, three path-traversal probes → 404, POST and
  DELETE → 501.

**Not verified: that a window opens.** No `$DISPLAY` and no PyQt6/PyGObject in the sandbox.
`create_window`/`start` were never executed. Everything before them — path resolution, storage,
bridge validation, backend, CLI, build, serve — is tested (78 tests), and `ideno --browser` was
run end to end as a real subprocess.

## 10. What could not be checked, collected

So that no later reader mistakes an assumption for a fact:

| Item | Status |
| --- | --- |
| Live Wikipedia / Puter web-search responses | **Never made.** No network route from the sandbox. Both sources are tested against injected transports |
| Three.js pixels on screen | **Never rendered.** No GPU. Layout and lifecycle tested instead |
| A pywebview window opening on Linux | **Never observed.** No display server, no web engine installed |
| Persistence behaviour in a real browser at the 5 MB boundary | **Measured in-process** against a store that reproduces `QuotaExceededError`/`NS_ERROR_DOM_QUOTA_REACHED`, not in a browser |
| Streaming against a live Puter endpoint | **Never made.** Tested against a scripted async iterable matching the shipped `ChatResponseChunk` type |
| Live Tavily responses, from TypeScript or Python | **Never made.** `api.tavily.com` is unreachable from the sandbox (`curl` → `connect=000`). Both paths tested against an injected transport and a stubbed `urlopen` |
| **Whether Tavily permits browser-side (CORS) calls** | **UNVERIFIED, and it matters.** See §11. No documentation or search result states the policy, and every documented example is server-side |
| `GET /models` against a live OpenAI-compatible server | **Never made.** All three response shapes tested against an injected `DiscoveryFetch` |
| The agent-profile and Tavily Settings UI in a real browser | **Never exercised in a browser engine.** Tested through jsdom against the real component (38 tests), which covers logic and rendering but not layout, focus, or engine-specific behaviour |

## 11. Tavily Search API — and the CORS question that could not be settled

### Sources

| Source | What it was used for |
| --- | --- |
| `https://docs.tavily.com/documentation/api-reference/endpoint/search` | Endpoint, headers, request body, response shape, status codes |
| `https://docs.tavily.com/documentation/api-reference/introduction` | Auth model, credit costs, keyless mode |
| Tavily SDK reference (same docs) | That the JS SDK is `require("@tavily/core")` — a Node package, not a browser one |
| `curl https://api.tavily.com/` from the build environment | **`connect=000` — host unreachable.** An `OPTIONS` preflight probe returned no CORS headers at all |

### Verified facts

- **`POST https://api.tavily.com/search`.** Headers: `Authorization: Bearer tvly-YOUR_API_KEY`
  (**required**) and `Content-Type: application/json`. Optional: `X-Project-ID`,
  `X-Session-Id`, `X-Human-Id`.
- **Only `query` is required** in the body (keep it under 400 characters). Notable optional
  parameters: `search_depth` (`ultra-fast | fast | basic | advanced`, default `basic`;
  **advanced costs 2 credits vs 1**), `max_results` (0–20), `chunks_per_source`, `topic`
  (`general | news | finance`), `time_range`, `start_date`/`end_date` (YYYY-MM-DD),
  `include_answer` (`false | "basic" | "advanced"`), `include_raw_content`,
  `include_domains` (≤300) / `exclude_domains` (≤150), `country`, `language`,
  `include_images`, `include_published_date`, `safe_search`, `include_usage`.
- **Response 200:** `{ query, answer?, results: [{ title, url, content, score, raw_content?,
  published_date?, id }], images?, response_time, request_id?, usage? }`.
- **`score` is a 0–1 relevance float**, and **every result carries `title` and `url`** — which
  is what makes Tavily usable behind Ideno's citation-integrity gate at all.
- **Documented status codes:** 200, 400, 401, 422, 429, 432, 433, 500. (432/433 are
  Tavily-specific and are mapped to explicit user-facing messages rather than a generic
  failure.)
- Other endpoints exist — `/extract`, `/crawl`, `/research` (plus `GET /research/{request_id}`,
  SSE streaming), `GET /usage` — none used here.
- A **keyless** mode exists (`X-Tavily-Access-Mode: keyless`, rate-limited; a valid
  `Authorization` header takes precedence). Not used: Ideno would rather report "no key is set"
  than silently consume a shared, rate-limited allowance the user did not ask for.
- Free tier ≈ **1 000 credits/month**.

### What this decided

- **`include_answer` is never sent.** Tavily's `answer` is a synthesised summary. Presenting it
  as evidence would put a model suggestion in the evidence panel with a citation attached,
  which is exactly the failure the product exists to prevent. Only `results[]` become findings.
- **Confidence is capped at `0.6` and scaled by `score`.** A search engine's top hit and its
  tenth are not equally trustworthy; a flat confidence would let a weak result outrank a strong
  one. A result with no `score` gets half the ceiling; results below `0.2` are dropped.
- **Schemas validate shape, usability lives in the mapping** — the lesson from §6 and the Puter
  `annotations` work, applied again. One malformed row cannot fail a whole response; it is
  dropped individually.
- **Two transports, feature-detected**, because the docs are uniformly server-side (see below)
  and the desktop host is the path that is actually known to be sound.
- **The Python host is not a proxy.** `websearch.py` uses stdlib `urllib` only — no new
  dependency — and `TAVILY_URL` is a module constant, never caller input.

### Not verified, and why it matters

**Whether Tavily allows browser-side calls is UNVERIFIED.** This is the single largest open
risk in v0.3, and it is stated here so no later reader assumes it was settled:

- `api.tavily.com` is **unreachable from the build environment** (`curl` → `connect=000`), so
  no live preflight could be observed. An `OPTIONS` probe returned **no CORS headers at all**,
  which is consistent both with "blocked" and with "the probe never got through".
- **No documentation page and no search result states a CORS policy** for the Search API.
- **Every documented example is server-side** — curl, Python, JS via `require`, PHP, Go, Ruby,
  Java. There is no browser example, and the official JS SDK is `require("@tavily/core")`, a
  CommonJS Node package.

The practical consequence for anyone debugging this: **a browser CORS block surfaces as a
`TypeError` / "Failed to fetch" with no status code**, which is indistinguishable from a dead
network or a wrong URL. A 401 or 429, by contrast, is reported specifically because those
arrive with a status. So if Tavily returns nothing in a browser while working from the desktop
app, suspect CORS before suspecting the key.

**The desktop path is the one to rely on.** It is also the stronger position for the secret:
Python reads the key from the payload *or* from `TAVILY_API_KEY` in the environment, so a user
can keep it out of the browser entirely.

This mirrors §6 (Wikipedia), where the same constraint produced the same discipline: only
injected-`fetch` tests are possible, so the tests verify the request shape, the mapping and the
failure handling, and the document records that the live service was never contacted.
