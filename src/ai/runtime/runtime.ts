/**
 * The AI Runtime.
 *
 * This is the layer Ideno Core actually depends on. It owns everything that is
 * true of *all* providers and nothing that is true of only one:
 *
 *  - building the structured-output contract (JSON Schema derived from the same
 *    zod schema that validates the result, so the two can never drift),
 *  - enforcing a wall-clock timeout and cooperative cancellation,
 *  - extracting JSON from a response that may be wrapped in prose,
 *  - validating that JSON, and
 *  - one repair round-trip that feeds the validation errors back to the model.
 *
 * If validation still fails, the runtime throws and the Idea State is left
 * untouched. Silent partial application is the failure mode this file exists to
 * prevent.
 */
import { z } from 'zod';

import { AIError, toAIError, type AIErrorDetails } from '../errors.js';
import type {
  AIProvider,
  ChatTurn,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ProviderAvailability,
  ProviderCapabilities,
} from '../provider_interface/provider.js';
import { formatZodIssues, type Operation } from '../../core/schemas/index.js';
import { extractJson } from './json_extract.js';

export interface RuntimeOptions {
  temperature?: number;
  timeout_ms?: number;
  model?: string | null;
  /** Total attempts including the first: 2 means one repair round-trip. */
  max_attempts?: number;
  max_output_tokens?: number;
}

export interface StructuredCallOptions<T> {
  task: Operation;
  /** System prompt: Ideno's standing instructions for this operation. */
  system: string;
  /**
   * The conversation to send after the system prompt. Built by
   * `prepareOperation`, so the runtime never decides what context a model sees.
   */
  turns: ChatTurn[];
  schema: z.ZodType<T>;
  /** Prose contract placed next to the generated JSON Schema. */
  contract_notes?: string;
  model?: string | null;
  temperature?: number;
  timeout_ms?: number;
  max_output_tokens?: number;
  signal?: AbortSignal;
  /**
   * Called as the response arrives, with the text accumulated so far.
   *
   * Purely informational: it exists so the UI can show what the model is forming
   * instead of a spinner. It is throttled by the runtime, never called after the
   * response is complete, and cannot influence what is validated or written.
   */
  on_progress?: (accumulated: string) => void;
}

export interface StructuredCallResult<T> {
  value: T;
  attempts: number;
  /** True when the first response failed validation and a repair succeeded. */
  repaired: boolean;
  raw_text: string;
  model: string;
  provider_id: CompletionResult['provider_id'];
  finish_reason?: string | null;
  usage?: CompletionResult['usage'];
}

const DEFAULTS: Required<Pick<RuntimeOptions, 'temperature' | 'timeout_ms' | 'max_attempts'>> = {
  temperature: 0.3,
  timeout_ms: 60_000,
  max_attempts: 2,
};

const MAX_ISSUES_REPORTED = 8;
const REPAIR_ECHO_LIMIT = 4000;
/**
 * Minimum gap between progress callbacks.
 *
 * A token stream can emit hundreds of chunks a second; reparsing a partial document
 * for each one would cost more than the response does. The preview is decoration, so
 * it is throttled to something a person can read.
 */
const PROGRESS_THROTTLE_MS = 120;

export class AIRuntime {
  #provider: AIProvider;
  #options: RuntimeOptions;

  constructor(provider: AIProvider, options: RuntimeOptions = {}) {
    this.#provider = provider;
    this.#options = options;
  }

  get provider(): AIProvider {
    return this.#provider;
  }

  get provider_id(): string {
    return this.#provider.id;
  }

  /** Swapping providers must never require touching Ideno Core. */
  setProvider(provider: AIProvider): void {
    this.#provider = provider;
  }

  updateOptions(options: RuntimeOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  capabilities(): ProviderCapabilities {
    return this.#provider.capabilities();
  }

  availability(): Promise<ProviderAvailability> {
    return this.#provider.isAvailable();
  }

  listModels(): Promise<ModelInfo[]> {
    return this.#provider.listModels();
  }

  signIn(): Promise<ProviderAvailability> {
    if (!this.#provider.signIn) {
      return Promise.resolve({
        available: false,
        reason: `${this.#provider.label} has no interactive sign-in.`,
        action: 'configure',
      });
    }
    return this.#provider.signIn();
  }

  /** True when the active provider advertises streaming and implements it. */
  #canStream(): boolean {
    const provider = this.#provider;
    if (typeof provider.completeStream !== 'function') return false;
    try {
      return provider.capabilities().streaming === true;
    } catch {
      // A provider whose capabilities() throws cannot be trusted to stream.
      return false;
    }
  }

