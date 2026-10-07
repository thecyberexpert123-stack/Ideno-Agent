/**
 * Streaming (B3).
 *
 * The property this whole file exists to protect: **streaming changes what the user
 * sees while waiting, and nothing else.** A response that is still arriving is
 * decoration; the same extraction, schema validation and repair round-trip runs on
 * the assembled document before anything touches the Idea State.
 */
import { describe, expect, it } from 'vitest';
import type { Puter } from '@heyputer/puter.js';

import { AIRuntime } from '../src/ai/runtime/runtime.js';
import { parsePartialJson } from '../src/ai/runtime/json_extract.js';
import { ScriptedProvider, splitIntoPieces } from '../src/ai/providers/scripted.js';
import { PuterProvider } from '../src/ai/providers/puter.js';
import { AIError } from '../src/ai/errors.js';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { ResearchRegistry } from '../src/research/evidence.js';
import { SettingsSchema } from '../src/ai/settings.js';
import { TurnPlanSchema, type TurnPlanInput } from '../src/core/schemas/index.js';
import { describePartialPlan, partialReplyPreview } from '../src/reasoning/preview.js';
import { fixedClock } from '../src/core/ids.js';
import type { AIProvider, StreamChunk } from '../src/ai/provider_interface/provider.js';

// ---------------------------------------------------------------------------
// Partial JSON
// ---------------------------------------------------------------------------

describe('parsePartialJson', () => {
  it('reports a complete document as complete', () => {
    const result = parsePartialJson('{"a":1}');
    expect(result.complete).toBe(true);
    expect(result.value).toEqual({ a: 1 });
  });

  it('closes an object that has not finished arriving', () => {
    const result = parsePartialJson('{"operation":"update","changes":{"constraints_adde');
    expect(result.complete).toBe(false);
    expect(result.value).toMatchObject({ operation: 'update' });
  });

  it('closes an array mid-element', () => {
    const result = parsePartialJson('{"items":[{"id":"a"},{"id":"b"');
    expect(result.complete).toBe(false);
    const value = result.value as { items: unknown[] };
    expect(Array.isArray(value.items)).toBe(true);
    expect(value.items.length).toBeGreaterThanOrEqual(1);
  });

  it('closes an unterminated string rather than failing', () => {
    const result = parsePartialJson('{"user_message":"Recorded as a hard constr');
    expect(result.complete).toBe(false);
    expect(result.value).toMatchObject({ user_message: expect.any(String) });
  });

  it('discards a key whose value has not started', () => {
    const result = parsePartialJson('{"a":1,"b":');
    expect(result.complete).toBe(false);
    expect(result.value).toEqual({ a: 1 });
  });

  it('discards a trailing comma', () => {
    expect(parsePartialJson('{"a":1,').value).toEqual({ a: 1 });
  });

  it('looks inside a code fence that has not been closed', () => {
    const result = parsePartialJson('```json\n{"a":1,"b":2');
    expect(result.complete).toBe(false);
    expect(result.value).toMatchObject({ a: 1 });
  });

  it('gives up cleanly on text that has no document in it yet', () => {
    expect(parsePartialJson('')).toEqual({ value: null, complete: false });
    expect(parsePartialJson('   ')).toEqual({ value: null, complete: false });
    expect(parsePartialJson('Sure! Here is the JSON you asked for:').value).toBeNull();
  });

  it('never reports a prefix as complete', () => {
    // The one claim that would be dangerous: a caller trusting `complete: true` is
    // trusting that the document has finished arriving.
    // `[{"a":1}]` is *not* in this list: it is valid JSON, and calling it a prefix
    // would be the test asserting something false about the parser.
    for (const text of ['{"a":1', '{"a":', '{', '[{"a":1}', '[{"a":1},']) {
      expect(parsePartialJson(text).complete).toBe(false);
    }
    expect(parsePartialJson('[{"a":1}]').complete).toBe(true);
  });

  it('does not mistake brackets inside strings for structure', () => {
    const result = parsePartialJson('{"text":"a } b ] c","other":{"nested":[');
    expect(result.complete).toBe(false);
    expect(result.value).toMatchObject({ text: 'a } b ] c' });
  });
});

