/**
 * Composition root for the AI layer.
 *
 * This is the only place that knows which concrete providers exist and how
 * Settings map onto them. Ideno Core receives an `AIRuntime` and never sees a
 * provider constructor, so adding a provider means: write the adapter, add one
 * case here, add one entry to `ProviderIdSchema`.
 */
import type { Settings } from './settings.js';
import { activeAgent } from './settings.js';
import type { ResearchRegistry, ResearchSource } from '../research/evidence.js';
import { createWikipediaSource, WIKIPEDIA_SOURCE_ID } from '../research/sources/wikipedia.js';
import { createTavilySource, TAVILY_SOURCE_ID, type TavilyTransport } from '../research/sources/tavily.js';
import { createPuterWebSearchSource, PUTER_WEB_SEARCH_SOURCE_ID } from './research/puter_web_search.js';
import { OpenAICompatibleProvider, type FetchLike } from './providers/openai_compatible.js';
import { PuterProvider, type PuterLoader } from './providers/puter.js';
import { ScriptedProvider, type ScriptedProviderOptions } from './providers/scripted.js';
import { AIRuntime } from './runtime/runtime.js';
import type { AIProvider } from './provider_interface/provider.js';

export interface ProviderRegistryOptions {
  /** Injected only by tests and the labelled offline demo. */
  scripted?: ScriptedProviderOptions;
  /** Test seam for the Puter SDK loader. */
  puterLoader?: PuterLoader;
  /** Test seam for HTTP. */
  fetchImpl?: FetchLike;
  /**
   * The live custom-agent profile, and its key if one is held.
   *
   * Passed in rather than read from settings because a key may exist only in memory, and
   * memory is not something the settings object carries.
   */
  agentApiKey?: string | null;
}

/**
 * The endpoint configuration a call should use.
 *
 * Prefers the active custom-agent profile and falls back to the legacy single endpoint,
 * so a configuration saved before profiles existed keeps working without a migration
 * having run first.
 */
export function endpointFor(settings: Settings): { base_url: string; model: string; json_mode: boolean } {
  const agent = activeAgent(settings);
  if (agent && (agent.base_url || agent.model)) {
    return { base_url: agent.base_url, model: agent.model, json_mode: agent.json_mode };
  }
  return {
    base_url: settings.openai.base_url,
    model: settings.openai.model,
    json_mode: settings.openai.json_mode,
  };
}

export interface ProviderBundle {
  runtime: AIRuntime;
  providers: Record<string, AIProvider>;
  active: AIProvider;
}

/**
 * Builds one instance of every provider and an `AIRuntime` pointed at the one
 * the settings select. Providers are cheap objects; nothing network-bound
 * happens until a call is made.
 */
export function createAIRuntime(settings: Settings, options: ProviderRegistryOptions = {}): ProviderBundle {
  const puter = new PuterProvider({
    model: settings.puter_model,
    loader: options.puterLoader,
  });

  const endpoint = endpointFor(settings);
  const openai = new OpenAICompatibleProvider({
    base_url: endpoint.base_url,
    model: endpoint.model,
    json_mode: endpoint.json_mode,
    // Optional by design: a local model server needs no key, and sending an empty
    // Authorization header would make some of them refuse a request they would
    // otherwise serve.
    ...(options.agentApiKey ? { api_key: options.agentApiKey } : {}),
    fetch_impl: options.fetchImpl,
  });

  const scripted = new ScriptedProvider(options.scripted ?? {});

  const providers: Record<string, AIProvider> = {
    [puter.id]: puter,
    [openai.id]: openai,
    [scripted.id]: scripted,
  };

  const active = providers[settings.provider_id] ?? puter;
  const runtime = new AIRuntime(active, {
    temperature: settings.temperature,
    timeout_ms: settings.timeout_ms,
    model: modelFor(settings),
  });

  return { runtime, providers, active };
}

