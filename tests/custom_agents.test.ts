/**
 * Custom agents: profiles, discovery and verification.
 *
 * Three properties are under test here, and each corresponds to a way this feature could
 * quietly mislead somebody:
 *
 *  1. **Discovery must not report a working endpoint as broken.** Many
 *     OpenAI-compatible servers do not implement `/models` at all. That is not a failure
 *     of the base URL or the key, and the message has to say so rather than implying the
 *     user typed something wrong.
 *  2. **An API key is genuinely optional.** A local server needs none, and Ideno must
 *     then send no `Authorization` header at all — an empty `Bearer ` is rejected by
 *     servers that would happily serve an unauthenticated local request.
 *  3. **A secret is stored only when its owner opted in**, and saving one agent must not
 *     erase another's key.
 */
import { describe, expect, it } from 'vitest';

import {
  completionsUrlFrom,
  discoverModels,
  extractProbeText,
  modelsUrl,
  probeAgent,
  statusReason,
  type DiscoveryFetch,
} from '../src/ai/discovery.js';
import {
  OpenAICompatibleProvider,
  validateBaseUrl,
  validateConfig,
  type FetchLike,
} from '../src/ai/providers/openai_compatible.js';

/**
 * Adapts the discovery double to the provider's seam.
 *
 * The provider's `FetchLike` declares `body: string` because every completion has one;
 * discovery's declares it optional because a GET must not. One cast, in one place, at
 * the boundary between them — rather than weakening either seam.
 */
function asProviderFetch(impl: DiscoveryFetch): FetchLike {
  return impl as unknown as FetchLike;
}
import {
  MAX_AGENT_PROFILES,
  SettingsSchema,
  activeAgent,
  describeLegacyAgent,
  migrateSettings,
  newAgentId,
} from '../src/ai/settings.js';
import { loadSettings, saveSettings } from '../src/ai/settings_store.js';
import { createAIRuntime, endpointFor } from '../src/ai/factory.js';
import { MemoryStore } from '../src/core/state_manager/store.js';

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal };
}

/**
 * A stand-in for `fetch` typed against the discovery seam.
 *
 * Typed properly rather than cast away: the seam's `body` is optional because discovery
 * issues GETs, and a real `fetch` throws if it is given one. A test double that did not
 * model that would let a GET-with-body slip through the suite.
 */
function fakeFetch(config: {
  body?: unknown;
  status?: number;
  notJson?: boolean;
  throwError?: Error;
}): { impl: DiscoveryFetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl: DiscoveryFetch = async (url, init) => {
    calls.push({ url, init });
    if (config.throwError) throw config.throwError;
    const status = config.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (config.notJson) throw new Error('unexpected token');
        return config.body;
      },
      async text() {
        return JSON.stringify(config.body ?? {});
      },
    };
  };
  return { impl, calls };
}

function agent(
  overrides: Partial<{
    id: string;
    name: string;
    base_url: string;
    model: string;
    json_mode: boolean;
    persist_api_key: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? 'agent_a',
    name: overrides.name ?? 'Test agent',
    base_url: overrides.base_url ?? 'https://api.example.com/v1',
    model: overrides.model ?? 'test-model',
    json_mode: overrides.json_mode ?? false,
    persist_api_key: overrides.persist_api_key ?? false,
  };
}

describe('validateBaseUrl — the key is optional, the URL is not', () => {
  it('accepts a base URL with no key at all', () => {
    expect(validateBaseUrl('http://127.0.0.1:8080/v1').ok).toBe(true);
    expect(validateBaseUrl('https://api.example.com/v1').ok).toBe(true);
  });

  it.each([
    ['', /Set the endpoint base URL/],
    ['   ', /Set the endpoint base URL/],
    ['not a url', /not a valid URL/],
    ['ftp://example.com/v1', /must use http or https/],
    ['http://10.0.0.5:8080/v1', /Plain http is only allowed for loopback/],
  ])('refuses %s', (url, pattern) => {
    const result = validateBaseUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(pattern);
  });

  it('lets a key reach a local server over http but never the open internet', () => {
    expect(validateBaseUrl('http://localhost:11434/v1').ok).toBe(true);
    expect(validateBaseUrl('http://[::1]:8080/v1').ok).toBe(true);
    expect(validateBaseUrl('http://models.internal.example/v1').ok).toBe(false);
  });

  it('still requires a model before a completion, but not before discovery', () => {
    // The split is the point: listing an endpoint's models is what somebody does before
    // they know which model to name, so requiring a model to discover models is circular.
    expect(validateBaseUrl('https://api.example.com/v1').ok).toBe(true);
    expect(validateConfig({ base_url: 'https://api.example.com/v1', model: '' }).ok).toBe(false);
    expect(validateConfig({ base_url: 'https://api.example.com/v1', model: 'm' }).ok).toBe(true);
  });
});

