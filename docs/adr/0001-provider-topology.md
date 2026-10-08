# ADR 0001 — Provider topology: server-side orchestration

- **Status:** Accepted
- **Date:** 2026-10-08
- **Scope:** v0.1

## Context

The specification names Puter as the v0.1 provider. Puter.js is a keyless,
serverless AI gateway on a *User-Pays* model: the end user signs into a Puter
account in the **browser** and pays for their own usage, so the developer needs
no API key. That property strongly suggests running the model calls in the
browser.

Ideno also has a hard requirement that structured state is the source of truth
and that model output is validated before it can mutate anything.

## Options considered

**A. Browser-side orchestration.** The client calls `puter.ai.chat()` directly;
the server stores whatever the client sends.

**B. Server-side orchestration.** The server owns the loop and the state; the
provider adapter runs in Node.

**C. Server-side orchestration with an optional browser bridge.** As B, plus a
long-poll endpoint letting a browser tab act as the transport for a keyless
browser-only provider.

## Decision

**B for v0.1, with the architecture left open for C.**

## Rationale

1. **The applier must be authoritative.** The anti-fabrication invariants in
   `applyOperations` — quote verification, evidence requirements, status
   downgrades — are the product. If the browser proposes *and* applies, they
   become suggestions that a modified client can ignore. They have to be
   enforced on the side that owns the data.
2. **Durability.** State must survive a closed tab and be shared across
   devices. That means a server store, which means the server is already in the
   write path.
3. **Testability.** A Node-side adapter can be exercised deterministically with
   a scripted provider and a mocked `fetch`. Browser-side model calls cannot be
   covered by the test suite at all. 171 of the tests in this repository depend
   on this choice.
4. **Portability beats keylessness.** One OpenAI-compatible adapter covers
   OpenAI, OpenRouter, Groq, Together, vLLM, LM Studio, llama.cpp and Ollama.
   A local model gives the same "no API key, no data leaves the machine"
   property as Puter, without browser-only transport.

Puter is still supported server-side via `IDENO_PUTER_AUTH_TOKEN`
(`init(token)` from `@heyputer/puter.js/src/init.cjs`, documented for Node).

## Consequences

- Ideno Core contains zero provider-specific code; adapters implement
  `AIProvider` and are injected by `src/server/container.ts`.
- Credentials never reach the browser. `/api/capabilities` reports only whether
  a credential is set, asserted by a test.
- The keyless Puter path needs a token for server-side use. Option C remains
  available: `AIProvider` is an interface, so a `browser_bridge` adapter that
  long-polls a tab can be added without touching core. **Not built in v0.1** —
  it cannot be verified in this environment, and a local OpenAI-compatible
  endpoint already satisfies the keyless requirement.
- The Puter SDK issues a background request during `init()`. In a network
  without egress to `api.puter.com` this surfaces as an **unhandled rejection
  roughly 90 seconds later**, which by default terminates a Node ≥ 15 process.
  Consequently the adapter is **opt-in** (constructed only when a token is
  present), **lazily initialised** on first use, and `src/server/main.ts`
  installs an `unhandledRejection` guard. This was observed empirically in the
  development sandbox, not inferred.

## Related decisions

- **SSE rejected for the (future) browser bridge** in favour of long-polling:
  simpler, proxy-safe, easier to test.
- **TypeScript pinned to ~5.9.3**, not 7.0.x. 7.0 is the Go-native compiler
  port and its compatibility with typescript-eslint and the Vite React plugin
  is unverified. Revisit when a dependency demands it.