/** Applies settings changes to an existing bundle without rebuilding providers. */
export function applySettings(bundle: ProviderBundle, settings: Settings, apiKey?: string | null): void {
  const endpoint = endpointFor(settings);
  const openai = bundle.providers.openai_compatible;
  if (openai instanceof OpenAICompatibleProvider) {
    openai.update({
      base_url: endpoint.base_url,
      model: endpoint.model,
      json_mode: endpoint.json_mode,
      ...(apiKey !== undefined ? { api_key: apiKey ?? undefined } : {}),
    });
  }

  const puter = bundle.providers.puter;
  if (puter instanceof PuterProvider) puter.setModel(settings.puter_model);

  const next = bundle.providers[settings.provider_id];
  if (next) bundle.runtime.setProvider(next);

  bundle.runtime.updateOptions({
    temperature: settings.temperature,
    timeout_ms: settings.timeout_ms,
    model: modelFor(settings),
  });
}

export interface ResearchSourceOptions {
  /** Test seam for HTTP, shared with the OpenAI-compatible provider. */
  fetchImpl?: FetchLike;
  /**
   * Tavily key, held in memory unless the user opted into persisting it.
   * Without one the Tavily source is not registered at all.
   */
  tavilyApiKey?: string | null;
  /**
   * Route Tavily calls through the desktop host instead of the browser.
   *
   * Injected by the composition root, which is the only layer allowed to know a desktop
   * host exists. Left unset, Tavily is called directly and a browser that blocks the
   * cross-origin request reports that specifically.
   */
  tavilyTransport?: TavilyTransport;
}

/**
 * The research sources these settings ask for.
 *
 * Lives here, beside `createAIRuntime`, for the same reason: this is the one module
 * allowed to know which concrete implementations exist. The composition root calls it
 * and never names a provider, which is what keeps the architecture rule honest rather
 * than satisfied by an exemption.
 */
export function createResearchSources(settings: Settings, options: ResearchSourceOptions = {}): ResearchSource[] {
  const sources: ResearchSource[] = [];
  if (settings.research.wikipedia) {
    sources.push(createWikipediaSource(options.fetchImpl ? { fetch_impl: options.fetchImpl as typeof fetch } : {}));
  }
  if (settings.research.puter_web_search) {
    sources.push(
      createPuterWebSearchSource({ model: settings.puter_model, timeout_ms: settings.timeout_ms }),
    );
  }
  if (settings.research.tavily) {
    // `createTavilySource` returns null when there is no key, so switching the source on
    // without one degrades to "not registered" rather than to a source that fails on
    // every question.
    const tavily = createTavilySource({
      api_key: options.tavilyApiKey ?? undefined,
      transport: options.tavilyTransport,
      timeout_ms: settings.timeout_ms,
      ...(options.fetchImpl ? { fetch_impl: options.fetchImpl as typeof fetch } : {}),
    });
    if (tavily) sources.push(tavily);
  }
  return sources;
}

/**
 * Makes a registry's contents match the settings.
 *
 * Called at startup and whenever settings are saved, so switching a source off stops
 * it being consulted on the next turn rather than the next session. Sources are
 * re-created rather than mutated: a Wikipedia source is bound to a language edition and
 * a web-search source to a model, and both are configuration rather than state.
 *
 * Anything registered by a *plugin* is left alone. This function only manages the
 * built-in sources it knows about, so a third-party research plugin survives a settings
 * change — which is the difference between an extension point and a suggestion.
 */
export function syncResearchSources(
  registry: ResearchRegistry,
  settings: Settings,
  options: ResearchSourceOptions = {},
): ResearchSource[] {
  const wanted = createResearchSources(settings, options);
  const wantedIds = new Set(wanted.map((source) => source.id));

  for (const id of [WIKIPEDIA_SOURCE_ID, PUTER_WEB_SEARCH_SOURCE_ID, TAVILY_SOURCE_ID]) {
    if (!wantedIds.has(id)) registry.unregister(id);
  }
  for (const source of wanted) {
    // Re-created on every sync: the model a web search runs against is part of what
    // that source is, so an existing instance cannot simply be kept.
    registry.unregister(source.id);
    registry.register(source);
  }
  return wanted;
}

function modelFor(settings: Settings): string | null {
  return settings.provider_id === 'openai_compatible'
    ? endpointFor(settings).model || null
    : settings.puter_model;
}