describe('discoverModels', () => {
  it('reads the OpenAI shape', async () => {
    const { impl, calls } = fakeFetch({
      body: {
        object: 'list',
        data: [
          { id: 'gpt-4o-mini', owned_by: 'openai', context_length: 128000 },
          { id: 'llama3.1:8b', owned_by: 'library' },
        ],
      },
    });
    const result = await discoverModels({
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-secret',
      fetch_impl: impl,
    });

    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(['gpt-4o-mini', 'llama3.1:8b']);
    expect(result.models[0]?.context_window).toBe(128000);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/models');
    expect(calls[0]?.init.method).toBe('GET');
    // A GET must carry no body: a real fetch throws if one is supplied.
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.headers.Authorization).toBe('Bearer sk-secret');
  });

  it('reads the shapes other servers use instead', async () => {
    const ollama = fakeFetch({ body: { models: [{ name: 'llama3.1' }, { name: 'qwen2.5' }] } });
    const fromOllama = await discoverModels({
      base_url: 'http://127.0.0.1:11434/v1',
      fetch_impl: ollama.impl,
    });
    expect(fromOllama.models.map((model) => model.id)).toEqual(['llama3.1', 'qwen2.5']);

    const bare = fakeFetch({ body: [{ id: 'a' }, { id: 'b' }] });
    const fromBare = await discoverModels({ base_url: 'https://x.test/v1', fetch_impl: bare.impl });
    expect(fromBare.models.map((model) => model.id)).toEqual(['a', 'b']);
  });

  it('sends no Authorization header at all when there is no key', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [{ id: 'local-model' }] } });
    const result = await discoverModels({ base_url: 'http://127.0.0.1:8080/v1', fetch_impl: impl });

    expect(result.ok).toBe(true);
    // An empty "Bearer " would be rejected by servers that serve unauthenticated local
    // requests, so the header is omitted rather than sent blank.
    expect(calls[0]?.init.headers.Authorization).toBeUndefined();
  });

  it('normalises the base URL whichever way it was written', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [{ id: 'm' }] } });
    for (const base of [
      'https://api.example.com/v1',
      'https://api.example.com/v1/',
      'https://api.example.com/v1/chat/completions',
    ]) {
      await discoverModels({ base_url: base, fetch_impl: impl });
    }
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.example.com/v1/models',
      'https://api.example.com/v1/models',
      'https://api.example.com/v1/models',
    ]);
  });

  it('says an endpoint without /models is not broken, because that is common', async () => {
    const { impl } = fakeFetch({ status: 404, body: { error: 'not found' } });
    const result = await discoverModels({ base_url: 'https://api.example.com/v1', fetch_impl: impl });

    expect(result.ok).toBe(false);
    // The message must not imply the user got the URL or key wrong.
    expect(result.reason).toMatch(/does not implement a model list/);
    expect(result.status).toBe(404);
    expect(result.reason).toMatch(/not a failure of the base URL or key/);
    expect(result.reason).toMatch(/type the model id by hand/);
  });

  it('reports a rejected key as a credential problem', async () => {
    const { impl } = fakeFetch({ status: 401, body: { error: { message: 'Incorrect API key' } } });
    const result = await discoverModels({
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-wrong',
      fetch_impl: impl,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rejected the credentials/);
    expect(result.reason).toContain('Incorrect API key');
    // The key itself must never appear in anything a user can read or copy.
    expect(result.reason).not.toContain('sk-wrong');
  });

  it('reports an unreachable endpoint without blaming the configuration', async () => {
    const { impl } = fakeFetch({ throwError: new TypeError('Failed to fetch') });
    const result = await discoverModels({ base_url: 'https://api.example.com/v1', fetch_impl: impl });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be reached/);
    expect(result.reason).toMatch(/whether the server is running/);
  });

  it('reports invalid JSON as a bad reply, not as a missing endpoint', async () => {
    const { impl } = fakeFetch({ notJson: true });
    const result = await discoverModels({ base_url: 'https://api.example.com/v1', fetch_impl: impl });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/invalid JSON/);
  });

  it('drops rows with no id but keeps the rest', async () => {
    const { impl } = fakeFetch({ body: { data: [{ owned_by: 'x' }, { id: 'good' }, { id: '' }] } });
    const result = await discoverModels({ base_url: 'https://api.example.com/v1', fetch_impl: impl });
    expect(result.models.map((model) => model.id)).toEqual(['good']);
  });

  it('de-duplicates and reports an empty catalogue distinctly', async () => {
    const dupes = fakeFetch({ body: { data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] } });
    const first = await discoverModels({ base_url: 'https://x.test/v1', fetch_impl: dupes.impl });
    expect(first.models.map((model) => model.id)).toEqual(['a', 'b']);

    const empty = fakeFetch({ body: { data: [] } });
    const second = await discoverModels({ base_url: 'https://x.test/v1', fetch_impl: empty.impl });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/empty model list/);
    expect(second.reason).toMatch(/base URL is reachable/);
  });

  it('refuses to run against a URL that is not allowed', async () => {
    const { impl, calls } = fakeFetch({ body: { data: [] } });
    const result = await discoverModels({ base_url: 'http://10.0.0.5/v1', fetch_impl: impl });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/loopback/);
    expect(calls).toHaveLength(0);
  });
});

