/**
 * JSON extraction from model output.
 *
 * Not every provider Ideno can talk to implements a native JSON mode — Puter's
 * documented `chat()` options, for instance, do not include `response_format`.
 * So structured output cannot depend on the provider behaving perfectly: models
 * wrap JSON in prose, in code fences, or add a trailing comma.
 *
 * This module turns "text that probably contains one JSON value" into that
 * value, or reports precisely why it could not. It never guesses at content —
 * if parsing fails, nothing is invented; the caller decides what to do.
 */

export type JsonExtractionStrategy = 'direct' | 'fenced' | 'balanced' | 'repaired' | 'none';

export interface JsonExtraction {
  /** Parsed value when `strategy !== 'none'`. */
  json: unknown;
  strategy: JsonExtractionStrategy;
  /** Present when extraction failed. Includes a short excerpt for diagnosis. */
  error?: string;
}

const MAX_CANDIDATES = 8;
const EXCERPT_LENGTH = 240;

export function extractJson(text: string): JsonExtraction {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { json: null, strategy: 'none', error: 'The model returned an empty response.' };
  }

  // 1. The whole response is already JSON.
  const direct = tryParse(trimmed);
  if (direct.ok) return { json: direct.value, strategy: 'direct' };

  // 2. JSON inside one or more code fences.
  for (const block of fencedBlocks(trimmed)) {
    const parsed = tryParse(block);
    if (parsed.ok) return { json: parsed.value, strategy: 'fenced' };
    const repaired = tryParse(stripTrailingCommas(block));
    if (repaired.ok) return { json: repaired.value, strategy: 'repaired' };
  }

  // 3. Balanced JSON value(s) embedded in prose. Prefer the largest, since a
  //    stray "{...}" inside an explanatory sentence is usually not the payload.
  const candidates = balancedCandidates(trimmed).slice(0, MAX_CANDIDATES);
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed.ok) return { json: parsed.value, strategy: 'balanced' };
  }
  for (const candidate of candidates) {
    const repaired = tryParse(stripTrailingCommas(candidate));
    if (repaired.ok) return { json: repaired.value, strategy: 'repaired' };
  }

  return {
    json: null,
    strategy: 'none',
    error: `No parseable JSON object found in the model response. Excerpt: ${excerpt(trimmed)}`,
  };
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH)}…`;
}

type ParseResult = { ok: true; value: unknown } | { ok: false };

function tryParse(candidate: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

/** Contents of every ``` fence, in document order. */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[^\n]*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body) blocks.push(body);
    if (match.index === fence.lastIndex) fence.lastIndex += 1; // guard zero-length
  }
  // An unterminated fence is common when a response is truncated.
  if (blocks.length === 0) {
    const open = text.indexOf('```');
    if (open !== -1) {
      const body = text.slice(open + 3).replace(/^[^\n]*\n/, '').trim();
      if (body) blocks.push(body);
    }
  }
  return blocks;
}

const MAX_SCAN_RESULTS = 32;

/**
 * Scans for balanced `{...}` / `[...]` spans, correctly skipping brackets that
 * appear inside JSON strings.
 *
 * A stray bracket in prose can swallow the real payload — `Note {important and
 * then {"a":1}` balances from the *first* brace — so nested spans are scanned
 * too. `extractJson` tries every candidate and keeps the first that parses.
 */
export function balancedCandidates(text: string): string[] {
  const results: string[] = [];
  const queue: [number, number][] = [[0, text.length]];

  while (queue.length > 0 && results.length < MAX_SCAN_RESULTS) {
    const [from, to] = queue.shift() as [number, number];
    for (let i = from; i < to; i += 1) {
      const ch = text[i];
      if (ch !== '{' && ch !== '[') continue;
      const end = findBalancedEnd(text, i, to);
      if (end === -1) continue;
      results.push(text.slice(i, end + 1));
      if (results.length >= MAX_SCAN_RESULTS) break;
      queue.push([i + 1, end]);
      i = end;
    }
  }

  return results;
}

/**
 * Index of the bracket that closes the value starting at `start`, or -1 when it
 * never closes within `limit`. Both bracket kinds are tracked, because an array
 * inside an object (and vice versa) has to nest correctly.
 */
function findBalancedEnd(text: string, start: number, limit: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < limit; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Partial JSON, for showing a response that is still arriving
// ---------------------------------------------------------------------------

export interface PartialJson {
  /** The best value obtainable from the text so far, or null when there is none. */
  value: unknown;
  /** True only when the text was already a complete JSON document. */
  complete: boolean;
}

/**
 * How many characters are trimmed, one at a time, while trying to close an
 * incomplete document. Bounded so a long response cannot turn a preview into a
 * quadratic scan on every progress tick.
 */
const MAX_PARTIAL_TRIMS = 24;

/**
 * Parses JSON that has not finished arriving.
 *
 * This exists for exactly one purpose: telling the user what a model is *forming*
 * while they wait. It is never used to decide anything. `complete: false` means the
 * value is a guess at a prefix, and the caller must treat it as decoration — the
 * runtime still waits for the whole response and validates it before anything
 * touches the Idea State.
 *
 * Method: find what is still open (strings, brackets), close it, and if that does
 * not parse, trim a character at a time from the end until it does or the budget
 * runs out. Trimming from the end is what discards a half-written token, which is
 * the usual reason a prefix will not parse.
 */
export function parsePartialJson(text: string): PartialJson {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { value: null, complete: false };

  const whole = tryParse(trimmed);
  if (whole.ok) return { value: whole.value, complete: true };

  // A prefix of a fenced block is common enough to be worth unwrapping: models
  // often emit ```json first and the document after it.
  const withoutFence = trimmed.replace(/^```[a-zA-Z0-9]*\s*/, '');

  let body = withoutFence;
  let scan = scanOpen(body);
  if (scan.inString) body += '"';

  for (let attempt = 0; attempt <= MAX_PARTIAL_TRIMS; attempt += 1) {
    const candidate = closeDocument(body, scanOpen(body).stack);
    const parsed = tryParse(candidate);
    if (parsed.ok) return { value: parsed.value, complete: false };
    // Drop one character and try again: this is what removes a dangling `"key":`,
    // a stray comma or the first half of a `true`.
    body = body.slice(0, Math.max(0, body.length - 1));
    scan = scanOpen(body);
    if (body.length === 0) break;
  }

  return { value: null, complete: false };
}

/** Tracks which brackets are open and whether the cursor is inside a string. */
function scanOpen(text: string): { stack: string[]; inString: boolean } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack, inString };
}

/** Closes whatever is open, after discarding a trailing fragment. */
function closeDocument(body: string, stack: string[]): string {
  let out = body.replace(/\s+$/, '');
  // A key whose value has not started: `{"a":1,"b":` → `{"a":1`
  out = out.replace(/"[^"\\]*(?:\\.[^"\\]*)*"\s*:$/, '');
  out = out.replace(/,$/, '');
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    out += stack[index] === '{' ? '}' : ']';
  }
  return out;
}

/**
 * Removes trailing commas before `}` / `]` outside of strings — the single most
 * common way a model produces almost-valid JSON.
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const next = text[j];
      if (next === '}' || next === ']') continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}
