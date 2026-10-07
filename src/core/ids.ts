/**
 * Identifier and timestamp minting.
 *
 * Only Core mints ids. Models reference existing ids (supplied to them in the
 * context digest) but can never create or overwrite one, which is what makes a
 * hallucinated or duplicated id structurally impossible to apply.
 */

/**
 * Returns an ISO-8601 timestamp. Injectable so tests can build deterministic
 * version histories.
 */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

/**
 * Creates a prefixed identifier.
 *
 * Uses `crypto.randomUUID()` where available. The fallback is *not*
 * cryptographically strong; that is acceptable because ids are correlation
 * handles inside one workspace, never secrets or authorisation tokens.
 */
export function newId(prefix: string, random: Pick<Crypto, 'randomUUID'> = globalThis.crypto): string {
  const uuid = typeof random?.randomUUID === 'function' ? random.randomUUID() : null;
  if (uuid) return `${prefix}_${uuid}`;
  const time = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}${noise}`;
}

/**
 * Deterministic clock for tests: yields `start`, then advances by `stepMs` on
 * every call.
 */
export function fixedClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let current = Date.parse(start);
  if (Number.isNaN(current)) throw new Error(`fixedClock: invalid start timestamp "${start}"`);
  return () => {
    const iso = new Date(current).toISOString();
    current += stepMs;
    return iso;
  };
}
