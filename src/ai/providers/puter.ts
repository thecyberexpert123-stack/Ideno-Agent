import { createRequire } from 'node:module';
import { IdenoError } from '../../core/errors.js';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  ProviderDescription,
} from '../types.js';

/**
 * Adapter for Puter's AI gateway (https://docs.puter.com/AI/chat/).
 *
 * Puter exposes one API over 500+ models and, in the browser, needs no API
 * key at all (the signed-in user pays). Server side it needs an auth token,
 * which `@heyputer/puter.js/src/init.cjs` accepts:
 *
 *   const { init } = require('@heyputer/puter.js/src/init.cjs');
 *   const puter = init(process.env.puterAuthToken);
 *   await puter.ai.chat(messages, false, { model, normalize: true });
 *
 * Verified locally: `init(token)` returns an object exposing `ai.chat`, and
 * the SDK issues a background request to `api.puter.com` during
 * initialisation. That background request rejects on a host without outbound
 * access to Puter, which is why initialisation is lazy and why the server
 * installs an `unhandledRejection` guard (see `src/server/main.ts`).
 *
 * NOT verified in this environment: an actual completion, because the build
 * host has no outbound access to api.puter.com. The request and response
 * mapping below follows the published API reference and is covered by tests
 * against an injected client that returns the documented response shapes.
 */

/** Minimal surface this adapter uses. Keeps the SDK injectable for tests. */
export interface PuterChatOptions {
  model?: string;
  normalize?: boolean;
  temperature?: number;
  max_tokens?: number;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown>; name?: string };
}

export interface PuterChatMessage {
  role: string;
  content: string;
}

export interface PuterChatClient {
  chat(
    messages: PuterChatMessage[],
    testMode: boolean,
    options: PuterChatOptions,
  ): Promise<unknown>;
}

/** Documented `ChatResponse` shape (normalised to the OpenAI format). */
interface PuterChatResponse {
  message?: {
    content?: string | { type?: string; text?: string }[] | null;
  };
  finish_reason?: string | null;
  usage?: Record<string, number> | undefined;
  usageDetails?: { inputTokens?: number; outputTokens?: number };
}

export interface PuterProviderOptions {
  readonly authToken?: string | undefined;
  readonly model?: string;
  /** Injected in tests; defaults to loading the real SDK lazily. */
  readonly clientFactory?: (authToken: string) => Promise<PuterChatClient>;
}

const DEFAULT_MODEL = 'gpt-5.4-nano';

export class PuterProvider implements AIProvider {
  readonly id = 'puter';
  readonly label = 'Puter AI gateway';
  readonly supportsJsonSchema = true;

  readonly #authToken: string | undefined;
  readonly #model: string;
  readonly #clientFactory: (authToken: string) => Promise<PuterChatClient>;
  #client: Promise<PuterChatClient> | null = null;

  constructor(options: PuterProviderOptions) {
    this.#authToken = options.authToken?.trim() || undefined;
    this.#model = options.model?.trim() || DEFAULT_MODEL;
    this.#clientFactory = options.clientFactory ?? loadPuterClient;
  }

  isConfigured(): boolean {
    return this.#authToken !== undefined;
  }

  describe(): ProviderDescription {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      model: this.#model,
      supportsJsonSchema: true,
      detail: this.isConfigured()
        ? `Calling Puter with model "${this.#model}".`
        : 'Set IDENO_PUTER_AUTH_TOKEN to enable Puter. Obtain a token with the Puter CLI (`puter login`) or `getAuthToken()` from @heyputer/puter.js.',
      docsUrl: 'https://docs.puter.com/AI/chat/',
    };
  }

  async #getClient(): Promise<PuterChatClient> {
    if (!this.#authToken) {
      throw new IdenoError('provider_not_configured', this.describe().detail);
    }
    this.#client ??= this.#clientFactory(this.#authToken).catch((error: unknown) => {
      // Reset so a later call can retry rather than caching a failed init.
      this.#client = null;
      throw error instanceof IdenoError
        ? error
        : new IdenoError('provider_unavailable', 'Could not initialise the Puter SDK.', {
            cause: error,
          });
    });
    return this.#client;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();
    const client = await this.#getClient();

    const options: PuterChatOptions = {
      model: this.#model,
      // Guarantees `message.content` is a plain string across every vendor
      // Puter routes to, instead of Anthropic-style content blocks.
      normalize: true,
    };
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) options.max_tokens = request.maxOutputTokens;
    if (request.jsonSchema) {
      options.outputFormat = {
        type: 'json_schema',
        schema: request.jsonSchema.schema,
        name: request.jsonSchema.name,
      };
    }

    const messages: PuterChatMessage[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    // The SDK does not accept an AbortSignal, so the caller is released on
    // abort while the underlying request finishes in the background. Without
    // this race an unreachable gateway would hang the whole turn.
    const raw = await withAbort(
      client.chat(messages, false, options),
      request.signal,
      () => new IdenoError('provider_timeout', 'Puter did not respond in time.'),
    ).catch((error: unknown) => {
      if (error instanceof IdenoError) throw error;
      throw new IdenoError('provider_unavailable', describePuterError(error), { cause: error });
    });

    const text = readContent(raw as PuterChatResponse);
    if (text === null) {
      throw new IdenoError('empty_model_output', 'Puter returned no message content.');
    }

    const response = raw as PuterChatResponse;
    const usage = response.usageDetails;
    return {
      text,
      providerId: this.id,
      model: this.#model,
      finishReason: response.finish_reason ?? null,
      usage: usage
        ? {
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          }
        : null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Reads the text out of a `ChatResponse`, accepting both the normalised
 * string form and the vendor-native array of content blocks.
 */
function readContent(response: PuterChatResponse): string | null {
  const content = response?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    return text.length > 0 ? text : null;
  }
  return null;
}

function describePuterError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    if (/auth|token|unauthor/iu.test(message)) {
      return `Puter rejected the auth token: ${message}`;
    }
    return `Puter request failed: ${message}`;
  }
  return 'Puter request failed.';
}

function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => Error,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(makeError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Lazily loads the optional `@heyputer/puter.js` dependency. */
async function loadPuterClient(authToken: string): Promise<PuterChatClient> {
  const require = createRequire(import.meta.url);
  let init: (token?: string) => { ai?: PuterChatClient };
  try {
    ({ init } = require('@heyputer/puter.js/src/init.cjs') as {
      init: (token?: string) => { ai?: PuterChatClient };
    });
  } catch (error) {
    throw new IdenoError(
      'provider_not_configured',
      'The optional dependency @heyputer/puter.js is not installed. Run `npm install @heyputer/puter.js`.',
      { cause: error },
    );
  }

  const puter = init(authToken);
  if (!puter.ai || typeof puter.ai.chat !== 'function') {
    throw new IdenoError('provider_unavailable', 'The Puter SDK did not expose ai.chat().');
  }
  return puter.ai;
}
