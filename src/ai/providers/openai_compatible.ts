/**
 * OpenAI-compatible HTTP provider adapter.
 *
 * Exists for two reasons:
 *  1. It proves the provider abstraction — Ideno Core gained a second provider
 *     without a single change outside `src/ai/providers/`.
 *  2. It makes Ideno usable against anything that speaks the OpenAI chat
 *     completions protocol: OpenAI itself, OpenRouter, Azure OpenAI, vLLM,
 *     llama.cpp server, LM Studio, Ollama's OpenAI-compatible endpoint.
 *
 * Security notes:
 *  - The API key is held in memory by this class. Whether it is persisted at all
 *    is the user's explicit choice (`persist_api_key` in Settings), because a key
 *    in `localStorage` is readable by any script on the same origin.
 *  - Plain `http://` base URLs are only accepted for loopback hosts, so a key can
 *    be sent to a local model server but never over the open internet.
 *  - The key is never written to logs, errors, or the DOM.
 */
import { DISCOVERY_TIMEOUT_MS, discoverModels, type DiscoveryFetch } from '../discovery.js';
import { AIError, toAIError } from '../errors.js';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ProviderAvailability,
  ProviderCapabilities,
} from '../provider_interface/provider.js';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchLike {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<FetchResponseLike>;
}

export interface OpenAICompatibleConfig {
  /** e.g. `https://api.openai.com/v1` or `http://127.0.0.1:8080/v1`. */
  base_url: string;
  model: string;
  api_key?: string;
  /** Endpoint supports `response_format: { type: "json_object" }`. */
  json_mode?: boolean;
  fetch_impl?: FetchLike;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai_compatible' as const;
  readonly label = 'OpenAI-compatible endpoint';

  #config: OpenAICompatibleConfig;
  /**
   * Whether the last `listModels()` actually enumerated the endpoint.
   *
   * Tracked because `capabilities().model_catalog` should report what this endpoint
   * does, not what the protocol allows in principle. It starts false and is only ever
   * set by a successful discovery, so a UI can tell "here are your models" apart from
   * "here is the one you typed".
   */
  #modelCatalog = false;

  constructor(config: OpenAICompatibleConfig) {
    this.#config = config;
  }

  update(config: Partial<OpenAICompatibleConfig>): void {
    this.#config = { ...this.#config, ...config };
  }

  /** Masked description for logs and UI. Never contains the key. */
  describe(): string {
    const url = this.#config.base_url || '(no base URL)';
    const model = this.#config.model || '(no model)';
    return `${url} · ${model} · key ${this.#config.api_key ? 'set' : 'not set'}`;
  }

  capabilities(): ProviderCapabilities {
    return {
      json_mode: this.#config.json_mode === true,
      streaming: false,
      model_catalog: this.#modelCatalog,
      tools: false,
      max_output_tokens: true,
    };
  }

