import { AIRuntime } from '../ai/runtime.js';
import { OpenAICompatibleProvider } from '../ai/providers/openai_compatible.js';
import { PuterProvider } from '../ai/providers/puter.js';
import type { AIProvider } from '../ai/types.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createConsoleLogger, type Logger } from '../core/logger.js';
import { StateManager } from '../core/state_manager.js';
import { FileCaseStore } from '../core/store/file_store.js';
import { MemoryCaseStore } from '../core/store/memory_store.js';
import type { CaseStore } from '../core/store/store.js';
import { PluginRegistry } from '../plugins/registry.js';
import { ResearchService } from '../research/research_service.js';
import { UrlSourceFetcher } from '../research/url_source.js';
import type { IdenoConfig } from './config.js';

/**
 * Wiring.
 *
 * The one place that knows about concrete implementations. Everything it
 * builds is injected, which is what lets the test suite assemble the same
 * application with a scripted provider and an in-memory store.
 */
export interface Services {
  readonly config: IdenoConfig;
  readonly logger: Logger;
  readonly store: CaseStore;
  readonly stateManager: StateManager;
  readonly runtime: AIRuntime;
  readonly orchestrator: Orchestrator;
  readonly research: ResearchService | null;
  readonly plugins: PluginRegistry;
}

export interface BuildServicesOverrides {
  readonly logger?: Logger;
  readonly store?: CaseStore;
  /** Replaces the configured providers entirely. Used by tests. */
  readonly providers?: readonly AIProvider[];
  readonly fetchImpl?: typeof fetch;
}

export function buildProviders(config: IdenoConfig): AIProvider[] {
  const providers: AIProvider[] = [];

  if (config.openaiBaseUrl && config.openaiModel) {
    providers.push(
      new OpenAICompatibleProvider({
        baseUrl: config.openaiBaseUrl,
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        responseFormat: config.openaiResponseFormat,
        tokenLimitField: config.openaiTokenLimitField,
      }),
    );
  } else {
    // Registered but unconfigured, so the UI can explain what is missing
    // instead of the provider list simply being empty.
    providers.push(
      new OpenAICompatibleProvider({
        baseUrl: config.openaiBaseUrl ?? '',
        model: config.openaiModel ?? '',
        ...(config.openaiApiKey === undefined ? {} : { apiKey: config.openaiApiKey }),
      }),
    );
  }

  providers.push(
    new PuterProvider({
      ...(config.puterAuthToken === undefined ? {} : { authToken: config.puterAuthToken }),
      ...(config.puterModel === undefined ? {} : { model: config.puterModel }),
    }),
  );

  return providers;
}

export function buildServices(config: IdenoConfig, overrides: BuildServicesOverrides = {}): Services {
  const logger = overrides.logger ?? createConsoleLogger(config.logLevel);
  const store =
    overrides.store ??
    (config.storeKind === 'memory' ? new MemoryCaseStore() : new FileCaseStore(config.resolvedDataDir));

  const stateManager = new StateManager(store);
  const providers = overrides.providers ?? buildProviders(config);

  const runtime = new AIRuntime({
    providers,
    ...(config.defaultProviderId === undefined ? {} : { defaultProviderId: config.defaultProviderId }),
    timeoutMs: config.requestTimeoutMs,
    maxAttempts: config.maxAttempts,
  });

  const orchestrator = new Orchestrator({ runtime, stateManager, logger });
  const plugins = new PluginRegistry();

  let research: ResearchService | null = null;
  if (config.researchEnabled) {
    const fetcher = new UrlSourceFetcher({
      allowPrivateAddresses: config.researchAllowPrivateAddresses,
      ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    });
    research = new ResearchService({ runtime, stateManager, fetcher });
    plugins.register({
      id: 'research.url',
      kind: 'research',
      label: 'Web source research',
      description:
        'Fetches a URL, extracts claims that are actually quoted from the page, and records them as evidence.',
      available: true,
    });
  } else {
    plugins.register({
      id: 'research.url',
      kind: 'research',
      label: 'Web source research',
      description: 'Fetches a URL and records quoted claims as evidence.',
      available: false,
      detail: 'Disabled by configuration (IDENO_RESEARCH_ENABLED=0).',
    });
  }

  return { config, logger, store, stateManager, runtime, orchestrator, research, plugins };
}
