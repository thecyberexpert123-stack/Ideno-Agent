# Ideno

**An idea-development system.** You give it a rough idea — incomplete, badly
explained, half-formed — and it turns it into a structured, versioned **Idea
State** that keeps getting more precise as you talk.

Ideno is not a chatbot with a sidebar. The conversation is the interface; the
product is the state on the right-hand side of the screen:

```
IdeaCase
├── title, original_idea, current_intent
├── requirements[]        what the idea must do
├── assumptions[]         what it currently rests on (and what breaks if wrong)
├── constraints[]         what cannot be traded away
├── unknowns[]            named gaps, ranked by how much they block
├── evidence[]            claim / source / relevance / confidence / timestamp
├── research_items[]      questions that need facts, not opinions
├── alternatives[]        genuinely different approaches (+ component graphs)
├── decisions[]           what you chose, and why
├── rejected_approaches[] what you turned down, and why
├── open_questions[]
├── findings[]            contradictions, risks, hidden dependencies
├── current_state         derived from the data, never asserted by a model
└── version_history[]     a full snapshot per version, with a parent link
```

Every item carries a **provenance**, so you can always tell these apart:

| Provenance | Meaning |
| --- | --- |
| `user_stated` | Known — you said it |
| `model_inferred` | Assumed — Ideno derived it, nobody confirmed it |
| `unknown` | A named gap |
| `evidence_supported` | Backed by an evidence record with a real source |
| `model_suggestion` | Ideno's proposal, or its own recollection of the world |
| `user_decision` | You chose it |

A model cannot award itself `evidence_supported` or `user_decision`: those fields
are not in its output contract, and Core derives them from where a thing actually
came from.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm test             # 320 tests, no network, no keys
npm run build        # typecheck + production bundle
npm run typecheck
```

Then either:

- **Run the labelled offline demo** — one click on the start screen. It replays
  the five-step acceptance scenario with no model, no network and no key, so you
  can see the whole loop work. Every turn is marked as scripted.
- **Use a real provider** — open Settings.

### Running it as a Linux desktop application

The same bundle also runs as a native window, hosted by Python, with the workspace
stored as JSON files instead of in browser storage:

```bash
npm ci && npm run build                    # build the web app once
pip install ./desktop                      # the host
pip install "pywebview[qt]"                # a web engine: Chromium via PyQt6
ideno --check                              # what this machine can run
ideno                                      # open the window
```

`ideno --browser` serves the same app on loopback and opens your own browser, which
needs no web engine at all. Full details, the storage layout, the security posture
and exactly what has been verified are in [`desktop/README.md`](desktop/README.md).

Why it matters beyond convenience: a browser gives an origin roughly 5 MB of
`localStorage`, and Ideno's full-snapshot version history reaches that after about
170 edits — past which nothing can be saved. On the desktop the workspace lives on
disk, where the limit is the filesystem's.

### Providers

| Provider | What you need | Notes |
| --- | --- | --- |
| **Puter.js** (default) | A free Puter account, signed in from the browser | No API key in this codebase. Puter's user-pays model bills your Puter account. The SDK lives in its own chunk and is fetched only while Puter is the selected provider — which, being the default, means on first load. |
| **OpenAI-compatible** | A base URL and (usually) an API key | Works with OpenAI, OpenRouter, Azure OpenAI, vLLM, llama.cpp, LM Studio, Ollama's OpenAI endpoint. |
| **Scripted demo** | Nothing | Replays the fixed scenario. Never calls a model. |

Adding a provider means adding one file in `src/ai/providers/` that satisfies
`AIProvider`, one case in `src/ai/factory.ts`, and one entry in `ProviderIdSchema`.
Ideno Core contains no provider-specific logic.

---

## The acceptance scenario

This is the exact conversation the prototype is built to handle, and it is a
**test**, not a claim — `tests/orchestrator.test.ts` runs it end to end through
the real orchestrator, state manager and versioning:

| You say | Ideno does |
| --- | --- |
| *"I want to build a small autonomous greenhouse."* | Restates the goal, extracts implied requirements, names assumptions (mains power? cloud control?), ranks the blocking unknowns, asks **one** question |
| *"It has to fit on a balcony."* | Adds a hard physical constraint, invalidates the vague "domestic setting" one, resolves the placement unknown, adds weather exposure |
| *"I don't want cloud connectivity."* | Recognises an **architecture change**: invalidates the control-path assumption, records the hidden dependency (no remote monitoring, no OTA updates), adds a local-interface requirement |
| *"Show me alternative architectures."* | Three approaches that differ in kind, each with tradeoffs tied to recorded items and a component graph (objects, dimensions, connections, constraints) |
| *"Let's use the second one."* | Records your decision, marks the other two rejected **with reasons**, invalidates the now-irrelevant mains-power assumption, defers the now-moot outlet question |

Click **Run the labelled offline demo** to watch it happen.

---

## How a turn works

```
your message
   ↓
