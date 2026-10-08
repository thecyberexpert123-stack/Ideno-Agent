import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Short, human-readable, collection-prefixed identifiers.
 *
 * Idea State item ids are embedded in prompts and shown in the UI, so they are
 * kept short and typed (`req-3f9a21c4`) rather than full UUIDs. Case ids stay
 * full UUIDs because they are used as filesystem names and must be globally
 * unique without coordination.
 */
export const ID_PREFIXES = {
  requirement: 'req',
  assumption: 'asm',
  constraint: 'con',
  unknown: 'unk',
  evidence: 'evd',
  research_item: 'rsh',
  alternative: 'alt',
  decision: 'dec',
  rejected_approach: 'rej',
  open_question: 'que',
  relation: 'rel',
  changeset: 'cs',
  operation: 'op',
  version: 'ver',
  turn: 'trn',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/** Generates `<prefix>-<8 lowercase hex chars>`. ~4.3e9 values per prefix. */
export function shortId(prefix: IdPrefix): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/**
 * Generates a short id that is not present in `taken`.
 *
 * Collisions are astronomically unlikely but not impossible, and a silent
 * collision would overwrite a real Idea State item, so uniqueness is enforced
 * rather than assumed.
 */
export function uniqueShortId(prefix: IdPrefix, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = shortId(prefix);
    if (!taken.has(candidate)) return candidate;
  }
  /* c8 ignore next 2 -- unreachable without a broken CSPRNG */
  throw new Error(`Unable to allocate a unique id for prefix "${prefix}" after 1000 attempts`);
}

export function newCaseId(): string {
  return randomUUID();
}

/** True when `value` is a syntactically valid case id (a v4 UUID). */
export function isCaseId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
