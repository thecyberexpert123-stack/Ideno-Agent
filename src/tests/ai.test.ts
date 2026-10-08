import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { extractFirstJsonValue, parseModelJson, stripCodeFence } from '../ai/json.js';
import { OpenAICompatibleProvider } from '../ai/providers/openai_compatible.js';
import { AIRuntime, toJsonSchema } from '../ai/runtime.js';
import type { CompletionRequest } from '../ai/types.js';
import { IdenoError } from '../core/errors.js';
import { ScriptedProvider, json } from './support/scripted_provider.js';

/**
 * The AI layer.
 *
 * Everything here is about not trusting the model: recovering usable JSON
 * when the wrapper is wrong, failing cleanly when the content is wrong, and
 * never letting a provider-specific quirk reach Ideno Core.
 */

const Shape = z.object({
  title: z.string().min(1),
  count: z.number().int(),
});

function runtimeWith(provider: ScriptedProvider, overrides: Record<string, unknown> = {}): AIRuntime {
  return new AIRuntime({ providers: [provider], timeoutMs: 1000, maxAttempts: 1, ...overrides });
}

function structuredRequest() {
  return {
    system: 'You extract structure.',
    user: 'Extract it.',
    schema: Shape,
    schemaName: 'shape',
    purpose: 'test',
  } as const;
}