Orchestrator          derives the operation from the state, not the message count
   ↓
prepareOperation      Idea State → compact id-carrying digest + bounded transcript window
   ↓                  (never an uncontrolled conversation dump)
AIRuntime             timeout → provider → JSON extraction → zod validation → one repair round-trip
   ↓
buildChangeRecords    Core mints every id, resolves/prunes references, downgrades
   ↓                  unsubstantiated evidence claims
review policy         what you said → applied · what Ideno inferred → Accept / Reject
   ↓
applyRecords          applied to a clone, then the whole body is re-validated
   ↓
version               snapshot + parent_id, summary derived from an actual diff
   ↓
follow-ups            critique / explore / research run against the *updated* state
```

The loop is not a rigid pipeline: a turn can invalidate an assumption recorded
three turns ago and then run a critique against the result. Follow-ups are capped
at two per turn, and a failure stops the turn instead of compounding.

**Questioning discipline is enforced in code**, not only in the prompt: at most
one question per turn, and a question rated low impact — or already asked, or
about an unknown that is resolved — is suppressed and the suppression is recorded.

---

## Architecture

```
src/
├── core/                    no DOM, no provider, no network
│   ├── schemas/             zod schemas = the single definition of the state
│   │                        (behaviour settings live here; provider settings do not)
│   ├── idea_state/          factories, collection registry, derived views
│   ├── state_manager/       the only component that may mutate the state
│   ├── versioning/          snapshots and diffs
│   └── orchestrator/        the turn loop
├── ai/
│   ├── provider_interface/  AIProvider, ChatTurn, capabilities
│   ├── runtime/             validation, JSON extraction, timeout, repair
│   ├── providers/           puter · openai_compatible · scripted
│   ├── settings.ts          provider ids and endpoint configuration
│   └── factory.ts           the only place that knows providers exist
├── reasoning/               prompts, structured context, operation preparation
├── research/                evidence, sources, gap analysis
├── render/                  Idea State → renderer-independent CanonicalScene
├── plugins/                 extension points (no plugins ship in v0.1)
├── ui/                      DOM builder, components, app shell
└── demo/                    the scripted greenhouse scenario
```

Full details, invariants and the reasoning behind each decision:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Verified sources and what could *not* be verified: [`docs/RESEARCH.md`](docs/RESEARCH.md).

### The canonical representation

A future 3D view must not receive natural language and invent a model. It
receives this:

```jsonc
{
  "schema_version": 1,
  "units": "mm",
  "objects": [
    { "id": "obj_reservoir", "name": "Reservoir", "type": "cylinder",
      "dimensions": { "radius": { "value": 90, "unit": "mm", "mm": 90 } },
      "properties": { "capacity": "5.6 L", "sealed": true } }
  ],
  "connections": [{ "from": "obj_reservoir", "to": "obj_peristaltic_pump", "kind": "fluid" }],
  "constraints": [{ "key": "cloud_connectivity", "value": false, "source_item_id": "alt_…" }]
}
```

Three.js would be one consumer; an SVG diagram, an OpenSCAD exporter or a CAD
backend would be others. The **Spec** tab shows the live projection, including
everything it could *not* project (an unparsed dimension, a connection naming a
nonexistent object) rather than hiding it.

---

## Security and privacy

- **No backend, no secrets on a server.** The app is static. Your idea lives in
  your browser's `localStorage` and can be exported as JSON.
- **No `innerHTML` anywhere.** All text — yours and a model's — reaches the DOM
  through `textContent`. A response containing `<img onerror=…>` renders as text.
  There is a test for exactly that.
- **Evidence locators only become links if they are `http(s)`.** A
  `javascript:` URL in a citation renders as inert text.
- **API keys are held in memory by default.** Persisting one is an explicit
  opt-in, with the trade-off stated on screen: anything in `localStorage` is
  readable by every script on the same origin.
- **Plain `http://` endpoints are refused** unless the host is loopback, so a key
  can reach a local model server but never the open internet.