  async isAvailable(): Promise<ProviderAvailability> {
    const validation = validateConfig(this.#config);
    if (!validation.ok) return { available: false, action: 'configure', reason: validation.reason };
    return { available: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    const validation = validateConfig(this.#config);
    if (!validation.ok) return [];

    // Ask the endpoint rather than guessing. Enumeration is not portable across
    // OpenAI-compatible servers — some expose /models, many do not — so a failure here
    // is ordinary and falls back to the configured model instead of reporting the
    // endpoint as broken.
    const discovered = await discoverModels(
      {
        base_url: this.#config.base_url,
        api_key: this.#config.api_key ?? null,
        timeout_ms: DISCOVERY_TIMEOUT_MS,
        ...(this.#config.fetch_impl
          ? { fetch_impl: this.#config.fetch_impl as unknown as DiscoveryFetch }
          : {}),
      },
    );
    if (discovered.ok && discovered.models.length > 0) {
      this.#modelCatalog = true;
      return discovered.models;
    }

    this.#modelCatalog = false;
    return [{ id: this.#config.model, label: this.#config.model }];
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const validation = validateConfig(this.#config);
    if (!validation.ok) {
      throw new AIError('provider_unavailable', validation.reason, { provider: this.id });
    }

    const model = request.model ?? this.#config.model;
    const url = completionsUrl(this.#config.base_url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.#config.api_key) headers.Authorization = `Bearer ${this.#config.api_key}`;

    const body: Record<string, unknown> = {
      model,
      stream: false,
      messages: request.messages.map((turn) => ({ role: turn.role, content: turn.content })),
    };
    if (typeof request.temperature === 'number') body.temperature = request.temperature;
    if (typeof request.max_output_tokens === 'number') body.max_tokens = request.max_output_tokens;
    if (request.json_mode && this.#config.json_mode) body.response_format = { type: 'json_object' };

    const doFetch = this.#config.fetch_impl ?? (fetch as unknown as FetchLike);

    let response: FetchResponseLike;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (request.signal?.aborted) throw new AIError('aborted', 'The request was cancelled.');
      throw new AIError('network', `The request to ${url} failed: ${messageOf(error)}`, {
        provider: this.id,
        model,
        cause: error,
      });
    }

    if (!response.ok) {
      const detail = await safeBodyText(response);
      throw toAIError(
        { status: response.status, message: `HTTP ${response.status} from ${url}. ${detail}`.trim() },
        { provider: this.id, model },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AIError('malformed_response', `The endpoint returned invalid JSON: ${messageOf(error)}`, {
        provider: this.id,
        model,
      });
    }

    const text = extractCompletionText(payload);
    if (!text.trim()) {
      throw new AIError('empty_response', 'The endpoint returned a completion with no text content.', {
        provider: this.id,
        model,
      });
    }

    return {
      text,
      model: readString(payload, 'model') ?? model,
      provider_id: this.id,
      finish_reason: readFinishReason(payload),
      usage: readUsage(payload),
    };
  }
}

/**
 * Accepts `.../v1`, `.../v1/`, `.../v1/chat/completions` and normalises all of
 * them to the chat completions URL.
 */
export function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

export type ConfigValidation = { ok: true } | { ok: false; reason: string };

export function validateConfig(config: OpenAICompatibleConfig): ConfigValidation {
  const base = validateBaseUrl(config.base_url);
  if (!base.ok) return base;
  if (!config.model?.trim()) return { ok: false, reason: 'Set a model id in Settings.' };
  return { ok: true };
}

/**
 * Validates a base URL on its own, without requiring a model.
 *
 * Split out from `validateConfig` because discovery needs it and must not inherit the
 * model requirement: listing an endpoint's models is exactly what somebody does *before*
 * they know which model to name. Requiring a model to discover models would be circular.
 *
 * The security rule lives here and only here, so completion and discovery cannot drift
 * apart on it: plain `http://` is accepted for loopback hosts only, which lets a key
 * reach a local model server but never the open internet.
 */
export function validateBaseUrl(raw: string | undefined | null): ConfigValidation {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Set the endpoint base URL in Settings (for example https://api.openai.com/v1).' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `"${trimmed}" is not a valid URL.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'The base URL must use http or https.' };
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return {
      ok: false,
      reason:
        'Plain http is only allowed for loopback hosts (localhost / 127.0.0.1 / ::1). ' +
        'Sending an API key over unencrypted http is not permitted.',
    };
  }
  return { ok: true };
}

/** Handles both the classic string content and the newer content-part arrays. */
export function extractCompletionText(payload: unknown): string {
  const choice = firstChoice(payload);
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  // Some gateways answer with a bare `text` field instead of `message`.
  if (isRecord(choice) && typeof choice.text === 'string') return choice.text;
  return '';
}

function firstChoice(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0) return choices[0];
  return undefined;
}

function readFinishReason(payload: unknown): string | null {
  const choice = firstChoice(payload);
  if (isRecord(choice) && typeof choice.finish_reason === 'string') return choice.finish_reason;
  return null;
}

function readUsage(payload: unknown): { input_tokens?: number; output_tokens?: number } | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const result: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof input === 'number') result.input_tokens = input;
  if (typeof output === 'number') result.output_tokens = output;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readString(payload: unknown, key: string): string | null {
  if (isRecord(payload) && typeof payload[key] === 'string') return payload[key] as string;
  return null;
}

async function safeBodyText(response: FetchResponseLike): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
