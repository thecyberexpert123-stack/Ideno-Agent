import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { IdenoError, toIdenoError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

/** Parses a request body against a schema, raising a 422 with the issues. */
export function parseBody<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  body: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new IdenoError('validation_failed', 'The request body is not valid.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data as z.infer<TSchema>;
}

/** Express error handler translating the Ideno error taxonomy to HTTP. */
export function errorHandler(logger: Logger) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const normalized = toIdenoError(error);
    const level = normalized.httpStatus >= 500 ? 'error' : 'warn';
    logger.log(level, 'request failed', {
      code: normalized.code,
      status: normalized.httpStatus,
      message: normalized.message,
    });
    response.status(normalized.httpStatus).json(normalized.toJSON());
  };
}

export function notFoundHandler(_request: Request, response: Response): void {
  response
    .status(404)
    .json(new IdenoError('not_found', 'No such endpoint.').toJSON());
}

/**
 * Minimal security headers.
 *
 * Frame-blocking headers are deliberately NOT set: Ideno is commonly run
 * inside a preview iframe during development, and `X-Frame-Options: DENY`
 * would break that with no security benefit for a localhost-first,
 * unauthenticated prototype. Add framing restrictions when authentication is
 * introduced.
 */
export function securityHeaders(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  next();
}