- **Puter.js is pinned** through `package.json` and the lockfile rather than
  loaded from an unpinned CDN script tag.
- Model output is validated before it touches the state, ids are minted by Core,
  references that do not resolve are pruned, and claims of evidence that cite
  nothing are downgraded — with a note.

---

## What v0.1 deliberately does not do

No autonomous background agents, no multi-agent systems, no vector database, no
CAD or physics engine, no authentication, no plugin marketplace, no automated web
research, no streaming. Each is either an extension point that already exists
(`ResearchSource`, `CanonicalRenderer`, `PluginRegistry`) or out of scope until
the core is proven.

**Known limitations, stated plainly:**

- **No automated research source ships.** The pipeline is fully wired — a research
  turn queries every registered `ResearchSource` over the highest-priority open
  questions, converts what comes back into evidence drafts (capped, and proposed for
  your review like anything else), and reports per-source failures — but no source is
  registered, so nothing fetches the web yet. Until then evidence enters the state one
  honest way at a time: **Add evidence** in the Evidence section, where you name a
  source you actually consulted. Puter's `web_search` tool exists, but its citation
  payload is not documented precisely enough to attribute a claim to a source, and
  shipping a source that could not be verified would put fabricated citations into the
  state. See [`docs/RESEARCH.md`](docs/RESEARCH.md).
- **Puter sign-in may be blocked inside a cross-origin iframe.** Puter
  authenticates through a popup, which browsers restrict in embedded contexts.
  If that happens, Ideno says so and offers the other two providers.
- **A Puter request cannot be cancelled mid-flight.** Its documented `chat()`
  takes no abort signal, so Ideno races the promise: your turn stops at the
  timeout, but the upstream request may still complete and be billed.
- **One idea at a time.** The data model is per-session and branching is designed
  for (`parent_id`) but not implemented.
- **Versions store full snapshots.** Correct and simple at this scale; a
  delta-encoded history is the obvious change if workspaces grow large.

---

## Development

```bash
npm run dev           # dev server on 0.0.0.0:5173
npm test              # vitest, 14 files / 320 tests
npm run test:watch
npm run typecheck     # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run build         # typecheck, then bundle to dist/
npm run preview       # serve the production build
```

The desktop host has its own suite, which runs with or without a web engine
installed:

```bash
cd desktop && python3 -m unittest discover -s ideno_desktop/tests -t .   # 78 tests
```

Quality gates: TypeScript strict mode (with `noUncheckedIndexedAccess`,
`noUnusedLocals`, `noUnusedParameters`), zod validation at every trust boundary,
and a test suite covering the schemas, the state machine, the diff, the providers,
the runtime's failure paths, the canonical projection, the rendered DOM — and the
module boundaries themselves (`tests/architecture.test.ts` reads the sources and
fails if provider knowledge ever leaks into `src/core`, if the desktop host is
named anywhere outside its one module, or if the core reaches for `fetch`,
`localStorage` or a Node builtin).

Change history: [`CHANGELOG.md`](CHANGELOG.md).
What was learned building it: [`AGENT-EXPERIENCE.md`](AGENT-EXPERIENCE.md).

## License

Not yet specified by the repository owner. All third-party dependencies are
listed in `package.json` with their own licenses (MIT/Apache-2.0); Puter.js is
Apache-2.0.
