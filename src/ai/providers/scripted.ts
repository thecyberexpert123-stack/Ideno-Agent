/**
 * Scripted provider.
 *
 * Two legitimate jobs, and no others:
 *
 *  1. Testing. The whole core loop — understand, update, critique, explore,
 *     decision, review, versioning — is exercised deterministically without a
 *     network, a key, or a non-reproducible model. Failure paths (timeout,
 *     empty response, malformed JSON) are testable the same way, by scripting
 *     the failure.
 *  2. An offline demo that is labelled as such in the UI, so the product can be
 *     evaluated where no provider is reachable.
 *
 * It is never presented as a model. The UI marks every turn it produces.
 */
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

export interface ScriptedResponse {
  /** Response text. Omit when scripting a failure. */
  text?: string;
  /** Fail this call with the given error instead of returning text. */
  error?: AIError;
  /** Artificial latency, used to exercise timeouts and UI pending states. */
  delay_ms?: number;
}

/**
 * Decides what a call returns.
 *
 * May return a promise, which is what lets a test model the thing that is hardest
 * to test about a real provider: a response that lands at a moment of its own
 * choosing. Concurrency bugs — a turn still running after the user opened another
 * idea, a response arriving after a timeout — cannot be reproduced with a
 * synchronous double at all.
 */
/** How a scripted response is delivered when streaming is asked for. */
export interface ScriptedStreaming {
  /** Number of pieces the text is split into. Defaults to 4. */
  chunks?: number;
  /** Pause between pieces, so a test can observe the in-between state. */
  chunk_delay_ms?: number;
}

export type ScriptedResponder = (
  request: CompletionRequest,
  index: number,
) => ScriptedResponse | Promise<ScriptedResponse>;

export interface ScriptedProviderOptions {
  /** Fixed queue, or a function that decides per call. */
  responses?: ScriptedResponse[] | ScriptedResponder;
  /** Keep serving the final response instead of erroring once exhausted. */
  repeat_last?: boolean;
  /** Override availability, to exercise the orchestrator's provider gates. */
  availability?: ProviderAvailability | (() => ProviderAvailability | Promise<ProviderAvailability>);
  /** Interactive sign-in handler, mirroring what Puter offers. */
  sign_in?: () => Promise<ProviderAvailability>;
  /**
   * Enables `completeStream`. Off by default so that the many tests which assert on
   * a single synchronous exchange keep behaving exactly as they did.
   *
   * This is the only way to test the streaming path without a network: a provider
   * that cannot deliver text in pieces cannot exercise the code that handles text
   * arriving in pieces.
   */
  streaming?: ScriptedStreaming | boolean;
}

export class ScriptedProvider implements AIProvider {
  readonly id = 'scripted' as const;
  readonly label = 'Scripted demo (no model calls)';

  #responses: ScriptedResponse[] | ScriptedResponder;
  #repeatLast: boolean;
  #availability: ScriptedProviderOptions['availability'];
  #signIn: ScriptedProviderOptions['sign_in'];
  #streaming: ScriptedStreaming | null;
  #calls = 0;
  readonly requests: CompletionRequest[] = [];

  constructor(options: ScriptedProviderOptions = {}) {
    this.#responses = options.responses ?? [];
    this.#repeatLast = options.repeat_last ?? false;
    this.#availability = options.availability;
    this.#signIn = options.sign_in;
    this.#streaming =
      options.streaming === undefined || options.streaming === false
        ? null
        : options.streaming === true
          ? {}
          : options.streaming;
  }

  get callCount(): number {
    return this.#calls;
  }

  reset(): void {
    this.#calls = 0;
    this.requests.length = 0;
  }

  capabilities(): ProviderCapabilities {
    return {
      json_mode: true,
      streaming: this.#streaming !== null,
      model_catalog: false,
      tools: false,
      max_output_tokens: false,
    };
  }

  async isAvailable(): Promise<ProviderAvailability> {
    if (typeof this.#availability === 'function') return this.#availability();
    return this.#availability ?? { available: true };
  }

  /** Present only when a sign-in handler was configured, as on real providers. */
  get signIn(): (() => Promise<ProviderAvailability>) | undefined {
    return this.#signIn;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'scripted', label: 'Scripted responses' }];
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const index = this.#calls;
    this.#calls += 1;
    this.requests.push(request);

    const response = await this.#responseFor(request, index);

    if (response.delay_ms && response.delay_ms > 0) {
      await delay(response.delay_ms, request.signal);
    }
    if (response.error) throw response.error;
    if (typeof response.text !== 'string') {
      throw new AIError('empty_response', `Scripted response #${index} has no text.`, {
        provider: this.id,
      });
    }

    return {
      text: response.text,
      model: 'scripted',
      provider_id: this.id,
      finish_reason: 'stop',
    };
  }

  /**
   * Streaming variant of `complete`.
   *
   * The text is split into pieces and delivered with a pause between them, which is
   * what makes the intermediate state observable: a test can assert that progress
   * was reported while the document was still incomplete, and that nothing was
   * written to the state until it was complete and validated.
   */
  async completeStream(request: CompletionRequest): Promise<CompletionStream> {
    if (this.#streaming === null) {
      throw new AIError('unsupported_operation', 'This scripted provider was not configured to stream.', {
        provider: this.id,
      });
    }

    const index = this.#calls;
    this.#calls += 1;
    this.requests.push(request);

    const response = await this.#responseFor(request, index);
    if (response.error) throw response.error;
    if (typeof response.text !== 'string') {
      throw new AIError('empty_response', `Scripted response #${index} has no text.`, { provider: this.id });
    }

    const pieces = splitIntoPieces(response.text, Math.max(1, this.#streaming.chunks ?? 4));
    const pause = Math.max(0, this.#streaming.chunk_delay_ms ?? 0);
    const signal = request.signal;

    async function* chunks(): AsyncGenerator<StreamChunk> {
      if (response.delay_ms && response.delay_ms > 0) await delay(response.delay_ms, signal);
      for (const piece of pieces) {
        if (signal?.aborted) {
          throw new AIError('aborted', 'The request was cancelled.');
        }
        if (pause > 0) await delay(pause, signal);
        yield { type: 'text', text: piece };
      }
      yield { type: 'finish', reason: 'stop' };
    }

    return { chunks: chunks(), model: 'scripted', provider_id: this.id };
  }

  #responseFor(request: CompletionRequest, index: number): ScriptedResponse | Promise<ScriptedResponse> {
    if (typeof this.#responses === 'function') return this.#responses(request, index);

    const queued = this.#responses[index];
    if (queued) return queued;

    if (this.#repeatLast && this.#responses.length > 0) {
      return this.#responses[this.#responses.length - 1] as ScriptedResponse;
    }

    throw new AIError(
      'provider_unavailable',
      `Scripted demo exhausted after ${index} response(s). Start a new idea or switch provider.`,
      { provider: this.id },
    );
  }
}

/**
 * Splits text into `count` roughly equal pieces without cutting a surrogate pair.
 *
 * Cutting on a code-point boundary matters even in a test double: a preview that
 * renders half of an emoji or an accented character as a replacement glyph would be
 * testing the wrong thing.
 */
export function splitIntoPieces(text: string, count: number): string[] {
  if (count <= 1 || text.length === 0) return [text];
  const characters = Array.from(text);
  const size = Math.max(1, Math.ceil(characters.length / count));
  const pieces: string[] = [];
  for (let start = 0; start < characters.length; start += size) {
    pieces.push(characters.slice(start, start + size).join(''));
  }
  return pieces;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AIError('aborted', 'The request was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new AIError('aborted', 'The request was cancelled.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