describe('probeAgent', () => {
  it('sends one minimal completion and reports what came back', async () => {
    const { impl, calls } = fakeFetch({
      body: { choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }] },
    });
    const result = await probeAgent({
      base_url: 'https://api.example.com/v1',
      model: 'test-model',
      api_key: 'sk-x',
      fetch_impl: impl,
    });

    expect(result.ok).toBe(true);
    expect(result.reply).toBe('ready');
    expect(result.model).toBe('test-model');
    expect(typeof result.latency_ms).toBe('number');

    const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    // Small on purpose: this spends a real request, so it must not spend much of one.
    expect(body.max_tokens).toBe(8);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('refuses to probe with no model selected, saying why', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    const result = await probeAgent({ base_url: 'https://api.example.com/v1', model: '', fetch_impl: impl });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Choose a model/);
    expect(calls).toHaveLength(0);
  });

  it('reports a 200 with no text as a failure, because that reads as success otherwise', async () => {
    const { impl } = fakeFetch({ body: { choices: [{ message: { content: '' } }] } });
    const result = await probeAgent({
      base_url: 'https://api.example.com/v1',
      model: 'm',
      fetch_impl: impl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no text for model "m"/);
  });

  it('reports a rate limit as a rate limit', async () => {
    const { impl } = fakeFetch({ status: 429, body: {} });
    const result = await probeAgent({ base_url: 'https://api.example.com/v1', model: 'm', fetch_impl: impl });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/rate-limited/);
  });
});

describe('url and payload helpers', () => {
  it('builds the two endpoint paths from any accepted base URL', () => {
    expect(modelsUrl('https://x.test/v1/')).toBe('https://x.test/v1/models');
    expect(completionsUrlFrom('https://x.test/v1')).toBe('https://x.test/v1/chat/completions');
    expect(completionsUrlFrom('https://x.test/v1/chat/completions')).toBe(
      'https://x.test/v1/chat/completions',
    );
  });

  it('reads completion text from the shapes servers actually return', () => {
    expect(extractProbeText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractProbeText({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })).toBe('ab');
    expect(extractProbeText({ choices: [{ text: 'bare' }] })).toBe('bare');
    expect(extractProbeText({ text: 'top level' })).toBe('top level');
    expect(extractProbeText({ choices: [] })).toBe('');
    expect(extractProbeText(null)).toBe('');
    expect(extractProbeText('a string')).toBe('');
  });

  it('never puts a key into a status message', () => {
    const message = statusReason(401, 'https://api.example.com/v1/models', 'bad key');
    expect(message).toMatch(/rejected the credentials/);
    expect(message).not.toContain('Bearer');
  });
});