describe('stripCodeFence', () => {
  it('removes a json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('removes a bare fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text untouched', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe('extractFirstJsonValue', () => {
  it('finds an object buried in prose', () => {
    expect(extractFirstJsonValue('Sure! Here it is: {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it('does not stop at a brace inside a string literal', () => {
    const text = 'Result: {"note":"a } brace","ok":true}';
    expect(extractFirstJsonValue(text)).toBe('{"note":"a } brace","ok":true}');
  });

  it('handles escaped quotes', () => {
    const text = '{"note":"he said \\"hi\\"","ok":true}';
    expect(extractFirstJsonValue(text)).toBe(text);
  });

  it('returns null when nothing is balanced', () => {
    expect(extractFirstJsonValue('{"a": 1')).toBeNull();
    expect(extractFirstJsonValue('no json here')).toBeNull();
  });
});

describe('parseModelJson', () => {
  it('parses clean JSON without marking it recovered', () => {
    const outcome = parseModelJson('{"a":1}');
    expect(outcome).toMatchObject({ ok: true, recovered: false });
  });

  it('recovers fenced JSON', () => {
    const outcome = parseModelJson('```json\n{"a":1}\n```');
    expect(outcome).toMatchObject({ ok: true, recovered: true });
  });

  it('recovers JSON wrapped in prose', () => {
    const outcome = parseModelJson('Here you go:\n{"a":1}\nLet me know.');
    expect(outcome).toMatchObject({ ok: true, recovered: true });
  });

  it('reports an empty response distinctly', () => {
    const outcome = parseModelJson('   ');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain('empty');
  });

  it('refuses to guess at malformed JSON', () => {
    // A trailing comma is a common model slip. Repairing it silently would
    // mean inventing content, so this must fail rather than succeed.
    expect(parseModelJson('{"a":1,}').ok).toBe(false);
    expect(parseModelJson("{'a':1}").ok).toBe(false);
  });
});

describe('toJsonSchema', () => {
  it('produces a JSON Schema object a provider can send verbatim', () => {
    const schema = toJsonSchema(Shape, 'shape') as Record<string, unknown>;
    expect(schema).toHaveProperty('type', 'object');
    expect(schema).toHaveProperty('properties.title');
    expect(schema).toHaveProperty('properties.count');
  });
});

describe('AIRuntime', () => {
  it('returns validated, typed output', async () => {
    const provider = new ScriptedProvider({ replies: { test: [json({ title: 'ok', count: 2 })] } });
    const result = await runtimeWith(provider).completeStructured(structuredRequest());

    expect(result.value).toEqual({ title: 'ok', count: 2 });
    expect(result.repairs).toBe(0);
  });

  it('re-asks once with the validation errors and accepts the correction', async () => {
    const provider = new ScriptedProvider({
      replies: { test: [json({ title: 'ok' }), json({ title: 'ok', count: 3 })] },
    });

    const result = await runtimeWith(provider).completeStructured(structuredRequest());

    expect(result.value).toEqual({ title: 'ok', count: 3 });
    expect(result.repairs).toBe(1);

    // The repair prompt must name the actual problem, not just ask again.
    const second = provider.calls[1] as CompletionRequest;
    const repairPrompt = second.messages.at(-1)?.content ?? '';
    expect(repairPrompt).toContain('count');
  });

  it('gives up with malformed_model_output rather than corrupting state', async () => {
    const provider = new ScriptedProvider({
      replies: { test: ['not json', 'still not json', 'nope'] },
    });

    await expect(runtimeWith(provider).completeStructured(structuredRequest())).rejects.toMatchObject({
      code: 'malformed_model_output',
    });
  });

  it('treats an empty response as a typed failure', async () => {
    const provider = new ScriptedProvider({ replies: { test: ['', '', ''] } });
    await expect(
      runtimeWith(provider).completeStructured(structuredRequest()),
    ).rejects.toBeInstanceOf(IdenoError);
  });

  it('reports no configured provider instead of throwing something generic', async () => {
    const runtime = new AIRuntime({ providers: [] });
    expect(runtime.isReady).toBe(false);
    await expect(runtime.completeStructured(structuredRequest())).rejects.toMatchObject({
      code: 'provider_not_configured',
    });
  });

  it('skips an unconfigured provider in favour of a configured one', async () => {
    const unconfigured = new ScriptedProvider({ id: 'off', configured: false, replies: {} });
    const working = new ScriptedProvider({
      id: 'on',
      replies: { test: [json({ title: 'ok', count: 1 })] },
    });

    const runtime = new AIRuntime({ providers: [unconfigured, working], maxAttempts: 1 });
    expect(runtime.activeProviderId()).toBe('on');

    const result = await runtime.completeStructured(structuredRequest());
    expect(result.providerId).toBe('on');
  });

  it('rejects an explicitly requested provider that is not configured', async () => {
    const unconfigured = new ScriptedProvider({ id: 'off', configured: false, replies: {} });
    const working = new ScriptedProvider({ id: 'on', replies: {} });
    const runtime = new AIRuntime({ providers: [unconfigured, working] });

    await expect(
      runtime.completeStructured({ ...structuredRequest(), providerId: 'off' }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' });
  });

  it('retries a transient provider failure and then succeeds', async () => {
    const provider = new ScriptedProvider({
      replies: {
        test: [
          new IdenoError('provider_unavailable', 'connection reset', { retryable: true }),
          json({ title: 'ok', count: 9 }),
        ],
      },
    });

    const result = await runtimeWith(provider, { maxAttempts: 2 }).completeStructured(
      structuredRequest(),
    );
    expect(result.value.count).toBe(9);
    expect(provider.calls).toHaveLength(2);
  });

  it('does not retry a non-retryable failure', async () => {
    const provider = new ScriptedProvider({
      replies: {
        test: [new IdenoError('provider_auth_failed', 'bad key', { retryable: false })],
      },
    });

    await expect(
      runtimeWith(provider, { maxAttempts: 3 }).completeStructured(structuredRequest()),
    ).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(provider.calls).toHaveLength(1);
  });

  it('describes every provider for the capabilities endpoint', () => {
    const runtime = new AIRuntime({
      providers: [
        new ScriptedProvider({ id: 'off', configured: false, replies: {} }),
        new ScriptedProvider({ id: 'on', replies: {} }),
      ],
    });

    const described = runtime.listProviders();
    expect(described.map((provider) => provider.id)).toEqual(['off', 'on']);
    expect(described.every((provider) => provider.detail.length > 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatCompletion(content: string) {
  return {
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  };
}

describe('OpenAICompatibleProvider', () => {
  const baseRequest: CompletionRequest = {
    messages: [{ role: 'user', content: 'hello' }],
    purpose: 'test',
  };

  it('is not configured without a base URL and model', () => {
    expect(new OpenAICompatibleProvider({ baseUrl: '', model: '' }).isConfigured()).toBe(false);
    expect(
      new OpenAICompatibleProvider({ baseUrl: 'https://x/v1', model: 'm' }).isConfigured(),
    ).toBe(true);
  });

  it('posts a chat completion and returns the message content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatCompletion('hi there')));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1/',
      model: 'test-model',
      apiKey: 'secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete(baseRequest);
    expect(result.text).toBe('hi there');
    expect(result.model).toBe('test-model');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash on the base URL must not produce a double slash.
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(JSON.parse(init.body as string).model).toBe('test-model');
  });

  it('omits a token limit unless one is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(chatCompletion('{}')));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.complete(baseRequest);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('retries without response_format when the server rejects it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "Unsupported parameter: 'response_format'" } }, 400),
      )
      .mockResolvedValueOnce(jsonResponse(chatCompletion('{"ok":true}')));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      responseFormat: 'json_object',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await provider.complete({ ...baseRequest, jsonSchema: { name: 's', schema: {} } });
    expect(result.text).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(
      (fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(retryBody).not.toHaveProperty('response_format');

    // The capability is remembered, so the next call does not probe again.
    fetchImpl.mockResolvedValueOnce(jsonResponse(chatCompletion('{"ok":true}')));
    await provider.complete({ ...baseRequest, jsonSchema: { name: 's', schema: {} } });
    const thirdBody = JSON.parse(
      (fetchImpl.mock.calls[2] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(thirdBody).not.toHaveProperty('response_format');
  });

  it.each([
    [401, 'provider_auth_failed'],
    [403, 'provider_auth_failed'],
    [404, 'model_unavailable'],
    [429, 'provider_rate_limited'],
    [500, 'provider_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, status));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({ code });
  });

  it('reports a missing message body as empty_model_output', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: 'm', choices: [{ message: {}, finish_reason: 'content_filter' }] }),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      code: 'empty_model_output',
    });
  });

  it('reports a non-JSON body as malformed_model_output', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      code: 'malformed_model_output',
    });
  });

  it('never leaks the API key into an error message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      apiKey: 'super-secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await provider.complete(baseRequest).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdenoError);
    expect(JSON.stringify(error)).not.toContain('super-secret-token');
    expect((error as IdenoError).message).not.toContain('super-secret-token');
  });

  it('propagates an abort to fetch rather than hanging', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://example.test/v1',
      model: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const promise = provider.complete({ ...baseRequest, signal: controller.signal });
    controller.abort();

    // The adapter rethrows the raw abort: a cancellation is not a provider
    // fault, and classifying it is the runtime's job (see below).
    await expect(promise).rejects.toThrow();
  });
});

