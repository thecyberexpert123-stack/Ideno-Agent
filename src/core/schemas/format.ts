/**
 * Shared formatting for zod validation failures.
 *
 * Every layer that validates untrusted data — persisted workspaces, model
 * output, user input — reports failures the same way, so an error message means
 * the same thing wherever the user sees it.
 */
import type { ZodError } from 'zod';

/**
 * Renders validation issues as `path: message` strings.
 *
 * Paths are `PropertyKey[]` in zod 4 (a symbol is possible in principle), so
 * they are stringified rather than assumed to be strings or numbers.
 */
export function formatZodIssues(error: ZodError, limit = 6): string[] {
  return error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join('.');
    return `${path.length > 0 ? path : '(root)'}: ${issue.message}`;
  });
}

/** Single-line version, for messages that must not contain newlines. */
export function formatZodIssuesInline(error: ZodError, limit = 4): string {
  return formatZodIssues(error, limit).join('; ') || 'unknown validation problem';
}