  /**
   * Streams a completion, accumulating text, and returns the same
   * `CompletionResult` a non-streamed call would.
   *
   * The whole response is assembled before anything is validated: a streamed
   * document is subject to exactly the same extraction, schema check and repair
   * round-trip as a non-streamed one. What streaming changes is only that the user
   * sees it arriving.
   */
  async completeStreaming(
    request: Omit<CompletionRequest, 'model' | 'temperature' | 'timeout_ms'> & {
      model?: string | null;
      temperature?: number;
      timeout_ms?: number;
    },
    onProgress: (accumulated: string) => void,
  ): Promise<CompletionResult> {
    const provider = this.#provider;
    const stream = provider.completeStream;
    if (!stream) throw new AIError('unsupported_operation', 'This provider cannot stream.');

    const timeoutMs = request.timeout_ms ?? this.#options.timeout_ms ?? DEFAULTS.timeout_ms;
    const model = request.model ?? this.#options.model ?? null;

    const run = async (signal: AbortSignal): Promise<CompletionResult> => {
      const opened = await stream.call(provider, {
        ...request,
        model,
        temperature: request.temperature ?? this.#options.temperature ?? DEFAULTS.temperature,
        timeout_ms: timeoutMs,
        signal,
      });

      let text = '';
      let finishReason: string | null = null;
      let usage: CompletionResult['usage'];
      let lastEmit = 0;

      for await (const chunk of opened.chunks) {
        if (signal.aborted) throw new AIError('aborted', 'The request was cancelled.');
        if (chunk.type === 'text') {
          text += chunk.text;
          const now = Date.now();
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now;
            emitProgress(onProgress, text);
          }
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason ?? finishReason;
          if (chunk.usage) usage = chunk.usage;
        }
        // `reasoning` chunks are deliberately dropped: Ideno stores a summary of the
        // reasoning it was given, never a transcript of it.
      }

      // One final report, unthrottled. Without it a response that arrives in under
      // the throttle interval reports only its first chunk — which is the one with
      // the least in it — and the user sees a preview of nothing.
      if (text.length > 0) emitProgress(onProgress, text);

      return {
        text,
        model: opened.model,
        provider_id: opened.provider_id,
        finish_reason: finishReason,
        usage,
      };
    };

    try {
      return await runWithTimeout(run, timeoutMs, request.signal);
    } catch (error) {
      throw toAIError(error, { provider: this.#provider.id, model: model ?? undefined });
    }
  }

  /** Raw completion, with timeout and error normalisation applied. */
  async complete(request: Omit<CompletionRequest, 'model' | 'temperature' | 'timeout_ms'> & {
    model?: string | null;
    temperature?: number;
    timeout_ms?: number;
  }): Promise<CompletionResult> {
    const timeoutMs = request.timeout_ms ?? this.#options.timeout_ms ?? DEFAULTS.timeout_ms;
    const model = request.model ?? this.#options.model ?? null;

    const attempt = (signal: AbortSignal): Promise<CompletionResult> =>
      this.#provider.complete({
        ...request,
        model,
        temperature: request.temperature ?? this.#options.temperature ?? DEFAULTS.temperature,
        timeout_ms: timeoutMs,
        signal,
      });

