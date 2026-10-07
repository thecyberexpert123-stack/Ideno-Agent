/**
 * Endpoint discovery and verification for custom agents.
 *
 * Two questions a user setting up an agent actually need answered, and neither is
 * answered by a form that accepts whatever is typed into it:
 *
 *  1. **What models does this endpoint serve?** `discoverModels` asks the endpoint
 *     itself, so a model id is chosen from a list rather than remembered or guessed.
 *  2. **Does a call to it actually work?** `probeAgent` sends one minimal completion and
 *     reports what came back, which distinguishes "the key is valid" from "the key is
 *     valid *and this model answers*".
 *
 * Both operate on a plain configuration object rather than on a live provider, because
 * the whole point is to check an agent **before** it is saved and selected. A
 * verification step that only works on the already-active provider would force the user
 * to break their working setup to test a new one.
 *
 * ## Security
 *
 * The same rule the provider enforces applies here: plain `http://` is accepted only for
 * loopback hosts, so a key can reach a local model server but never the open internet.
 * A key is never interpolated into an error message, a log line, or a returned reason —
 * every failure string in this module is built from the URL, the status code and the
 * server's own words.
 */
import { z } from 'zod';

import { validateBaseUrl } from './providers/openai_compatible.js';
import type { ModelInfo } from './provider_interface/provider.js';

/**
 * A fetch seam whose body is optional.
 *
 * The provider's `FetchLike` requires `body: string`, which is right for completions and
 * wrong here: a real `fetch` *throws* when given a body with `GET`. Discovery issues
 * GETs, so it needs its own seam rather than sending `body: ''` and hoping.
 */
export interface DiscoveryFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<DiscoveryResponse>;
}

export interface DiscoveryResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface AgentEndpointConfig {
  base_url: string;
  /** Optional by design: a local server may need none. */
  api_key?: string | null;
  /** Required only by `probeAgent`, which has something to call. */
  model?: string | null;
  timeout_ms?: number;
  fetch_impl?: DiscoveryFetch;
}

export interface DiscoveryResult {
  ok: boolean;
  models: ModelInfo[];
  /** Present when `ok` is false. Never contains an API key. */
  reason?: string;
  /** HTTP status behind a failure, when there was one. */
  status?: number;
  /** The URL that was asked, so a failure can be diagnosed. Never contains a key. */
  endpoint?: string;
}

export interface ProbeResult {
  ok: boolean;
  /** What the model actually said, trimmed. Empty on failure. */
  reply?: string;
  model?: string;
  reason?: string;
  /** Round-trip time, because a working-but-slow agent is worth knowing about. */
  latency_ms?: number;
}

/** Default budget for a discovery call. Short: this is a UI action, not a turn. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

/** Default budget for a probe completion. Longer: a cold model can be slow to start. */
export const PROBE_TIMEOUT_MS = 30_000;

/** Ceiling on models kept from one response. A catalog is not a denial-of-service vector. */
const MAX_MODELS = 200;

/**
 * Response shape, validated rather than trusted.
 *
 * Three shapes occur in the wild: OpenAI's `{data:[{id}]}`, Ollama's `{models:[{name}]}`,
 * and a bare array from simpler gateways. All three are accepted, because refusing the
 * ones that are merely different would report a working endpoint as broken — and the
 * user cannot tell that apart from a real failure.
 */
const OpenAiModelSchema = z.object({
  id: z.string().max(200).optional(),
  // Ollama and some gateways use `name` where OpenAI uses `id`.
  name: z.string().max(200).optional(),
  owned_by: z.string().max(120).optional(),
  context_length: z.number().int().positive().optional(),
});

const ModelsResponseSchema = z.union([
  z.object({ data: z.array(OpenAiModelSchema).max(MAX_MODELS) }),
  z.object({ models: z.array(OpenAiModelSchema).max(MAX_MODELS) }),
  z.array(OpenAiModelSchema).max(MAX_MODELS),
]);

/**
 * `GET {base}/models`.
 *
 * Returns `{ok:false, reason}` rather than throwing, because this is called from a UI
 * action where "could not list models" is an ordinary outcome to display, not an
 * exception to catch at every call site.
 */
