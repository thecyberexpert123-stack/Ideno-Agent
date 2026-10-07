/**
 * Puter.js provider adapter.
 *
 * Puter.js is a browser SDK: it authenticates the *user* with Puter and bills
 * their account (the "user pays" model), so Ideno needs no API key and no
 * backend of its own. That is why it is the default provider for v0.1.
 *
 * Verified against `@heyputer/puter.js@2.6.4` (its shipped type declarations):
 *  - `puter.ai.chat(messages, options, testMode?)` resolves to a `ChatResponse`
 *    whose `message.content` is a string when `normalize: true` is passed, and
 *    may still be an array of content blocks for vendors that answer natively.
 *  - `ChatOptions` has **no** `response_format`, so JSON output cannot be
 *    requested natively; the runtime's extraction + validation path covers it.
 *  - `ChatOptions` has no abort signal, so cancellation is implemented by
 *    racing the promise. The in-flight request itself cannot be revoked.
 *  - `puter.ai.listModels()` resolves to records carrying at least `id` and
 *    `provider`.
 *  - `puter.auth.isSignedIn()` / `puter.auth.signIn()` drive authentication.
 *
 * The SDK is loaded with a dynamic `import()` so it stays in its own bundle
 * chunk and is never fetched or executed unless the user selects Puter.
 */
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatResponseChunk,
  Puter,
  StreamingChatOptions,
} from '@heyputer/puter.js';

import { AIError } from '../errors.js';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  CompletionStream,
  ModelInfo,
  ProviderAvailability,
  ProviderCapabilities,
  StreamChunk,
} from '../provider_interface/provider.js';

export type PuterLoader = () => Promise<{ puter: Puter }>;

const defaultLoader: PuterLoader = async () => {
  const existing = (globalThis as { puter?: Puter }).puter;
  if (existing) return { puter: existing };
  return import('@heyputer/puter.js');
};

export interface PuterProviderOptions {
  loader?: PuterLoader;
  /** Model id passed to `puter.ai.chat`. `null` uses Puter's own default. */
  model?: string | null;
}

export class PuterProvider implements AIProvider {
  readonly id = 'puter' as const;
  readonly label = 'Puter.js';

  #loader: PuterLoader;
  #model: string | null;
  #sdk: Puter | null = null;
  #loading: Promise<Puter> | null = null;

  constructor(options: PuterProviderOptions = {}) {
    this.#loader = options.loader ?? defaultLoader;
    this.#model = options.model ?? null;
  }

  setModel(model: string | null): void {
    this.#model = model;
  }

  capabilities(): ProviderCapabilities {
    return {
      // Puter's documented chat options do not include `response_format`.
      json_mode: false,
      streaming: true,
      model_catalog: true,
      tools: true,
      max_output_tokens: true,
    };
  }

  async isAvailable(): Promise<ProviderAvailability> {
    let puter: Puter;
    try {
      puter = await this.#load();
    } catch (error) {
      return {
        available: false,
        action: 'configure',
        reason: `Puter.js could not be loaded (${describe(error)}). Choose another provider in Settings.`,
      };
    }

    if (!safeIsSignedIn(puter)) {
      return {
        available: false,
        action: 'sign_in',
        reason:
          'Puter asks you to sign in (free) before Ideno can use its models. ' +
          'Your Puter account, not Ideno, pays for model usage.',
      };
    }
    return { available: true };
  }

  async signIn(): Promise<ProviderAvailability> {
    const puter = await this.#load();
    try {
      await puter.auth.signIn();
    } catch (error) {
      return {
        available: false,
        action: 'configure',
        reason: `Puter sign-in did not complete (${describe(error)}).`,
      };
    }
    return this.isAvailable();
  }

  async listModels(): Promise<ModelInfo[]> {
    const puter = await this.#load();
    const models = await puter.ai.listModels();
    if (!Array.isArray(models)) return [];
    const seen = new Set<string>();
    const result: ModelInfo[] = [];
    for (const entry of models) {
      const id = typeof entry?.id === 'string' ? entry.id : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name : id;
      const provider = typeof entry?.provider === 'string' ? entry.provider : undefined;
      const context = typeof entry?.context === 'number' ? entry.context : null;
      result.push({ id, label: provider ? `${name} (${provider})` : name, provider, context_window: context });
    }
    return result;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const puter = await this.#load();
    const model = request.model ?? this.#model;

    const messages: ChatMessage[] = request.messages.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    const options: ChatOptions = {
      // Forces the OpenAI-style shape so `message.content` is a string
      // regardless of which vendor Puter routed the request to.
      normalize: true,
      temperature: request.temperature,
    };
    if (model) options.model = model;
    if (typeof request.max_output_tokens === 'number') options.max_tokens = request.max_output_tokens;

    const response = (await abortable(
      puter.ai.chat(messages, options),
      request.signal,
    )) as ChatResponse | string;

    const text = extractText(response);
    if (!text.trim()) {
      throw new AIError('empty_response', 'Puter returned a response with no text content.', {
        provider: this.id,
        model: model ?? undefined,
      });
    }

    return {
      text,
      model: model ?? 'puter-default',
      provider_id: this.id,
      finish_reason: typeof response === 'object' && response !== null ? response.finish_reason ?? null : null,
    };
  }

