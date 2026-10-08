import { IdenoError } from '../../core/errors.js';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  ProviderDescription,
} from '../types.js';

/**
 * Adapter for any server speaking the OpenAI `/chat/completions` protocol.
 *
 * One adapter covers OpenAI itself, OpenRouter, Groq, Together, vLLM, LM
 * Studio, llama.cpp's server and Ollama (`/v1`), which is why it is the
 * default: it is the closest thing to a portable local-or-hosted model API.
 *
 * Deliberate behaviours:
 *  - No token limit is sent unless configured. OpenAI's newer models reject
 *    `max_tokens` and older OpenAI-compatible servers reject
 *    `max_completion_tokens`, so sending neither is the only portable default.
 *  - `response_format` is probed, not assumed. Servers that reject it get one
 *    automatic retry without it, and the capability is remembered for the
 *    life of the process.
 */

export type ResponseFormatMode = 'json_object' | 'json_schema' | 'none';
export type TokenLimitField = 'max_tokens' | 'max_completion_tokens';

export interface OpenAICompatibleOptions {
  readonly id?: string;
  readonly label?: string;
  /** Base URL including the version segment, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly responseFormat?: ResponseFormatMode;
  readonly tokenLimitField?: TokenLimitField;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; code?: string; type?: string };
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly label: string;
  readonly supportsJsonSchema: boolean;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #tokenLimitField: TokenLimitField;
  readonly #extraHeaders: Record<string, string>;
  readonly #fetch: typeof fetch;
  #responseFormat: ResponseFormatMode;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id ?? 'openai-compatible';
    this.label = options.label ?? 'OpenAI-compatible endpoint';
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.#model = options.model;
    this.#responseFormat = options.responseFormat ?? 'json_object';
    this.#tokenLimitField = options.tokenLimitField ?? 'max_tokens';
    this.#extraHeaders = { ...options.extraHeaders };
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.supportsJsonSchema = this.#responseFormat === 'json_schema';
  }

  isConfigured(): boolean {
    return this.#baseUrl.length > 0 && this.#model.length > 0;
  }

  describe(): ProviderDescription {
    const configured = this.isConfigured();
    return {
      id: this.id,
      label: this.label,
      configured,
      model: this.#model || null,
      supportsJsonSchema: this.#responseFormat === 'json_schema',
      detail: configured
        ? `Calling ${this.#baseUrl} with model "${this.#model}"${this.#apiKey ? '' : ' (no API key set — fine for a local server)'}.`
        : 'Set IDENO_OPENAI_BASE_URL and IDENO_OPENAI_MODEL to enable this provider.',
      docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();
    let useResponseFormat = this.#responseFormat !== 'none' && request.jsonSchema !== undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body: Record<string, unknown> = {
        model: this.#model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxOutputTokens !== undefined) {
        body[this.#tokenLimitField] = request.maxOutputTokens;
      }
      if (useResponseFormat && request.jsonSchema) {
        body.response_format =
          this.#responseFormat === 'json_schema'
            ? {
                type: 'json_schema',
                json_schema: {
                  name: sanitizeSchemaName(request.jsonSchema.name),
                  schema: request.jsonSchema.schema,
                },
              }
            : { type: 'json_object' };
      }

      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
            ...this.#extraHeaders,
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new IdenoError(
          'provider_unavailable',
          `Could not reach ${this.#baseUrl}. Is the endpoint running and reachable?`,
          { cause: error },
        );
      }

      if (response.ok) {
        return this.#readSuccess(response, startedAt);
      }

      const errorText = await response.text().catch(() => '');
      const rejectedResponseFormat =
        response.status === 400 && useResponseFormat && /response_format|json_schema/iu.test(errorText);

      if (rejectedResponseFormat && attempt === 0) {
        // The endpoint does not understand structured-output hints. Fall back
        // permanently and rely on the runtime's schema validation instead.
        this.#responseFormat = 'none';
        useResponseFormat = false;
        continue;
      }

      throw this.#httpError(response.status, errorText);
    }

    /* c8 ignore next 2 -- the loop returns or throws on both attempts */
    throw new IdenoError('internal_error', 'OpenAI-compatible request did not complete');
  }

  async #readSuccess(response: Response, startedAt: number): Promise<CompletionResult> {
    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      throw new IdenoError('malformed_model_output', `${this.label} returned a non-JSON body.`, {
        cause: error,
      });
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      throw new IdenoError(
        'empty_model_output',
        `${this.label} returned no message content.`,
        { details: { finishReason: choice?.finish_reason ?? null } },
      );
    }

    return {
      text: content,
      providerId: this.id,
      model: payload.model ?? this.#model,
      finishReason: choice?.finish_reason ?? null,
      usage: payload.usage
        ? {
            ...(payload.usage.prompt_tokens === undefined
              ? {}
              : { inputTokens: payload.usage.prompt_tokens }),
            ...(payload.usage.completion_tokens === undefined
              ? {}
              : { outputTokens: payload.usage.completion_tokens }),
          }
        : null,
      latencyMs: Date.now() - startedAt,
    };
  }

  #httpError(status: number, body: string): IdenoError {
    const detail = extractErrorMessage(body) ?? `HTTP ${status}`;
    if (status === 401 || status === 403) {
      return new IdenoError('provider_auth_failed', `${this.label} rejected the credentials: ${detail}`);
    }
    if (status === 429) {
      return new IdenoError('provider_rate_limited', `${this.label} is rate limiting: ${detail}`);
    }
    if (status === 404) {
      return new IdenoError(
        'model_unavailable',
        `${this.label} does not expose model "${this.#model}": ${detail}`,
      );
    }
    if (status >= 500) {
      return new IdenoError('provider_unavailable', `${this.label} returned ${status}: ${detail}`);
    }
    return new IdenoError('bad_request', `${this.label} rejected the request: ${detail}`);
  }
}

function extractErrorMessage(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return body.slice(0, 300);
}

/** OpenAI requires schema names to match `^[a-zA-Z0-9_-]+$`. */
function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'ideno_response';
}