describe('the provider lists real models once discovery works', () => {
  it('reports a model catalogue it actually enumerated', async () => {
    const { impl } = fakeFetch({ body: { data: [{ id: 'a' }, { id: 'b' }] } });
    const provider = new OpenAICompatibleProvider({
      base_url: 'https://api.example.com/v1',
      model: 'a',
      fetch_impl: asProviderFetch(impl),
    });

    expect(provider.capabilities().model_catalog).toBe(false);
    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(['a', 'b']);
    expect(provider.capabilities().model_catalog).toBe(true);
  });

  it('falls back to the configured model when the endpoint has no /models', async () => {
    const { impl } = fakeFetch({ status: 404, body: {} });
    const provider = new OpenAICompatibleProvider({
      base_url: 'https://api.example.com/v1',
      model: 'hand-typed',
      fetch_impl: asProviderFetch(impl),
    });

    const models = await provider.listModels();
    expect(models).toEqual([{ id: 'hand-typed', label: 'hand-typed' }]);
    // Honest about what it knows: this endpoint did not advertise a catalogue.
    expect(provider.capabilities().model_catalog).toBe(false);
  });

  it('describes itself without ever printing the key', () => {
    const provider = new OpenAICompatibleProvider({
      base_url: 'https://api.example.com/v1',
      model: 'm',
      api_key: 'sk-super-secret',
    });
    const description = provider.describe();
    expect(description).toContain('key set');
    expect(description).not.toContain('sk-super-secret');
  });
});

describe('agent profiles in settings', () => {
  it('defaults to no profiles, so nothing is configured that was not asked for', () => {
    const settings = SettingsSchema.parse({});
    expect(settings.agents).toEqual([]);
    expect(settings.active_agent_id).toBeNull();
    expect(activeAgent(settings)).toBeNull();
  });

  it('resolves the active profile and falls back when the pointer is stale', () => {
    const settings = SettingsSchema.parse({
      agents: [agent({ id: 'a' }), agent({ id: 'b', name: 'Second' })],
      active_agent_id: 'b',
    });
    expect(activeAgent(settings)?.id).toBe('b');

    // Deleting a profile is not a request to stop being able to use a custom endpoint.
    const stale = SettingsSchema.parse({ ...settings, active_agent_id: 'gone' });
    expect(activeAgent(stale)?.id).toBe('a');
  });

  it('mints distinct, bounded agent ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAgentId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^agent_[0-9a-f]{16}$/);
      expect(id.length).toBeLessThanOrEqual(40);
    }
  });

  it('caps how many profiles can be saved', () => {
    const tooMany = Array.from({ length: MAX_AGENT_PROFILES + 1 }, (_, index) =>
      agent({ id: `a${index}`, name: `Agent ${index}` }),
    );
    const parsed = SettingsSchema.safeParse({ agents: tooMany });
    expect(parsed.success).toBe(false);
  });

  it('names a migrated profile after its host, and copes with a URL that will not parse', () => {
    expect(describeLegacyAgent('https://api.example.com/v1')).toBe('api.example.com');
    expect(describeLegacyAgent('nonsense')).toBe('Custom agent');
    expect(describeLegacyAgent('')).toBe('Custom agent');
  });
});