export async function discoverModels(
  config: AgentEndpointConfig,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const validation = validateBaseUrl(config.base_url);
  if (!validation.ok) return { ok: false, models: [], reason: validation.reason };

  const endpoint = modelsUrl(config.base_url);
  const timeoutMs = positiveOr(config.timeout_ms, DISCOVERY_TIMEOUT_MS);
  const doFetch = config.fetch_impl ?? defaultFetch;

  const response = await request(
    doFetch,
    endpoint,
    { method: 'GET', headers: authHeaders(config.api_key, { Accept: 'application/json' }) },
    timeoutMs,
    signal,
  );
  if (!response.ok) {
    // 404 and 405 on this specific path mean the endpoint does not implement /models,
    // which is common and says nothing about the base URL or the key. Reporting it as a
    // generic HTTP failure would send somebody debugging a configuration that is fine.
    if (response.status === 404 || response.status === 405) {
      return {
        ok: false,
        models: [],
        endpoint,
        status: response.status,
        reason:
          `${endpoint} does not implement a model list (HTTP ${response.status}). ` +
          'That is common, and not a failure of the base URL or key — type the model id by hand instead.',
      };
    }
    return { ok: false, models: [], reason: response.reason, endpoint, status: response.status };
  }
  if (response.value === undefined) return { ok: false, models: [], reason: 'No response.', endpoint };

  const parsed = ModelsResponseSchema.safeParse(response.value);
  if (!parsed.success) {
    // Honest about what happened: the endpoint answered, but not with a model list.
    // Many servers simply do not implement /models, and that is not a broken agent —
    // it means the model id has to be typed by hand.
    return {
      ok: false,
      models: [],
      endpoint,
      reason:
        `${endpoint} did not return a model list, so this endpoint may not implement /models. ` +
        'That is common, and not a failure of the base URL or key — type the model id by hand instead.',
    };
  }

  const rows = Array.isArray(parsed.data)
    ? parsed.data
    : 'data' in parsed.data
      ? parsed.data.data
      : parsed.data.models;

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = (row.id ?? row.name ?? '').trim();
    // A row with no id is dropped individually: one malformed entry must not cost the
    // user every other model the endpoint offered.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: row.owned_by && row.owned_by !== id ? `${id} · ${row.owned_by}` : id,
      provider: row.owned_by ?? undefined,
      context_window: row.context_length ?? null,
    });
    if (models.length >= MAX_MODELS) break;
  }

  if (models.length === 0) {
    return {
      ok: false,
      models: [],
      endpoint,
      reason: `${endpoint} returned an empty model list. The endpoint answered, so the base URL is reachable — it simply advertised no models.`,
    };
  }
  return { ok: true, models, endpoint };
}

/**
 * Sends one minimal completion and reports whether a real answer came back.
 *
 * This spends a real request on the user's account, which is why it is a separate,
 * explicitly-invoked action rather than something discovery does automatically. The
 * prompt is deliberately trivial and `max_tokens` deliberately small: the goal is to
 * prove the path works, not to ask the model anything worth asking.
 */
export async function probeAgent(
  config: AgentEndpointConfig,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const validation = validateBaseUrl(config.base_url);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const model = config.model?.trim();
  if (!model) {
    return {
      ok: false,
      reason: 'Choose a model before testing — there is nothing to send the request to yet.',
    };
  }

  const endpoint = completionsUrlFrom(config.base_url);
  const timeoutMs = positiveOr(config.timeout_ms, PROBE_TIMEOUT_MS);
  const doFetch = config.fetch_impl ?? defaultFetch;

  const body = {
    model,
    stream: false,
    max_tokens: 8,
    temperature: 0,
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
  };

  const started = Date.now();
  const response = await request(
    doFetch,
    endpoint,
    {
      method: 'POST',
      headers: authHeaders(config.api_key, {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }),
      body: JSON.stringify(body),
    },
    timeoutMs,
    signal,
  );
  const latency = Date.now() - started;

  if (!response.ok) return { ok: false, reason: response.reason, model, latency_ms: latency };
  if (response.value === undefined) return { ok: false, reason: 'No response.', model, latency_ms: latency };

  const text = extractProbeText(response.value);
  if (!text.trim()) {
    // A 200 with no content is worth calling out specifically: it usually means the
    // model id was accepted but produced nothing, which reads as success otherwise.
    return {
      ok: false,
      model,
      latency_ms: latency,
      reason: `The endpoint answered HTTP 200 but returned no text for model "${model}". The model id may be wrong, or the endpoint may return a shape Ideno does not read.`,
    };
  }
  return { ok: true, reply: text.trim().slice(0, 200), model, latency_ms: latency };
}