/**
 * Cross-layer: these behaviours are deliberately implemented once in the
 * runtime rather than in every adapter, so they are asserted there.
 */
describe('AIRuntime failure normalisation', () => {
  function hangingProvider(): ScriptedProvider {
    const provider = new ScriptedProvider({ replies: {} });
    provider.complete = async (request) => {
      provider.calls.push(request);
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    };
    return provider;
  }

  it('turns a blank completion from any provider into empty_model_output', async () => {
    const provider = new ScriptedProvider({ replies: { test: ['   \n  '] } });
    await expect(
      runtimeWith(provider).complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'test' }),
    ).rejects.toMatchObject({ code: 'empty_model_output' });
  });

  it('turns its own timeout into provider_timeout', async () => {
    const runtime = runtimeWith(hangingProvider(), { timeoutMs: 20, maxAttempts: 1 });
    await expect(
      runtime.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'test' }),
    ).rejects.toMatchObject({ code: 'provider_timeout' });
  });

  it('distinguishes caller cancellation from a timeout', async () => {
    const controller = new AbortController();
    const runtime = runtimeWith(hangingProvider(), { timeoutMs: 5000, maxAttempts: 1 });

    const promise = runtime.complete({
      messages: [{ role: 'user', content: 'x' }],
      purpose: 'test',
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: 'bad_request' });
  });
});