describe('migrating the legacy single endpoint', () => {
  it('folds an existing configuration into one profile', () => {
    const legacy = SettingsSchema.parse({
      provider_id: 'openai_compatible',
      openai: {
        base_url: 'https://api.example.com/v1',
        model: 'gpt-4o-mini',
        json_mode: true,
        persist_api_key: true,
      },
    });
    const { settings, agentApiKeys } = migrateSettings(legacy, 'sk-legacy');

    expect(settings.agents).toHaveLength(1);
    const profile = settings.agents[0]!;
    expect(profile.name).toBe('api.example.com');
    expect(profile.base_url).toBe('https://api.example.com/v1');
    expect(profile.model).toBe('gpt-4o-mini');
    expect(profile.json_mode).toBe(true);
    expect(settings.active_agent_id).toBe(profile.id);
    expect(agentApiKeys[profile.id]).toBe('sk-legacy');
    // The legacy slot is cleared so the secret exists in exactly one place.
    expect(settings.openai.base_url).toBe('');
  });

  it('does not migrate a key the user never allowed to be stored', () => {
    const legacy = SettingsSchema.parse({
      openai: { base_url: 'https://api.example.com/v1', model: 'm', persist_api_key: false },
    });
    const { agentApiKeys } = migrateSettings(legacy, 'sk-memory-only');
    expect(agentApiKeys).toEqual({});
  });

  it('is idempotent, so loading twice cannot duplicate a profile', () => {
    const legacy = SettingsSchema.parse({
      openai: { base_url: 'https://api.example.com/v1', model: 'm' },
    });
    const once = migrateSettings(legacy, null);
    const twice = migrateSettings(once.settings, null);
    expect(twice.settings.agents).toHaveLength(1);
    expect(twice.settings.agents[0]?.id).toBe(once.settings.agents[0]?.id);
  });

  it('leaves an empty configuration alone rather than inventing a profile', () => {
    const fresh = SettingsSchema.parse({});
    const { settings, agentApiKeys } = migrateSettings(fresh, null);
    expect(settings.agents).toEqual([]);
    expect(agentApiKeys).toEqual({});
  });
});

describe('settings storage and secrets', () => {
  it('round-trips profiles and their keys', () => {
    const store = new MemoryStore();
    const settings = SettingsSchema.parse({
      provider_id: 'openai_compatible',
      agents: [agent({ id: 'a', persist_api_key: true }), agent({ id: 'b', name: 'Second' })],
      active_agent_id: 'b',
    });
    const saved = saveSettings(store, settings, { agentApiKeys: { a: 'sk-a', b: 'sk-b' } });
    expect(saved.saved).toBe(true);

    const loaded = loadSettings(store);
    expect(loaded.settings.agents.map((profile) => profile.id)).toEqual(['a', 'b']);
    expect(loaded.settings.active_agent_id).toBe('b');
    // 'a' opted into persistence; 'b' did not, so its key is not read back.
    expect(loaded.agentApiKeys).toEqual({ a: 'sk-a' });
    expect(loaded.apiKey).toBeNull();
  });

  it('refuses to store a key whose owner has not opted in', () => {
    const store = new MemoryStore();
    const settings = SettingsSchema.parse({
      agents: [agent({ id: 'a', persist_api_key: false })],
      active_agent_id: 'a',
    });
    saveSettings(store, settings, { agentApiKeys: { a: 'sk-secret' } });

    const raw = store.read('ideno.settings.v1')!;
    expect(raw).not.toContain('sk-secret');
    expect(loadSettings(store).agentApiKeys).toEqual({});
  });

  it('drops a stored key when persistence is switched off', () => {
    const store = new MemoryStore();
    const on = SettingsSchema.parse({ agents: [agent({ id: 'a', persist_api_key: true })] });
    saveSettings(store, on, { agentApiKeys: { a: 'sk-a' } });
    expect(loadSettings(store).agentApiKeys).toEqual({ a: 'sk-a' });

    const off = SettingsSchema.parse({ agents: [agent({ id: 'a', persist_api_key: false })] });
    saveSettings(store, off, { agentApiKeys: { a: 'sk-a' } });
    expect(store.read('ideno.settings.v1')).not.toContain('sk-a');
    expect(loadSettings(store).agentApiKeys).toEqual({});
  });

  it('saving one agent does not erase another key', () => {
    const store = new MemoryStore();
    const settings = SettingsSchema.parse({
      agents: [agent({ id: 'a', persist_api_key: true }), agent({ id: 'b', name: 'B', persist_api_key: true })],
    });
    saveSettings(store, settings, { agentApiKeys: { a: 'sk-a', b: 'sk-b' } });

    // A panel that only knows about the active agent still must not clobber the other.
    saveSettings(store, settings, { apiKey: 'sk-a-updated' });
    const loaded = loadSettings(store);
    expect(loaded.agentApiKeys.a).toBe('sk-a-updated');
    expect(loaded.agentApiKeys.b).toBe('sk-b');
  });

  it('migrates a stored v0.2 configuration on load', () => {
    const store = new MemoryStore();
    store.write(
      'ideno.settings.v1',
      JSON.stringify({
        provider_id: 'openai_compatible',
        openai: {
          base_url: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
          json_mode: false,
          persist_api_key: true,
        },
        openai_api_key: 'sk-legacy',
      }),
    );

    const loaded = loadSettings(store);
    expect(loaded.settings.agents).toHaveLength(1);
    expect(loaded.settings.agents[0]?.model).toBe('gpt-4o-mini');
    expect(loaded.apiKey).toBe('sk-legacy');
    expect(loaded.warning).toBeNull();
  });

  it('keeps the Tavily key out of storage until persistence is opted into', () => {
    const store = new MemoryStore();
    const settings = SettingsSchema.parse({
      research: { tavily: true },
      persist_tavily_api_key: false,
    });
    saveSettings(store, settings, { tavilyApiKey: 'tvly-secret' });
    expect(store.read('ideno.settings.v1')).not.toContain('tvly-secret');
    expect(loadSettings(store).tavilyApiKey).toBeNull();

    const persisted = SettingsSchema.parse({
      research: { tavily: true },
      persist_tavily_api_key: true,
    });
    saveSettings(store, persisted, { tavilyApiKey: 'tvly-secret' });
    expect(loadSettings(store).tavilyApiKey).toBe('tvly-secret');
  });

  it('survives unreadable stored settings with a warning rather than a crash', () => {
    const store = new MemoryStore();
    store.write('ideno.settings.v1', '{not json');
    const loaded = loadSettings(store);
    expect(loaded.warning).toMatch(/could not be read/);
    expect(loaded.settings.agents).toEqual([]);
  });
});