  /**
   * Streaming completion.
   *
   * Verified against the shipped declarations of `@heyputer/puter.js@2.6.4`:
   * `chat(messages, options)` resolves to `Promise<AsyncIterable<ChatResponseChunk>>`
   * when `options.stream` is true (the `StreamingChatOptions` overload), and each
   * chunk carries a `type` discriminator — `"text"`, `"reasoning"`, `"usage"`,
   * `"error"` and others — with the payload in the field named by that type.
   *
   * Two things this adapter owns:
   *
   *  - **Chunk normalisation.** The chunk shape is Puter's; `StreamChunk` is
   *    Ideno's. Anything that is not text or reasoning is dropped rather than
   *    forwarded, because a consumer that has to know about `"compaction"` chunks is
   *    no longer provider-neutral.
   *  - **Cancellation.** `chat()` takes no abort signal, so obtaining the iterable
   *    is raced against the signal and the iteration itself checks it between
   *    chunks. The upstream request keeps running — that is a Puter limitation with
   *    a billing consequence, and it is documented rather than hidden.
   */
  async completeStream(request: CompletionRequest): Promise<CompletionStream> {
    const puter = await this.#load();
    const model = request.model ?? this.#model;

    const messages: ChatMessage[] = request.messages.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    const options: StreamingChatOptions = {
      stream: true,
      normalize: true,
      temperature: request.temperature,
    };
    if (model) options.model = model;
    if (typeof request.max_output_tokens === 'number') options.max_tokens = request.max_output_tokens;

    const iterable = (await abortable(
      puter.ai.chat(messages, options),
      request.signal,
    )) as AsyncIterable<ChatResponseChunk>;

    const signal = request.signal;
    const providerId = this.id;

    async function* chunks(): AsyncGenerator<StreamChunk> {
      for await (const chunk of iterable) {
        // Checked between chunks: a cancelled turn must stop producing text even
        // though the upstream request cannot be revoked.
        if (signal?.aborted) return;
        const mapped = mapChunk(chunk);
        if (mapped === 'error') {
          throw new AIError('unknown', `Puter reported an error mid-stream: ${describeChunkError(chunk)}`, {
            provider: providerId,
            model: model ?? undefined,
          });
        }
        if (mapped) yield mapped;
      }
    }

    return { chunks: chunks(), model: model ?? 'puter-default', provider_id: this.id };
  }

  async #load(): Promise<Puter> {
    if (this.#sdk) return this.#sdk;
    if (!this.#loading) {
      this.#loading = this.#loader()
        .then((mod) => {
          if (!mod?.puter) throw new Error('the SDK module did not expose `puter`');
          this.#sdk = mod.puter;
          return mod.puter;
        })
        .catch((error: unknown) => {
          this.#loading = null;
          throw new AIError(
            'provider_unavailable',
            `Puter.js could not be loaded: ${describe(error)}`,
            { provider: this.id, cause: error },
          );
        });
    }
    return this.#loading;
  }
}

/**
 * Maps a Puter chunk onto Ideno's `StreamChunk`, or null when it carries nothing
 * Ideno acts on.
 *
 * The `"error"` case is signalled separately because it must end the stream with a
 * failure rather than being quietly skipped: a stream that stops early and reports
 * success would hand the runtime a truncated document to validate.
 */
function mapChunk(chunk: ChatResponseChunk | null | undefined): StreamChunk | 'error' | null {
  if (!chunk || typeof chunk !== 'object') return null;
  switch (chunk.type) {
    case 'text':
      return typeof chunk.text === 'string' && chunk.text.length > 0
        ? { type: 'text', text: chunk.text }
        : null;
    case 'reasoning':
      return typeof chunk.reasoning === 'string' && chunk.reasoning.length > 0
        ? { type: 'reasoning', text: chunk.reasoning }
        : null;
    case 'usage': {
      const usage = chunk.usage;
      return {
        type: 'finish',
        usage:
          usage && typeof usage === 'object'
            ? {
                input_tokens: numberOf(usage, 'input_tokens', 'prompt_tokens'),
                output_tokens: numberOf(usage, 'output_tokens', 'completion_tokens'),
              }
            : undefined,
      };
    }
    case 'error':
      return 'error';
    default:
      // image, tool_use, compaction, extra_content: nothing Ideno consumes today.
      return null;
  }
}

function describeChunkError(chunk: ChatResponseChunk): string {
  return typeof chunk.message === 'string' && chunk.message.trim() ? chunk.message : 'no detail given';
}

/**
 * Reads a token count out of a usage record whose field names differ by vendor.
 * Puter documents the field as present on the final `"usage"` chunk but not its
 * spelling, so both OpenAI-style names are accepted and anything else yields
 * undefined rather than 0 — an absent count and a zero count are different claims.
 */
function numberOf(usage: Record<string, number>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Reads text out of a Puter response without assuming a single shape: with
 * `normalize: true` it is a string, but vendors can still return an array of
 * content blocks, and some SDK paths resolve to a bare string.
 */
export function extractText(response: ChatResponse | string | null | undefined): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const content = response.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function safeIsSignedIn(puter: Puter): boolean {
  try {
    return puter.auth?.isSignedIn() === true;
  } catch {
    // A throwing auth module means we cannot claim the provider is ready.
    return false;
  }
}

/**
 * Rejects as soon as `signal` aborts. Puter's `chat()` accepts no signal, so the
 * underlying request keeps running; what matters for Ideno is that a timed-out
 * turn can never resolve late and mutate state afterwards.
 */
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new AIError('aborted', 'The request was cancelled.');
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AIError('aborted', 'The request was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown error';
}
