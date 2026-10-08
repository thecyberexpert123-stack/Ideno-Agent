import { z } from 'zod';
import { IdenoError, toIdenoError } from '../core/errors.js';
import { parseModelJson } from './json.js';
import type {
  AIProvider,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  ProviderDescription,
} from './types.js';

/**
 * The AI Runtime.
 *
 * Responsibilities that belong here rather than in any provider or in Ideno
 * Core: provider selection, timeouts, bounded retries, JSON recovery, schema
 * validation of model output, and one corrective re-ask when the model
 * returns something the schema rejects.
 *
 * Everything this class returns is already validated. Callers in
 * `src/reasoning` therefore never handle raw model text.
 */

export interface AIRuntimeOptions {
  readonly providers: readonly AIProvider[];
  /** Provider used when a request does not name one. */
  readonly defaultProviderId?: string;
  readonly timeoutMs?: number;
  /** Attempts per call, including the first. 1 disables transport retries. */
  readonly maxAttempts?: number;
  /** Corrective re-asks when output fails schema validation. */
  readonly maxRepairAttempts?: number;
}

export interface StructuredRequest<TSchema extends z.ZodTypeAny> {
  readonly schema: TSchema;
  /** Name used in the JSON Schema sent to providers that support it. */
  readonly schemaName: string;
  readonly system: string;
  readonly user: string;
  readonly providerId?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly purpose: string;
}

export interface StructuredResult<T> {
  readonly value: T;
  readonly raw: string;
  readonly providerId: string;
  readonly model: string;
  readonly latencyMs: number;
  /** True when JSON had to be recovered from prose or a code fence. */
  readonly recovered: boolean;
  /** Number of corrective re-asks performed. */
  readonly repairs: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_REPAIRS = 1;

/** Error codes where trying the exact same call again can plausibly help. */
const TRANSIENT_CODES = new Set(['provider_unavailable', 'provider_timeout', 'provider_rate_limited']);

export class AIRuntime {
  readonly #providers: Map<string, AIProvider>;
  readonly #order: string[];
  readonly #defaultProviderId: string | null;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #maxRepairs: number;

  constructor(options: AIRuntimeOptions) {
    this.#providers = new Map(options.providers.map((provider) => [provider.id, provider]));
    this.#order = options.providers.map((provider) => provider.id);
    this.#defaultProviderId = options.defaultProviderId ?? null;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#maxRepairs = Math.max(0, options.maxRepairAttempts ?? DEFAULT_MAX_REPAIRS);
  }

  listProviders(): ProviderDescription[] {
    return this.#order
      .map((id) => this.#providers.get(id))
      .filter((provider): provider is AIProvider => provider !== undefined)
      .map((provider) => provider.describe());
  }

  /** The provider a request would use, or null when none is usable. */
  activeProviderId(requested?: string): string | null {
    if (requested) {
      const provider = this.#providers.get(requested);
      return provider?.isConfigured() ? provider.id : null;
    }
    if (this.#defaultProviderId) {
      const preferred = this.#providers.get(this.#defaultProviderId);
      if (preferred?.isConfigured()) return preferred.id;
    }
    for (const id of this.#order) {
      const provider = this.#providers.get(id);
      if (provider?.isConfigured()) return provider.id;
    }
    return null;
  }

  get isReady(): boolean {
    return this.activeProviderId() !== null;
  }

  #resolveProvider(requested?: string): AIProvider {
    if (requested) {
      const provider = this.#providers.get(requested);
      if (!provider) {
        throw new IdenoError('bad_request', `Unknown AI provider "${requested}"`);
      }
      if (!provider.isConfigured()) {
        throw new IdenoError('provider_not_configured', provider.describe().detail);
      }
      return provider;
    }

    const activeId = this.activeProviderId();
    if (!activeId) {
      const detail = this.listProviders()
        .map((description) => `${description.label}: ${description.detail}`)
        .join(' ');
      throw new IdenoError(
        'provider_not_configured',
        'No AI provider is configured. Ideno cannot reason about an idea without one.',
        { details: { providers: this.listProviders(), hint: detail } },
      );
    }
    return this.#providers.get(activeId) as AIProvider;
  }

