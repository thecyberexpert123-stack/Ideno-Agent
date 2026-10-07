/**
 * Typed failures for the AI layer.
 *
 * Every way a provider can let us down is named here, because the orchestrator
 * has to react differently to each: a malformed response is retryable with
 * feedback, an unavailable provider is not, and a timeout should never leave the
 * Idea State half-modified.
 */

export const AIErrorCodeSchema = [
  'provider_unavailable',
  'auth_required',
  'model_unavailable',
  'rate_limited',
  'timeout',
  'network',
  'empty_response',
  'malformed_response',
  'unsupported_operation',
  'aborted',
  'unknown',
] as const;

export type AIErrorCode = (typeof AIErrorCodeSchema)[number];

/** What the user can actually do about each failure. */
export const AI_ERROR_HINTS: Record<AIErrorCode, string> = {
  provider_unavailable:
    'The AI provider could not be reached. Check the connection, or switch provider in Settings.',
  auth_required: 'Sign in to the provider, or check the API key in Settings.',
  model_unavailable: 'That model is not available on this provider. Pick another model in Settings.',
  rate_limited: 'The provider is rate limiting requests. Wait a moment and try again.',
  timeout: 'The model took too long to answer. Try again, or raise the timeout in Settings.',
  network: 'A network request failed. Check the connection and try again.',
  empty_response: 'The model returned an empty response. Try again.',
  malformed_response:
    'The model returned data Ideno could not validate. Nothing was changed; try again.',
  unsupported_operation: 'The selected provider cannot perform that operation.',
  aborted: 'The request was cancelled.',
  unknown: 'Something went wrong in the AI layer.',
};

/** Whether retrying the same request could plausibly succeed. */
export const RETRYABLE_AI_ERRORS: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'timeout',
  'network',
  'rate_limited',
  'empty_response',
  'malformed_response',
]);

export interface AIErrorDetails {
  /** Provider-reported status code, when there was one. */
  status?: number;
  /** Provider or model identifier involved. */
  model?: string;
  provider?: string;
  /** Validation issues for `malformed_response`. */
  issues?: readonly string[];
  /** Truncated raw response, for diagnosis. Never rendered as HTML. */
  raw_excerpt?: string;
  /**
   * Full raw response text when a structured call failed validation, so the UI
   * can still show the human what the model actually said instead of nothing.
   */
  raw_text?: string;
  cause?: unknown;
}

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly details: AIErrorDetails;
  /** True when the failure happened after a request was already in flight. */
  readonly retryable: boolean;

  constructor(code: AIErrorCode, message: string, details: AIErrorDetails = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.details = details;
    this.retryable = RETRYABLE_AI_ERRORS.has(code);
  }

  get hint(): string {
    return AI_ERROR_HINTS[this.code];
  }

  /** Stable, user-presentable description. Safe to render as text. */
  describe(): string {
    const parts = [this.message, this.hint];
    if (this.details.issues && this.details.issues.length > 0) {
      parts.push(`Validation: ${this.details.issues.slice(0, 4).join('; ')}`);
    }
    return parts.filter(Boolean).join(' ');
  }
}

export function isAIError(error: unknown): error is AIError {
  return error instanceof AIError;
}

/**
 * Maps an arbitrary thrown value onto an AIError. Providers reject with
 * inconsistent shapes (strings, `{status, message}`, `Error`), so this is the
 * single place that normalises them.
 */
export function toAIError(error: unknown, context: { provider?: string; model?: string } = {}): AIError {
  if (isAIError(error)) return error;

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AIError('aborted', 'The request was cancelled.', context);
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new AIError('timeout', 'The model timed out.', context);
  }

  const status = readStatus(error);
  const message = readMessage(error) ?? 'The AI request failed.';

  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return new AIError('auth_required', message, { ...context, status, cause: error });
    }
    if (status === 404) {
      return new AIError('model_unavailable', message, { ...context, status, cause: error });
    }
    if (status === 429) {
      return new AIError('rate_limited', message, { ...context, status, cause: error });
    }
    if (status >= 500) {
      return new AIError('provider_unavailable', message, { ...context, status, cause: error });
    }
  }

  if (error instanceof TypeError && /fetch|network/i.test(message)) {
    return new AIError('network', message, { ...context, cause: error });
  }

  return new AIError('unknown', message, { ...context, cause: error });
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = (error as { status?: unknown }).status;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

function readMessage(error: unknown): string | undefined {
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { message?: unknown; error?: { message?: unknown } };
  if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message.trim();
  if (typeof candidate.error?.message === 'string' && candidate.error.message.trim()) {
    return candidate.error.message.trim();
  }
  return undefined;
}