describe('describePartialPlan', () => {
  function plan(overrides: Partial<TurnPlanInput> = {}): TurnPlanInput {
    return TurnPlanSchema.parse({
      operation: 'update',
      classification: 'new_information',
      reasoning_summary: 'Test.',
      user_message: 'Recorded.',
      changes: {},
      question: null,
      followups: [],
      ...overrides,
    });
  }

  it('counts what has arrived and calls it a proposal', () => {
    const description = describePartialPlan(
      plan({
        changes: {
          constraints_added: [
            { text: 'Must fit on a balcony.', provenance: 'user_stated' },
            { text: 'No cloud connectivity.', provenance: 'user_stated' },
          ],
          unknowns_added: [{ text: 'What will it grow?', provenance: 'unknown' }],
        },
      }),
      false,
    );
    expect(description).toBe('Proposing 2 constraints, 1 unknown…');
  });

  it('switches to past tense only when the document is complete', () => {
    const value = plan({ changes: { requirements_added: [{ text: 'Runs offline.', provenance: 'user_stated' }] } });
    expect(describePartialPlan(value, false)).toMatch(/^Proposing 1 requirement…$/);
    // Even complete, it is still only a proposal: nothing has been reviewed or
    // applied at this point.
    expect(describePartialPlan(value, true)).toMatch(/^Proposed 1 requirement\.$/);
  });

  it('never says "added"', () => {
    const value = plan({
      changes: {
        constraints_added: [{ text: 'A.', provenance: 'user_stated' }],
        decisions_added: [{ text: 'B.', decided_by: 'user' }],
      },
    });
    const description = describePartialPlan(value, true) ?? '';
    expect(description).not.toMatch(/added|applied|recorded/i);
  });

  it('caps how many kinds it names', () => {
    const description = describePartialPlan(
      plan({
        changes: {
          requirements_added: [{ text: 'R.', provenance: 'user_stated' }],
          assumptions_added: [{ text: 'A.', provenance: 'model_inferred' }],
          constraints_added: [{ text: 'C.', provenance: 'user_stated' }],
          unknowns_added: [{ text: 'U.', provenance: 'unknown' }],
          research_items_added: [{ question: 'Q?' }],
        },
      }),
      false,
    );
    expect(description).toMatch(/\+2 more/);
  });

  it('mentions a question when one has arrived', () => {
    const description = describePartialPlan(
      plan({ question: { text: 'Where will it sit?', impact: 'high', why_it_matters: 'Placement.' } }),
      false,
    );
    expect(description).toContain('one question');
  });

  it('says nothing when nothing has arrived', () => {
    expect(describePartialPlan(null, false)).toBeNull();
    expect(describePartialPlan({}, false)).toBeNull();
    expect(describePartialPlan('text', false)).toBeNull();
    expect(describePartialPlan(plan({ changes: {} }), false)).toBe('Writing a reply…');
  });

  it('ignores a malformed changes value rather than counting it', () => {
    expect(describePartialPlan({ changes: { constraints_added: 'not an array' } }, false)).toBeNull();
    expect(describePartialPlan({ changes: { constraints_added: [] } }, false)).toBeNull();
  });

  it('previews the reply text as the model wrote it', () => {
    expect(partialReplyPreview({ user_message: 'Recorded as a hard constraint.' })).toBe(
      'Recorded as a hard constraint.',
    );
    expect(partialReplyPreview({ user_message: 'x'.repeat(400) })).toMatch(/…$/);
    expect(partialReplyPreview({ user_message: '   ' })).toBeNull();
    expect(partialReplyPreview(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scripted streaming
// ---------------------------------------------------------------------------

describe('splitIntoPieces', () => {
  it('reassembles exactly what it was given', () => {
    const text = 'The greenhouse must fit on a balcony — 2 m × 1 m.';
    for (const count of [1, 2, 3, 7, 100]) {
      expect(splitIntoPieces(text, count).join('')).toBe(text);
    }
  });

  it('does not cut a surrogate pair in half', () => {
    const pieces = splitIntoPieces('a🌱b🌱c', 5);
    expect(pieces.join('')).toBe('a🌱b🌱c');
    for (const piece of pieces) expect(piece).not.toContain('\uFFFD');
  });

  it('handles empty and single-piece cases', () => {
    expect(splitIntoPieces('', 4)).toEqual(['']);
    expect(splitIntoPieces('abc', 0)).toEqual(['abc']);
  });
});

describe('ScriptedProvider streaming', () => {
  it('is not a streaming provider unless configured as one', async () => {
    const plain = new ScriptedProvider({ responses: [{ text: '{"a":1}' }] });
    expect(plain.capabilities().streaming).toBe(false);
    expect(plain.completeStream).toBeTypeOf('function');
    await expect(plain.completeStream!({ task: 'update', messages: [] })).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
  });

  it('delivers the same text in pieces, then finishes', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: '{"operation":"update","user_message":"Recorded."}' }],
      streaming: { chunks: 4 },
    });
    expect(provider.capabilities().streaming).toBe(true);

    const stream = await provider.completeStream!({ task: 'update', messages: [] });
    const seen: StreamChunk[] = [];
    for await (const chunk of stream.chunks) seen.push(chunk);

    expect(seen.filter((chunk) => chunk.type === 'text').length).toBe(4);
    expect(
      seen
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => (chunk as { text: string }).text)
        .join(''),
    ).toBe('{"operation":"update","user_message":"Recorded."}');
    expect(seen[seen.length - 1]).toMatchObject({ type: 'finish', reason: 'stop' });
  });

  it('stops producing text once cancelled', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider({
      responses: [{ text: 'x'.repeat(200) }],
      streaming: { chunks: 20, chunk_delay_ms: 5 },
    });
    const stream = await provider.completeStream!({ task: 'update', messages: [], signal: controller.signal });

    let received = 0;
    await expect(async () => {
      for await (const chunk of stream.chunks) {
        if (chunk.type === 'text') received += 1;
        if (received === 2) controller.abort();
      }
    }).rejects.toMatchObject({ code: 'aborted' });
    expect(received).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// Puter streaming
// ---------------------------------------------------------------------------

interface FakeStreamPuter {
  puter: Puter;
  options: Record<string, unknown>[];
}

function fakeStreamingPuter(chunks: unknown[], config: { fail?: unknown } = {}): FakeStreamPuter {
  const options: Record<string, unknown>[] = [];
  const sdk = {
    ai: {
      async chat(_messages: unknown, chatOptions: Record<string, unknown>) {
        options.push(chatOptions);
        if (config.fail) throw config.fail;
        return (async function* iterate() {
          for (const chunk of chunks) yield chunk;
        })();
      },
      async listModels() {
        return [];
      },
    },
    auth: { isSignedIn: () => true, async signIn() { return { success: true }; } },
  };
  return { puter: sdk as unknown as Puter, options };
}

describe('PuterProvider streaming', () => {
  it('asks for a stream and normalises the chunks', async () => {
    const fake = fakeStreamingPuter([
      { type: 'text', text: '{"a"' },
      { type: 'reasoning', reasoning: 'thinking aloud' },
      { type: 'text', text: ':1}' },
      { type: 'compaction', id: 'c1', encrypted_content: 'opaque' },
      { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ]);
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }), model: 'gpt-5-nano' });

    const stream = await provider.completeStream({ task: 'update', messages: [], temperature: 0.2 });
    const seen: StreamChunk[] = [];
    for await (const chunk of stream.chunks) seen.push(chunk);

    // stream: true is what selects the SDK's streaming overload.
    expect(fake.options[0]).toMatchObject({ stream: true, model: 'gpt-5-nano', temperature: 0.2 });
    expect(stream.model).toBe('gpt-5-nano');
    expect(stream.provider_id).toBe('puter');

    // Text is concatenated; reasoning is reported but not stored; a chunk type
    // Ideno has no use for is dropped rather than forwarded, because a consumer that
    // had to know about `compaction` would not be provider-neutral.
    expect(seen.filter((chunk) => chunk.type === 'text').map((chunk) => (chunk as { text: string }).text).join('')).toBe(
      '{"a":1}',
    );
    expect(seen.filter((chunk) => chunk.type === 'reasoning')).toHaveLength(1);
    expect(seen.some((chunk) => 'compaction' in chunk)).toBe(false);
    expect(seen[seen.length - 1]).toMatchObject({
      type: 'finish',
      usage: { input_tokens: 12, output_tokens: 7 },
    });
  });

  it('turns an error chunk into a failure instead of a short document', async () => {
    // A stream that stops early and reports success would hand the runtime a
    // truncated document to validate, which is the worst way to fail.
    const fake = fakeStreamingPuter([
      { type: 'text', text: '{"a":1' },
      { type: 'error', message: 'the model was rate limited' },
    ]);
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const stream = await provider.completeStream({ task: 'update', messages: [] });

    await expect(async () => {
      for await (const _chunk of stream.chunks) {
        // consumed
      }
    }).rejects.toMatchObject({ message: expect.stringContaining('rate limited') });
  });

  it('reports an error chunk with no detail honestly', async () => {
    const fake = fakeStreamingPuter([{ type: 'error' }]);
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const stream = await provider.completeStream({ task: 'update', messages: [] });
    await expect(async () => {
      for await (const _chunk of stream.chunks) {
        // consumed
      }
    }).rejects.toMatchObject({ message: expect.stringContaining('no detail given') });
  });

  it('stops iterating when cancelled', async () => {
    const controller = new AbortController();
    const many = Array.from({ length: 50 }, () => ({ type: 'text', text: 'x' }));
    const fake = fakeStreamingPuter(many);
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const stream = await provider.completeStream({ task: 'update', messages: [], signal: controller.signal });

    let received = 0;
    for await (const chunk of stream.chunks) {
      if (chunk.type === 'text') received += 1;
      if (received === 3) controller.abort();
    }
    // The generator returns rather than throwing, because the caller already knows
    // it cancelled; what matters is that it stopped.
    expect(received).toBeLessThanOrEqual(4);
    expect(received).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

describe('AIRuntime streaming', () => {
  const valid = JSON.stringify({
    operation: 'update',
    classification: 'new_information',
    reasoning_summary: 'Streaming test.',
    user_message: 'Recorded.',
    changes: { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
    question: null,
    followups: [],
  });

  it('assembles the whole document and validates it exactly as before', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: valid }], streaming: { chunks: 6 } });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });

    const progress: string[] = [];
    const result = await runtime.structured({
      task: 'update',
      system: 'You are Ideno.',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: (text) => progress.push(text),
    });

    expect(result.value.user_message).toBe('Recorded.');
    expect(result.value.changes.constraints_added).toHaveLength(1);
    expect(result.raw_text).toBe(valid);
    expect(result.attempts).toBe(1);
    expect(progress.length).toBeGreaterThan(0);
    // The last progress report is a prefix of the whole; the value came from the
    // whole.
    expect(valid.startsWith(progress[progress.length - 1]!)).toBe(true);
  });

  it('reports progress while the document is still incomplete', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: valid }],
      streaming: { chunks: 12, chunk_delay_ms: 30 },
    });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });

    const snapshots: string[] = [];
    await runtime.structured({
      task: 'update',
      system: 'You are Ideno.',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: (text) => snapshots.push(text),
    });

    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.some((snapshot) => snapshot.length < valid.length)).toBe(true);
    // Monotonic: a preview must never appear to retract text.
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]!.length).toBeGreaterThanOrEqual(snapshots[index - 1]!.length);
    }
  });

  it('falls back to a non-streaming call when the provider cannot stream', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: valid }] });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    const progress: string[] = [];

    const result = await runtime.structured({
      task: 'update',
      system: 'You are Ideno.',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: (text) => progress.push(text),
    });
    expect(result.value.user_message).toBe('Recorded.');
    expect(progress).toHaveLength(0);
  });

  it('falls back when capabilities claim streaming but the method is missing', async () => {
    // A provider that advertises a capability it does not implement is a real
    // possibility, not a hypothetical: capabilities() and the method are written
    // separately. The runtime asks for the method, not for the advertisement.
    const inner = new ScriptedProvider({ responses: [{ text: valid }] });
    const lying: AIProvider = {
      id: inner.id,
      label: inner.label,
      capabilities: () => ({ ...inner.capabilities(), streaming: true }),
      isAvailable: () => inner.isAvailable(),
      listModels: () => inner.listModels(),
      complete: (request) => inner.complete(request),
      // no completeStream
    };
    const runtime = new AIRuntime(lying, { timeout_ms: 5000 });
    const progress: string[] = [];
    const result = await runtime.structured({
      task: 'update',
      system: 'You are Ideno.',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: (text) => progress.push(text),
    });
    expect(result.value.user_message).toBe('Recorded.');
    expect(progress).toHaveLength(0);
  });

  it('does not stream when nobody asked for progress', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: valid }], streaming: { chunks: 4 } });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    await runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema });
    // `complete` was used, which the scripted provider answers in one piece.
    expect(provider.callCount).toBe(1);
  });

  it('still repairs a malformed streamed response', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: '{"operation":"update"}' }, { text: valid }],
      streaming: { chunks: 3 },
    });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000, max_attempts: 2 });
    const result = await runtime.structured({
      task: 'update',
      system: 's',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: () => undefined,
    });
    expect(result.repaired).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('fails the same way when the streamed document is unusable', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: 'I cannot help with that.' }, { text: 'Still not JSON.' }],
      streaming: { chunks: 3 },
    });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    await expect(
      runtime.structured({
        task: 'update',
        system: 's',
        turns: [],
        schema: TurnPlanSchema,
        on_progress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('aborts a stream that overruns the timeout', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: valid }],
      streaming: { chunks: 40, chunk_delay_ms: 25 },
    });
    const runtime = new AIRuntime(provider, { timeout_ms: 120 });
    await expect(
      runtime.structured({
        task: 'update',
        system: 's',
        turns: [],
        schema: TurnPlanSchema,
        on_progress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('contains a progress listener that throws', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: valid }],
      streaming: { chunks: 6, chunk_delay_ms: 1 },
    });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    // Losing a response because a preview callback threw would be an absurd trade.
    const result = await runtime.structured({
      task: 'update',
      system: 's',
      turns: [],
      schema: TurnPlanSchema,
      on_progress: () => {
        throw new Error('listener blew up');
      },
    });
    expect(result.value.user_message).toBe('Recorded.');
  });

  it('reports an error mid-stream as a failure', async () => {
    const fake = fakeStreamingPuter([
      { type: 'text', text: '{"operation":"upd' },
      { type: 'error', message: 'upstream went away' },
    ]);
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    await expect(
      runtime.structured({
        task: 'update',
        system: 's',
        turns: [],
        schema: TurnPlanSchema,
        on_progress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AIError);
  });
});