  /** Single completion with timeout and bounded retry. Returns raw text. */
  async complete(request: CompletionRequest & { providerId?: string }): Promise<CompletionResult> {
    const provider = this.#resolveProvider(request.providerId);
    let lastError: IdenoError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const onExternalAbort = (): void => controller.abort();
      request.signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const result = await provider.complete({ ...request, signal: controller.signal });
        if (result.text.trim().length === 0) {
          throw new IdenoError('empty_model_output', `${provider.label} returned an empty response.`);
        }
        return result;
      } catch (error) {
        const normalized = normalizeProviderError(error, provider, controller.signal, request.signal);
        lastError = normalized;
        const canRetry = attempt < this.#maxAttempts && TRANSIENT_CODES.has(normalized.code);
        if (!canRetry) throw normalized;
        await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onExternalAbort);
      }
    }

    /* c8 ignore next 2 -- the loop always returns or throws */
    throw lastError ?? new IdenoError('internal_error', 'AI completion failed without an error');
  }

  /**
   * Completion that must satisfy a Zod schema.
   *
   * On a schema or JSON failure the model is re-asked once with the concrete
   * validation errors appended. If it still fails, a `malformed_model_output`
   * error is raised — the caller degrades, and the Idea State is untouched.
   */
  async completeStructured<TSchema extends z.ZodTypeAny>(
    request: StructuredRequest<TSchema>,
  ): Promise<StructuredResult<z.infer<TSchema>>> {
    const provider = this.#resolveProvider(request.providerId);
    const jsonSchema = toJsonSchema(request.schema, request.schemaName);

    const messages: CompletionMessage[] = [
      { role: 'system', content: `${request.system}\n\n${schemaContract(jsonSchema)}` },
      { role: 'user', content: request.user },
    ];

    let repairs = 0;

    for (;;) {
      const completion = await this.complete({
        messages,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        jsonSchema: { name: request.schemaName, schema: jsonSchema },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        purpose: request.purpose,
        providerId: provider.id,
      });

      const parsed = parseModelJson(completion.text);
      // Scoped to this attempt: it is only ever read by the repair prompt
      // (or the error) produced from the same response.
      let lastProblem: string;
      if (parsed.ok) {
        const validated = request.schema.safeParse(parsed.value);
        if (validated.success) {
          return {
            value: validated.data as z.infer<TSchema>,
            raw: completion.text,
            providerId: completion.providerId,
            model: completion.model,
            latencyMs: completion.latencyMs,
            recovered: parsed.recovered,
            repairs,
          };
        }
        lastProblem = formatIssues(validated.error);
      } else {
        lastProblem = parsed.reason;
      }

      if (repairs >= this.#maxRepairs) {
        throw new IdenoError(
          'malformed_model_output',
          `${provider.label} did not return output matching the required structure for "${request.purpose}".`,
          { details: { problem: lastProblem, purpose: request.purpose } },
        );
      }

      repairs += 1;
      messages.push({ role: 'assistant', content: truncate(completion.text, 4000) });
      messages.push({
        role: 'user',
        content:
          'That response could not be used. Problem:\n' +
          `${lastProblem}\n\n` +
          'Reply again with the corrected JSON only. No prose, no code fence.',
      });
    }
  }
}

function backoffMs(attempt: number): number {
  // Short, bounded backoff: these are interactive requests, not a batch job.
  return Math.min(2000, 250 * 2 ** (attempt - 1));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Converts a Zod schema into the JSON Schema sent to the provider. */
export function toJsonSchema(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
  return { title: name, ...generated };
}

function schemaContract(jsonSchema: Record<string, unknown>): string {
  return [
    'Respond with a single JSON document and nothing else.',
    'Do not wrap it in a code fence. Do not add commentary before or after it.',
    'It must validate against this JSON Schema:',
    JSON.stringify(jsonSchema),
  ].join('\n');
}

/**
 * Maps a provider failure onto the Ideno error taxonomy, distinguishing an
 * Ideno-imposed timeout from a caller-initiated cancellation.
 */
function normalizeProviderError(
  error: unknown,
  provider: AIProvider,
  internalSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
): IdenoError {
  if (error instanceof IdenoError) return error;

  const aborted = internalSignal.aborted;
  const cancelledByCaller = externalSignal?.aborted === true;
  if (aborted && !cancelledByCaller) {
    return new IdenoError('provider_timeout', `${provider.label} did not respond in time.`, {
      cause: error,
    });
  }
  if (cancelledByCaller) {
    return new IdenoError('bad_request', 'The request was cancelled.', { cause: error });
  }
  return toIdenoError(error, `${provider.label} failed to produce a completion.`);
}
