/**
 * Persistence for the workspace.
 *
 * The Idea State is the product's memory, so it has to survive a reload. It is
 * also the only thing worth saving: the transcript is stored alongside it, but
 * the state never depends on the transcript to be complete.
 *
 * `localStorage` is probed rather than assumed — Safari in private mode and some
 * embedded browsers throw on `setItem`, and Ideno must still work (in memory,
 * with the user told why) when that happens.
 *
 * ## Layout
 *
 * A workspace is an *index* plus one record per idea:
 *
 *   ideno.workspace.index.v2       which ideas exist, which one is open
 *   ideno.session.v2.<session_id>  one idea, loaded only when opened
 *   ideno.workspace.v1             legacy v0.1 blob, migrated on first load
 *
 * v0.1 stored everything in one blob. That is the reason for this file's shape:
 * measured on the v0.1 code, a session of ~170 user edits produced a 6.5 MB blob,
 * which exceeds the roughly 5 MB an origin gets, so from that point on *nothing*
 * could be saved — and because the same blob held the only copy of the idea, the
 * whole workspace was lost on reload. Splitting the record per idea means saving
 * one idea never depends on the size of the others, and a quota failure can be
 * recovered from by pruning the oldest snapshots of *that* idea.
 */

/**
 * Where a store keeps its data.
 *
 * `desktop_file` is the Python host: JSON documents under the user's XDG data
 * directory, written atomically. It is a distinct kind rather than a flavour of
 * `memory` because the answer to "will this survive?" differs, and the UI says so.
 */
export type StoreKind = 'memory' | 'local_storage' | 'desktop_file';

export interface Store {
  readonly kind: StoreKind;
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  #data = new Map<string, string>();

  read(key: string): string | null {
    return this.#data.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.#data.set(key, value);
  }

  remove(key: string): void {
    this.#data.delete(key);
  }
}

export class LocalStorageStore implements Store {
  readonly kind = 'local_storage' as const;
  #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  read(key: string): string | null {
    return this.#storage.getItem(key);
  }

  write(key: string, value: string): void {
    this.#storage.setItem(key, value);
  }

  remove(key: string): void {
    this.#storage.removeItem(key);
  }
}

export interface StoreSelection {
  store: Store;
  persistent: boolean;
  /** Present when persistence was requested but could not be provided. */
  reason?: string;
}

const PROBE_KEY = 'ideno.storage.probe';

export function createDefaultStore(storage?: Storage | null): StoreSelection {
  const candidate = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!candidate) {
    return { store: new MemoryStore(), persistent: false, reason: 'This environment has no localStorage.' };
  }
  try {
    candidate.setItem(PROBE_KEY, '1');
    const readBack = candidate.getItem(PROBE_KEY);
    candidate.removeItem(PROBE_KEY);
    if (readBack !== '1') throw new Error('written value could not be read back');
    return { store: new LocalStorageStore(candidate), persistent: true };
  } catch (error) {
    return {
      store: new MemoryStore(),
      persistent: false,
      reason: `Browser storage is unavailable (${messageOf(error)}). This session will be lost on reload.`,
    };
  }
}

/**
 * True when a write failed because the store is full rather than because it is
 * broken. The distinction matters: a quota error is *recoverable* by making the
 * payload smaller, so Ideno prunes old snapshots and retries; any other write
 * error is not, so it warns and moves on.
 *
 * Browsers are inconsistent here — `QuotaExceededError` is the DOMException name
 * in Chrome and Firefox, Safari has used `NS_ERROR_DOM_QUOTA_REACHED`, and some
 * embedders throw a plain `Error` whose message mentions the quota — so name, code
 * and message are all checked.
 */
export function isQuotaError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (typeof candidate?.code === 'number' && candidate.code === 1014) return true; // Firefox
  const message = messageOf(error).toLowerCase();
  return message.includes('quota') || message.includes('exceeded the storage') || message.includes('out of memory');
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