// ---------------------------------------------------------------------------
// The orchestrator and the state
// ---------------------------------------------------------------------------

describe('streaming through the orchestrator', () => {
  const valid = JSON.stringify({
    operation: 'understand',
    classification: 'new_idea',
    reasoning_summary: 'First pass.',
    user_message: 'Here is what I understood.',
    changes: {
      requirements_added: [{ text: 'Runs without daily attention.', provenance: 'user_stated' }],
      unknowns_added: [{ text: 'Where will it sit?', provenance: 'unknown', impact: 'high' }],
    },
    question: null,
    followups: [],
  });

  function stack(options: { streaming?: boolean; responses?: string[] } = {}) {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const provider = new ScriptedProvider({
      responses: (options.responses ?? [valid]).map((text) => ({ text })),
      streaming: options.streaming === false ? undefined : { chunks: 10, chunk_delay_ms: 40 },
    });
    const previews: (string | null | undefined)[] = [];
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider, { timeout_ms: 5000 }),
      state,
      getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
      research: new ResearchRegistry(),
      onEvent: (event) => {
        if (event.type === 'preview') previews.push(event.preview);
      },
    });
    return { state, orchestrator, previews, provider };
  }

  it('emits previews while the response arrives, then the real turn', async () => {
    const { state, orchestrator, previews } = stack();
    const result = await orchestrator.processMessage('I want to build a small greenhouse.');

    expect(previews.length).toBeGreaterThan(0);
    expect(previews.some((preview) => typeof preview === 'string' && preview.includes('Proposing'))).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.entries.some((entry) => entry.text === 'Here is what I understood.')).toBe(true);
    // And the state holds exactly what the validated document said — no more, which
    // is the point: nothing arrived early from a partial parse.
    expect(state.idea?.requirements.map((item) => item.text)).toContain('Runs without daily attention.');
    // Streaming does not relax the review policy either: the requirement grounded in
    // the user's own words is applied, and the unknown the model raised waits for a
    // human decision exactly as it would without streaming.
    expect(state.idea?.unknowns).toHaveLength(0);
    expect(state.pendingChanges().map((record) => record.kind)).toContain('unknown_added');
  });

  it('never applies anything from a partial document', async () => {
    // A response that is valid JSON as a prefix but incomplete overall: the first
    // attempt fails validation and the repair succeeds. If a preview had been
    // applied, the state would show the first attempt's contents.
    const broken = JSON.stringify({
      operation: 'understand',
      classification: 'new_idea',
      reasoning_summary: 'Broken.',
      user_message: 'This one is wrong.',
      changes: {
        constraints_added: [{ text: 'SHOULD NEVER BE APPLIED.', provenance: 'user_stated' }],
      },
      question: null,
      followups: [],
    }).replace(/"followups":\[\]/, '"followups":[');

    const { state, orchestrator } = stack({ responses: [broken, valid] });
    const result = await orchestrator.processMessage('I want to build a small greenhouse.');

    expect(result.integrity_notes.join(' ')).toMatch(/corrected one was accepted/);
    expect(state.idea?.constraints).toHaveLength(0);
    expect(JSON.stringify(state.idea)).not.toContain('SHOULD NEVER BE APPLIED');
    expect(state.idea?.requirements.map((item) => item.text)).toContain('Runs without daily attention.');
  });

  it('ends the turn with turn_complete, not with a dangling preview', async () => {
    const events: string[] = [];
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(
        new ScriptedProvider({ responses: [{ text: valid }], streaming: { chunks: 6, chunk_delay_ms: 40 } }),
        { timeout_ms: 5000 },
      ),
      state,
      getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
      research: new ResearchRegistry(),
      onEvent: (event) => events.push(event.type),
    });
    await orchestrator.processMessage('A second idea.');

    expect(events).toContain('preview');
    expect(events[events.length - 1]).toBe('turn_complete');
    // The UI clears the preview on turn_complete and on failure, so a stale
    // "proposing…" can never outlive the turn it described.
    expect(events.indexOf('turn_complete')).toBeGreaterThan(events.lastIndexOf('preview'));
  });
});