describe('the composition root uses the active profile', () => {
  it('prefers a profile over the legacy endpoint', () => {
    const settings = SettingsSchema.parse({
      agents: [agent({ id: 'a', base_url: 'https://a.test/v1', model: 'model-a' })],
      active_agent_id: 'a',
      openai: { base_url: 'https://legacy.test/v1', model: 'legacy-model' },
    });
    expect(endpointFor(settings)).toEqual({
      base_url: 'https://a.test/v1',
      model: 'model-a',
      json_mode: false,
    });
  });

  it('falls back to the legacy endpoint when there are no profiles', () => {
    const settings = SettingsSchema.parse({
      openai: { base_url: 'https://legacy.test/v1', model: 'legacy-model', json_mode: true },
    });
    expect(endpointFor(settings)).toEqual({
      base_url: 'https://legacy.test/v1',
      model: 'legacy-model',
      json_mode: true,
    });
  });

  it('hands the active key to the provider it builds', () => {
    const settings = SettingsSchema.parse({
      provider_id: 'openai_compatible',
      agents: [agent({ id: 'a', base_url: 'https://a.test/v1', model: 'm' })],
      active_agent_id: 'a',
    });
    const bundle = createAIRuntime(settings, { agentApiKey: 'sk-active' });
    const provider = bundle.providers.openai_compatible as OpenAICompatibleProvider;
    expect(provider.describe()).toContain('https://a.test/v1');
    expect(provider.describe()).toContain('key set');
    expect(provider.describe()).not.toContain('sk-active');
  });

  it('builds a provider with no key at all when the agent has none', () => {
    const settings = SettingsSchema.parse({
      provider_id: 'openai_compatible',
      agents: [agent({ id: 'a', base_url: 'http://127.0.0.1:8080/v1', model: 'local' })],
      active_agent_id: 'a',
    });
    const bundle = createAIRuntime(settings);
    const provider = bundle.providers.openai_compatible as OpenAICompatibleProvider;
    expect(provider.describe()).toContain('key not set');
    expect(bundle.runtime.capabilities().model_catalog).toBe(false);
  });
});
