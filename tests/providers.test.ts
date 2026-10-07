import { describe, expect, it } from 'vitest';
import type { Puter } from '@heyputer/puter.js';

import { PuterProvider, extractText } from '../src/ai/providers/puter.js';
import {
  OpenAICompatibleProvider,
  completionsUrl,
  extractCompletionText,
  validateConfig,
  type FetchLike,
  type FetchResponseLike,
} from '../src/ai/providers/openai_compatible.js';
import { ScriptedProvider } from '../src/ai/providers/scripted.js';
import { AIRuntime, formatIssues, runWithTimeout } from '../src/ai/runtime/runtime.js';
import { AIError } from '../src/ai/errors.js';
import { TurnPlanSchema } from '../src/core/schemas/index.js';

// ---------------------------------------------------------------------------
// Puter adapter
// ---------------------------------------------------------------------------

interface FakeChatCall {
  messages: unknown;
  options: Record<string, unknown>;
}

interface FakePuter {
  puter: Puter;
  calls: FakeChatCall[];
  signInCalls: number;
}

function fakePuter(config: {
  signedIn?: boolean;
  response?: unknown;
  error?: unknown;
  models?: unknown[];
}): FakePuter {
  const calls: FakeChatCall[] = [];
  const state = { signedIn: config.signedIn ?? true, signInCalls: 0 };

  const sdk = {
    ai: {
      async chat(messages: unknown, options: Record<string, unknown>) {
        calls.push({ messages, options });
        if (config.error) throw config.error;
        return config.response;
      },
      async listModels() {
        if (config.error) throw config.error;
        return config.models ?? [];
      },
    },
    auth: {
      isSignedIn: () => state.signedIn,
      async signIn() {
        state.signInCalls += 1;
        if (config.error) throw config.error;
        state.signedIn = true;
        return { success: true };
      },
    },
  };

  return {
    puter: sdk as unknown as Puter,
    calls,
    get signInCalls() {
      return state.signInCalls;
    },
  };
}

