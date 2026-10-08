/**
 * A keyed async mutex.
 *
 * Idea cases are read-modify-written on every turn. Without serialisation two
 * concurrent requests for the same case would both read version N and both
 * write version N+1, silently losing one of them. Locking per case id keeps
 * unrelated cases fully concurrent.
 */
interface Entry {
  /** Resolves when the most recently queued task for this key settles. */
  tail: Promise<void>;
  /** Tasks queued but not yet settled. The entry is dropped when this hits 0. */
  waiting: number;
}

export class KeyedMutex {
  readonly #entries = new Map<string, Entry>();

  /** Runs `task` with exclusive access to `key`. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const entry: Entry = this.#entries.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
    entry.waiting += 1;
    this.#entries.set(key, entry);

    const predecessor = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A failed predecessor must not poison the queue for later callers.
    await predecessor;

    try {
      return await task();
    } finally {
      release();
      entry.waiting -= 1;
      if (entry.waiting === 0 && this.#entries.get(key) === entry) {
        this.#entries.delete(key);
      }
    }
  }

  /** Number of keys with at least one queued task. Exposed for diagnostics. */
  get activeKeys(): number {
    return this.#entries.size;
  }
}
