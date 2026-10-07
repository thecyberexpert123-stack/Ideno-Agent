/**
 * Errors raised by Ideno Core.
 *
 * Distinct from `AIError`: these are never about a model or a network, they are
 * about the integrity of the Idea State or the environment it lives in. Keeping
 * them separate means the UI can say "the model failed, your idea is intact"
 * versus "your idea could not be saved" — two very different messages.
 */

export const STATE_ERROR_CODES = [
  'no_session',
  'session_changed',
  'unknown_change',
  'unknown_version',
  'invalid_state',
  'capacity',
] as const;

export type StateErrorCode = (typeof STATE_ERROR_CODES)[number];

export class IdenoStateError extends Error {
  readonly code: StateErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: StateErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IdenoStateError';
    this.code = code;
    this.details = details;
  }
}

export function isIdenoStateError(error: unknown): error is IdenoStateError {
  return error instanceof IdenoStateError;
}