describe('PuterProvider', () => {
  it('sends a normalised, non-streaming chat request with the configured model', async () => {
    const fake = fakePuter({ response: { message: { content: '{"ok":true}' }, finish_reason: 'stop' } });
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }), model: 'gpt-5-nano' });

    const result = await provider.complete({
      task: 'update',
      messages: [{ role: 'system', content: 'You are Ideno.' }, { role: 'user', content: 'A greenhouse.' }],
      temperature: 0.2,
    });

    expect(result.text).toBe('{"ok":true}');
    expect(result.provider_id).toBe('puter');
    expect(result.finish_reason).toBe('stop');
    expect(fake.calls[0]?.options).toMatchObject({ model: 'gpt-5-nano', normalize: true, temperature: 0.2 });
    expect(fake.calls[0]?.messages).toEqual([
      { role: 'system', content: 'You are Ideno.' },
      { role: 'user', content: 'A greenhouse.' },
    ]);
  });

  it('omits the model when none is configured so Puter uses its own default', async () => {
    const fake = fakePuter({ response: { message: { content: 'hi' } } });
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    await provider.complete({ task: 'update', messages: [{ role: 'user', content: 'hi' }] });
    expect(fake.calls[0]?.options).not.toHaveProperty('model');
  });

  it('declares no native JSON mode, because Puter documents none', () => {
    const provider = new PuterProvider({ loader: async () => ({ puter: fakePuter({}).puter }) });
    expect(provider.capabilities().json_mode).toBe(false);
    expect(provider.capabilities().model_catalog).toBe(true);
  });

  it('reports sign-in as the missing step rather than claiming to be broken', async () => {
    const fake = fakePuter({ signedIn: false });
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.action).toBe('sign_in');
    expect(availability.reason).toMatch(/sign in/i);

    const after = await provider.signIn?.();
    expect(after?.available).toBe(true);
    expect(fake.signInCalls).toBe(1);
  });

  it('reports a loader failure as an unavailable provider, without throwing', async () => {
    const provider = new PuterProvider({
      loader: async () => {
        throw new Error('network blocked');
      },
    });
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.action).toBe('configure');
    expect(availability.reason).toMatch(/network blocked/);
    await expect(provider.complete({ task: 'update', messages: [] })).rejects.toBeInstanceOf(AIError);
  });

  it('loads the SDK once and reuses it', async () => {
    let loads = 0;
    const fake = fakePuter({ response: { message: { content: 'x' } } });
    const provider = new PuterProvider({
      loader: async () => {
        loads += 1;
        return { puter: fake.puter };
      },
    });
    await provider.isAvailable();
    await provider.complete({ task: 'update', messages: [{ role: 'user', content: 'a' }] });
    await provider.complete({ task: 'update', messages: [{ role: 'user', content: 'b' }] });
    expect(loads).toBe(1);
  });

  it('maps the model catalogue and drops unusable entries', async () => {
    const fake = fakePuter({
      models: [
        { id: 'claude-sonnet-5', provider: 'claude', name: 'Claude Sonnet 5', context: 200000 },
        { id: 'claude-sonnet-5', provider: 'claude', name: 'duplicate' },
        { provider: 'broken' },
        { id: 'gpt-5-nano' },
      ],
    });
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-5', 'gpt-5-nano']);
    expect(models[0]).toMatchObject({ label: 'Claude Sonnet 5 (claude)', context_window: 200000 });
    expect(models[1]?.label).toBe('gpt-5-nano');
  });

  it('rejects an abort before the request resolves', async () => {
    const controller = new AbortController();
    const fake = fakePuter({
      response: new Promise((resolve) => setTimeout(() => resolve({ message: { content: 'late' } }), 500)),
    });
    const provider = new PuterProvider({ loader: async () => ({ puter: fake.puter }) });
    controller.abort();
    await expect(
      provider.complete({ task: 'update', messages: [], signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('Puter response text extraction', () => {
  it('reads a normalised string response', () => {
    expect(extractText({ message: { content: 'hello' } })).toBe('hello');
  });

  it('joins native content blocks', () => {
    expect(
      extractText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } as never),
    ).toBe('ab');
  });

  it('accepts a bare string response', () => {
    expect(extractText('plain')).toBe('plain');
  });

  it('returns empty rather than "[object Object]" for anything unexpected', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText({} as never)).toBe('');
    expect(extractText({ message: { content: [{ type: 'image' }] } } as never)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

interface FakeResponseSpec {
  ok?: boolean;
  status?: number;
  body?: unknown;
  rawText?: string;
  invalidJson?: boolean;
}

function fakeFetch(specs: FakeResponseSpec[]): {
  impl: FetchLike;
  calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[];
} {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  let index = 0;

  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const spec = specs[Math.min(index, specs.length - 1)] ?? {};
    index += 1;
    const status = spec.status ?? 200;
    const ok = spec.ok ?? (status >= 200 && status < 300);
    const text = spec.rawText ?? JSON.stringify(spec.body ?? {});
    return {
      ok,
      status,
      async text() {
        return text;
      },
      async json(): Promise<unknown> {
        if (spec.invalidJson) throw new SyntaxError('Unexpected token');
        return JSON.parse(text);
      },
    } satisfies FetchResponseLike;
  };

  return { impl, calls };
}

function completion(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
    ...extra,
  };
}

describe('OpenAICompatibleProvider', () => {
  const base = { base_url: 'https://api.example.com/v1', model: 'test-model', api_key: 'sk-secret' };

  it('posts to /chat/completions with a bearer token', async () => {
    const { impl, calls } = fakeFetch([{ body: completion('{"ok":1}') }]);
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    const result = await provider.complete({ task: 'update', messages: [{ role: 'user', content: 'hi' }] });

    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer sk-secret');
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ model: 'test-model', stream: false });
    expect(result.text).toBe('{"ok":1}');
    expect(result.model).toBe('test-model');
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(result.finish_reason).toBe('stop');
  });

  it('never leaks the key into logs, errors or describe()', () => {
    const provider = new OpenAICompatibleProvider(base);
    expect(provider.describe()).toContain('key set');
    expect(provider.describe()).not.toContain('sk-secret');
  });

  it('omits the Authorization header when no key is configured (local servers)', async () => {
    const { impl, calls } = fakeFetch([{ body: completion('ok') }]);
    const provider = new OpenAICompatibleProvider({
      base_url: 'http://127.0.0.1:8080/v1',
      model: 'local',
      fetch_impl: impl,
    });
    await provider.complete({ task: 'update', messages: [] });
    expect(calls[0]?.init.headers.Authorization).toBeUndefined();
  });

  it('requests JSON mode only when the endpoint declares it', async () => {
    const withoutMode = fakeFetch([{ body: completion('{}') }]);
    await new OpenAICompatibleProvider({ ...base, fetch_impl: withoutMode.impl }).complete({
      task: 'update',
      messages: [],
      json_mode: true,
    });
    expect(JSON.parse(withoutMode.calls[0]!.init.body)).not.toHaveProperty('response_format');

    const withMode = fakeFetch([{ body: completion('{}') }]);
    const provider = new OpenAICompatibleProvider({ ...base, json_mode: true, fetch_impl: withMode.impl });
    expect(provider.capabilities().json_mode).toBe(true);
    await provider.complete({ task: 'update', messages: [], json_mode: true });
    expect(JSON.parse(withMode.calls[0]!.init.body).response_format).toEqual({ type: 'json_object' });
  });

  it('reads content delivered as an array of parts', async () => {
    const { impl } = fakeFetch([{ body: completion([{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }]) }]);
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    const result = await provider.complete({ task: 'update', messages: [] });
    expect(result.text).toBe('part one part two');
  });

  it.each([
    [401, 'auth_required'],
    [403, 'auth_required'],
    [404, 'model_unavailable'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { impl } = fakeFetch([{ status, rawText: '{"error":{"message":"nope"}}' }]);
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    const runtime = new AIRuntime(provider);
    await expect(runtime.complete({ task: 'update', messages: [] })).rejects.toMatchObject({ code });
  });

  it('reports invalid JSON from the endpoint as a malformed response', async () => {
    const { impl } = fakeFetch([{ invalidJson: true, rawText: '<html>gateway error</html>' }]);
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    await expect(provider.complete({ task: 'update', messages: [] })).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('reports an empty completion instead of returning a blank turn', async () => {
    const { impl } = fakeFetch([{ body: completion('') }]);
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    await expect(provider.complete({ task: 'update', messages: [] })).rejects.toMatchObject({
      code: 'empty_response',
    });
  });

  it('maps a thrown network error to a network failure', async () => {
    const impl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const provider = new OpenAICompatibleProvider({ ...base, fetch_impl: impl });
    await expect(provider.complete({ task: 'update', messages: [] })).rejects.toMatchObject({ code: 'network' });
  });

  it('reports an incomplete configuration as unavailable, not as an exception', async () => {
    const provider = new OpenAICompatibleProvider({ base_url: '', model: '' });
    const availability = await provider.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.action).toBe('configure');
    expect(await provider.listModels()).toEqual([]);
  });
});

describe('OpenAI-compatible configuration validation', () => {
  it('normalises every base URL form to the completions endpoint', () => {
    expect(completionsUrl('https://x.test/v1')).toBe('https://x.test/v1/chat/completions');
    expect(completionsUrl('https://x.test/v1/')).toBe('https://x.test/v1/chat/completions');
    expect(completionsUrl('https://x.test/v1/chat/completions')).toBe('https://x.test/v1/chat/completions');
  });

  it('refuses to send a key over plain http to a non-loopback host', () => {
    const result = validateConfig({ base_url: 'http://api.example.com/v1', model: 'm' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/loopback/);
  });

  it('allows plain http for loopback hosts, where local model servers live', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(validateConfig({ base_url: `http://${host}:8080/v1`, model: 'm' }).ok).toBe(true);
    }
  });

  it('rejects a non-URL and a missing model', () => {
    expect(validateConfig({ base_url: 'not a url', model: 'm' }).ok).toBe(false);
    expect(validateConfig({ base_url: 'https://x.test/v1', model: '  ' }).ok).toBe(false);
  });
});

describe('completion text extraction', () => {
  it('falls back to a bare text field when a gateway omits message', () => {
    expect(extractCompletionText({ choices: [{ text: 'legacy shape' }] })).toBe('legacy shape');
    expect(extractCompletionText({})).toBe('');
    expect(extractCompletionText(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const validPlan = TurnPlanSchema.parse({
  operation: 'update',
  classification: 'new_information',
  reasoning_summary: 'Recorded the constraint.',
  user_message: 'Noted.',
  changes: {},
  question: null,
  followups: [],
});

describe('AIRuntime', () => {
  it('returns a validated value on the first attempt', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: JSON.stringify(validPlan) }] });
    const runtime = new AIRuntime(provider);
    const result = await runtime.structured({
      task: 'update',
      system: 'sys',
      turns: [{ role: 'user', content: 'task' }],
      schema: TurnPlanSchema,
    });
    expect(result.value.user_message).toBe('Noted.');
    expect(result.attempts).toBe(1);
    expect(result.repaired).toBe(false);
    expect(provider.requests[0]?.messages.map((turn) => turn.role)).toEqual(['system', 'user', 'user']);
  });

  it('sends the validation errors back and accepts a repaired response', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: '{"operation":"nonsense"}' }, { text: JSON.stringify(validPlan) }],
    });
    const runtime = new AIRuntime(provider);
    const result = await runtime.structured({
      task: 'update',
      system: 'sys',
      turns: [{ role: 'user', content: 'task' }],
      schema: TurnPlanSchema,
    });
    expect(result.attempts).toBe(2);
    expect(result.repaired).toBe(true);
    const repair = provider.requests[1]?.messages.at(-1)?.content ?? '';
    expect(repair).toMatch(/Fix it and reply again/);
    expect(repair).toMatch(/operation/);
  });

  it('throws malformed_response with the raw text when the repair also fails', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: 'prose' }, { text: 'more prose' }] });
    const runtime = new AIRuntime(provider);
    await expect(
      runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema }),
    ).rejects.toMatchObject({ code: 'malformed_response' });

    provider.reset();
    const provider2 = new ScriptedProvider({ responses: [{ text: 'prose' }, { text: 'more prose' }] });
    const runtime2 = new AIRuntime(provider2);
    try {
      await runtime2.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AIError).details.raw_text).toBe('more prose');
      expect((error as AIError).details.issues?.length).toBeGreaterThan(0);
    }
  });

  it('does not retry when only one attempt is configured', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: 'prose' }] });
    const runtime = new AIRuntime(provider, { max_attempts: 1 });
    await expect(
      runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
    expect(provider.callCount).toBe(1);
  });

  it('reports an empty response without a pointless repair attempt', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: '' }, { text: '' }] });
    const runtime = new AIRuntime(provider, { max_attempts: 1 });
    await expect(
      runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema }),
    ).rejects.toMatchObject({ code: 'empty_response' });
  });

  it('converts a timeout into a typed error', async () => {
    const provider = new ScriptedProvider({ responses: [{ text: '{}', delay_ms: 300 }] });
    const runtime = new AIRuntime(provider, { timeout_ms: 30 });
    await expect(
      runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('propagates an external cancellation as aborted', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider({ responses: [{ text: JSON.stringify(validPlan), delay_ms: 300 }] });
    const runtime = new AIRuntime(provider, { timeout_ms: 5000 });
    const pending = runtime.structured({
      task: 'update',
      system: 's',
      turns: [],
      schema: TurnPlanSchema,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('swaps providers without the caller changing anything else', async () => {
    const first = new ScriptedProvider({ responses: [{ text: 'not json' }] });
    const second = new ScriptedProvider({ responses: [{ text: JSON.stringify(validPlan) }] });
    const runtime = new AIRuntime(first, { max_attempts: 1 });
    await expect(
      runtime.structured({ task: 'update', system: 's', turns: [], schema: TurnPlanSchema }),
    ).rejects.toBeInstanceOf(AIError);

    runtime.setProvider(second);
    expect(runtime.provider_id).toBe('scripted');
    const result = await runtime.structured({
      task: 'update',
      system: 's',
      turns: [],
      schema: TurnPlanSchema,
    });
    expect(result.value.reasoning_summary).toBe('Recorded the constraint.');
  });

  it('reports a provider with no sign-in as needing configuration', async () => {
    const runtime = new AIRuntime(new ScriptedProvider());
    const result = await runtime.signIn();
    expect(result.available).toBe(false);
    expect(result.action).toBe('configure');
  });
});

describe('runWithTimeout', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(runWithTimeout(async () => 'done', 1000)).resolves.toBe('done');
  });

  it('rejects immediately when the caller already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runWithTimeout(async () => 'done', 1000, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('passes the original error through when it is not a timeout', async () => {
    await expect(
      runWithTimeout(async () => {
        throw new Error('provider exploded');
      }, 1000),
    ).rejects.toThrowError('provider exploded');
  });
});

describe('formatIssues', () => {
  it('renders a path and a message, and caps the list', () => {
    const result = TurnPlanSchema.safeParse({ operation: 'nope' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = formatIssues(result.error);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(8);
    expect(issues[0]).toMatch(/operation/);
  });
});