    try {
      return await runWithTimeout(attempt, timeoutMs, request.signal);
    } catch (error) {
      throw toAIError(error, {
        provider: this.#provider.id,
        model: model ?? undefined,
      });
    }
  }

  /**
   * Structured completion: the only way reasoning modules talk to a model.
   * Returns a validated `T` or throws `AIError('malformed_response')` carrying
   * the raw text so the caller can still show the user something honest.
   */
  async structured<T>(options: StructuredCallOptions<T>): Promise<StructuredCallResult<T>> {
    const maxAttempts = Math.max(1, this.#options.max_attempts ?? DEFAULTS.max_attempts);
    // Providers with a native JSON mode get the hint; providers without one are
    // handled by extraction + validation, so the caller never has to care.
    const jsonMode = this.#provider.capabilities().json_mode;

    const messages: ChatTurn[] = [
      { role: 'system', content: options.system },
      ...options.turns,
    ];
    appendContract(messages, options);

    let lastRaw = '';
    let issues: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: CompletionResult;
      const request = {
        task: options.task,
        messages,
        model: options.model,
        temperature: options.temperature,
        max_output_tokens: options.max_output_tokens,
        timeout_ms: options.timeout_ms,
        signal: options.signal,
        json_mode: jsonMode,
      };
      try {
        // Streaming is used only when the caller wants progress *and* the provider
        // can do it. Either condition missing falls back to the ordinary call, so
        // there is one code path that decides what is valid.
        result =
          options.on_progress && this.#canStream()
            ? await this.completeStreaming(request, options.on_progress)
            : await this.complete(request);
      } catch (error) {
        // Attach the last raw text we have, if any, then let the caller handle it.
        if (error instanceof AIError && lastRaw) {
          throw new AIError(error.code, error.message, { ...error.details, raw_text: lastRaw });
        }
        throw error;
      }

      lastRaw = result.text;
      if (!result.text.trim()) {
        issues = ['The response was empty.'];
        if (attempt === maxAttempts) {
          throw new AIError('empty_response', 'The model returned an empty response.', {
            provider: this.#provider.id,
            model: result.model,
            raw_text: lastRaw,
          });
        }
      } else {
        const extraction = extractJson(result.text);
        if (extraction.strategy === 'none') {
          issues = [extraction.error ?? 'No JSON found in the response.'];
        } else {
          const parsed = options.schema.safeParse(extraction.json);
          if (parsed.success) {
            return {
              value: parsed.data,
              attempts: attempt,
              repaired: attempt > 1,
              raw_text: result.text,
              model: result.model,
              provider_id: result.provider_id,
              finish_reason: result.finish_reason ?? null,
              usage: result.usage,
            };
          }
          issues = formatIssues(parsed.error);
        }
      }

      if (attempt === maxAttempts) break;

      // One repair round-trip: show the model exactly what was wrong.
      messages.push(
        { role: 'assistant', content: truncate(result.text, REPAIR_ECHO_LIMIT) },
        { role: 'user', content: repairInstruction(issues) },
      );
    }

    const details: AIErrorDetails = {
      provider: this.#provider.id,
      issues,
      raw_text: lastRaw,
      raw_excerpt: truncate(lastRaw, 240),
    };
    throw new AIError(
      'malformed_response',
      `The model response could not be validated after ${maxAttempts} attempt(s).`,
      details,
    );
  }
}

/**
 * Runs `fn` under a wall-clock budget, propagating an optional external abort.
 * Distinguishes "we gave up waiting" from "the caller cancelled", because those
 * deserve different messages and different retry behaviour.
 */
export async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  if (external?.aborted) throw new AIError('aborted', 'The request was cancelled before it started.');

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new AIError('timeout', `The model did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (external?.aborted) {
      throw new AIError('aborted', 'The request was cancelled.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Reports progress, containing a broken listener.
 *
 * A UI callback that throws must not abort a model call that is otherwise going
 * perfectly well: the preview is decoration, and losing the response because of it
 * would be the worst possible trade.
 */
function emitProgress(onProgress: (accumulated: string) => void, text: string): void {
  try {
    onProgress(text);
  } catch {
    // ignored on purpose
  }
}

/** Validation issues rendered for the repair prompt sent back to the model. */
export function formatIssues(error: z.ZodError): string[] {
  return formatZodIssues(error, MAX_ISSUES_REPORTED);
}

function repairInstruction(issues: string[]): string {
  return [
    'Your previous reply could not be used. Fix it and reply again.',
    'Problems found:',
    ...issues.map((issue) => `- ${issue}`),
    'Reply with ONLY the corrected JSON value. No prose, no code fence, no commentary.',
  ].join('\n');
}

/**
 * Appends the output contract as a final user turn. Keeping it last means it is
 * the instruction closest to the generation point, which is where models attend
 * most reliably — and it is appended to the same array the repair round-trip
 * extends, so the contract is never lost mid-conversation.
 */
function appendContract<T>(messages: ChatTurn[], options: StructuredCallOptions<T>): void {
  messages.push({ role: 'user', content: buildContractMessage(options) });
}

function buildContractMessage<T>(options: StructuredCallOptions<T>): string {
  const parts = ['--- OUTPUT CONTRACT ---'];
  const schemaJson = safeToJsonSchema(options.schema);
  if (schemaJson) {
    parts.push('Respond with a single JSON value matching this JSON Schema:', schemaJson);
  } else {
    parts.push(
      'Respond with a single JSON object matching the fields described in your instructions.',
    );
  }
  if (options.contract_notes) parts.push('', options.contract_notes);
  parts.push(
    '',
    'Rules: output JSON only (no code fence, no commentary); every string must be non-empty;',
    'never invent ids — reference only ids listed in the context; never label your own',
    'recollection as evidence.',
  );
  return parts.join('\n');
}

/**
 * `z.toJSONSchema` can throw on types it cannot represent. That must not take
 * the application down: the prompt still carries a hand-written contract, so we
 * degrade to that instead.
 */
export function safeToJsonSchema<T>(schema: z.ZodType<T>): string | null {
  try {
    return JSON.stringify(z.toJSONSchema(schema as unknown as z.ZodType));
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
