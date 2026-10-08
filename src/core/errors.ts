/**
 * Typed error taxonomy.
 *
 * Every failure Ideno can produce maps onto one of these codes, so the HTTP
 * layer can translate consistently and the UI can react to a code rather than
 * to a message string.
 */
export type IdenoErrorCode =
  /* Client / request problems */
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  /* AI runtime problems */
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_auth_failed'
  | 'model_unavailable'
  | 'malformed_model_output'
  | 'empty_model_output'
  /* Research problems */
  | 'research_failed'
  /* Catch-all */
  | 'internal_error';

const HTTP_STATUS: Record<IdenoErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  provider_not_configured: 503,
  provider_unavailable: 503,
  provider_timeout: 504,
  provider_rate_limited: 429,
  provider_auth_failed: 502,
  model_unavailable: 503,
  malformed_model_output: 502,
  empty_model_output: 502,
  research_failed: 502,
  internal_error: 500,
};

export interface IdenoErrorOptions {
  /** Structured detail safe to show the user. Never include credentials. */
  readonly details?: unknown;
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class IdenoError extends Error {
  readonly code: IdenoErrorCode;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(code: IdenoErrorCode, message: string, options: IdenoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IdenoError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toJSON(): { error: { code: IdenoErrorCode; message: string; retryable: boolean; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

const DEFAULT_RETRYABLE = new Set<IdenoErrorCode>([
  'provider_unavailable',
  'provider_timeout',
  'provider_rate_limited',
  'model_unavailable',
  'malformed_model_output',
  'empty_model_output',
  'research_failed',
]);

export function isIdenoError(value: unknown): value is IdenoError {
  return value instanceof IdenoError;
}

/** Normalises any thrown value into an IdenoError without losing the cause. */
export function toIdenoError(value: unknown, fallbackMessage = 'Unexpected error'): IdenoError {
  if (isIdenoError(value)) return value;
  const message = value instanceof Error ? value.message : fallbackMessage;
  return new IdenoError('internal_error', message, { cause: value });
}