/**
 * `GET`/`POST` with a timeout and an abort signal, folded into one place.
 *
 * Returns a discriminated result instead of throwing so that both callers can report a
 * failure as data. Every reason string here is built without the key.
 */
async function request(
  doFetch: DiscoveryFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response: DiscoveryResponse;
  try {
    response = await doFetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) return { ok: false, reason: 'The request was cancelled.' };
    if (controller.signal.aborted) {
      return { ok: false, reason: `The endpoint did not respond within ${timeoutMs} ms.` };
    }
    return {
      ok: false,
      reason: `The endpoint at ${originOf(url)} could not be reached (${describe(error)}). ` +
        'Check the base URL, and whether the server is running and reachable from this browser.',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const detail = await safeBodyText(response);
    return { ok: false, reason: statusReason(response.status, url, detail), status: response.status };
  }
  try {
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, reason: `The endpoint replied with invalid JSON (${describe(error)}).` };
  }
}

/** Status codes an agent setup actually hits, each with the fix that applies. */
export function statusReason(status: number, url: string, detail: string): string {
  const where = originOf(url);
  const suffix = detail ? ` The endpoint said: ${detail}` : '';
  switch (status) {
    case 401:
    case 403:
      return `${where} rejected the credentials (HTTP ${status}). ` +
        'If this agent needs a key, check it; if it does not, the server may require one anyway.' + suffix;
    case 404:
      return `${where} returned HTTP 404. The base URL is reachable but this path does not exist — ` +
        'check whether it needs a trailing `/v1`.' + suffix;
    case 405:
      return `${where} does not allow that method (HTTP 405). The base URL probably points at the wrong path.` + suffix;
    case 422:
      return `${where} could not process the request (HTTP 422). The model id may not exist on that endpoint.` + suffix;
    case 429:
      return `${where} rate-limited the request (HTTP 429). Wait a moment and try again.` + suffix;
    default:
      return status >= 500
        ? `${where} returned HTTP ${status}. The server side failed; nothing was wrong with this configuration.` + suffix
        : `${where} returned HTTP ${status}.` + suffix;
  }
}

/** Normalises `.../v1`, `.../v1/` and `.../v1/chat/completions` into `.../v1/models`. */
export function modelsUrl(baseUrl: string): string {
  return `${stripToRoot(baseUrl)}/models`;
}

/** Same normalisation, for the completions path. */
export function completionsUrlFrom(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return `${stripToRoot(baseUrl)}/chat/completions`;
}

/** Removes a trailing `/chat/completions` or slashes, leaving the versioned root. */
function stripToRoot(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
}

/** The origin only, so a reason never carries a path with a key embedded in it. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the endpoint';
  }
}

function authHeaders(apiKey: string | null | undefined, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  // Only sent when there is one. An empty `Authorization: Bearer ` header is rejected by
  // some servers that would happily serve an unauthenticated local request.
  const key = apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Reads completion text from the shapes OpenAI-compatible servers actually return. */
export function extractProbeText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // Some gateways answer with a bare `text` or `output` field.
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.output === 'string') return record.output;
    return '';
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) {
    const text = (first as Record<string, unknown>).text;
    return typeof text === 'string' ? text : '';
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : '',
      )
      .join('');
  }
  return '';
}

async function safeBodyText(response: DiscoveryResponse): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch {
    return '';
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function defaultFetch(url: string, init: Parameters<DiscoveryFetch>[1]): Promise<DiscoveryResponse> {
  return fetch(url, init as RequestInit) as unknown as Promise<DiscoveryResponse>;
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
