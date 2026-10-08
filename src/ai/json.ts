/**
 * Recovering JSON from model output.
 *
 * Even with structured-output modes enabled, models wrap JSON in prose or
 * fenced code blocks often enough that failing the turn would be the wrong
 * behaviour. These helpers recover the JSON when it is recoverable and fail
 * loudly when it is not — they never guess at missing content.
 */

const FENCE = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/u;

/** Strips a single surrounding markdown code fence, if present. */
export function stripCodeFence(text: string): string {
  const match = FENCE.exec(text);
  return match?.[1] ?? text;
}

/**
 * Returns the first balanced JSON object or array in `text`.
 *
 * Scans character by character tracking string and escape state so that
 * braces inside string literals do not terminate the scan early.
 */
export function extractFirstJsonValue(text: string): string | null {
  const openers = new Set(['{', '[']);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let closer = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (start === -1) {
      if (openers.has(char)) {
        start = index;
        depth = 1;
        closer = char === '{' ? '}' : ']';
      }
      continue;
    }

    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        return candidate.endsWith(closer) ? candidate : null;
      }
    }
  }

  return null;
}

export interface JsonParseSuccess {
  readonly ok: true;
  readonly value: unknown;
  /** True when the raw text was not already clean JSON. */
  readonly recovered: boolean;
}

export interface JsonParseFailure {
  readonly ok: false;
  readonly reason: string;
}

export type JsonParseOutcome = JsonParseSuccess | JsonParseFailure;

/**
 * Parses model output as JSON, tolerating code fences and surrounding prose.
 *
 * Deliberately conservative: no quote fixing, no trailing-comma repair, no
 * key inference. If the payload is not valid JSON once fences and prose are
 * removed, it is reported as malformed so the caller can retry or degrade.
 */
export function parseModelJson(raw: string): JsonParseOutcome {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: 'the model returned an empty response' };

  const attempts: { source: string; recovered: boolean }[] = [{ source: text, recovered: false }];

  const unfenced = stripCodeFence(text).trim();
  if (unfenced !== text && unfenced.length > 0) {
    attempts.push({ source: unfenced, recovered: true });
  }

  const extracted = extractFirstJsonValue(unfenced);
  if (extracted && extracted !== unfenced) {
    attempts.push({ source: extracted, recovered: true });
  }

  let lastError = 'the response was not valid JSON';
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt.source), recovered: attempt.recovered };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, reason: lastError };
}
