/**
 * The desktop host bridge.
 *
 * When Ideno runs inside the Python desktop application (`desktop/ideno_desktop`),
 * a small API is injected into the page as `window.pywebview.api`. It reads and
 * writes named JSON documents in the user's XDG data directory — real files, with
 * atomic writes, no size ceiling worth designing around.
 *
 * This module is the *only* place in the codebase that knows the bridge exists. It
 * produces something that satisfies the same `Store` interface as `MemoryStore` and
 * `LocalStorageStore`, so nothing above it — the State Manager, the settings store,
 * the UI — has a second persistence path to reason about.
 *
 * ## Why the store stays synchronous
 *
 * `Store.read` is synchronous because the State Manager reads storage in places
 * that cannot be made asynchronous without rewriting most of the core, and because
 * a synchronous read has no interleaving to reason about. The bridge is not.
 *
 * The reconciliation is that the desktop host is read exactly once, at boot, with
 * `snapshot()`: everything is loaded into memory before the first read, so every
 * later read is a cache hit. Writes update the cache immediately and are mirrored to
 * Python over a promise chain, which preserves ordering without blocking.
 *
 * The consequence to be honest about: if the process is killed inside the mirroring
 * window, the last writes are lost. `whenSettled()` is awaited on `pagehide` and on
 * teardown, which closes that window for every normal exit. On the desktop the
 * window is milliseconds rather than the seconds a `localStorage` quota recovery
 * can take, and there is no quota to hit at all.
 */
import { isQuotaError, messageOf, type Store, type StoreKind } from '../core/state_manager/store.js';

/** Protocol version this build of the UI speaks. The host reports its own. */
export const DESKTOP_PROTOCOL_VERSION = 1;

export type BridgeResult =
  | { ok: true; value?: string | null; keys?: string[]; values?: Record<string, string>; protocol?: number; version?: string; kind?: string; data_dir?: string; workspace_dir?: string; python?: string; platform?: string; failures?: string[] }
  | { ok: false; error: string; kind?: string };

/** The injected API. Every method resolves; none of them throws. */
export interface DesktopApi {
  info(): Promise<BridgeResult>;
  snapshot(): Promise<BridgeResult>;
  read(key: string): Promise<BridgeResult>;
  write(key: string, value: string): Promise<BridgeResult>;
  remove(key: string): Promise<BridgeResult>;
  list(): Promise<BridgeResult>;
}

export interface DesktopHost {
  readonly api: DesktopApi;
  readonly version: string;
  readonly protocol: number;
  readonly dataDir: string | null;
  readonly workspaceDir: string | null;
  readonly python: string | null;
  readonly platform: string | null;
}

export type DesktopConnection =
  | { connected: true; host: DesktopHost }
  | { connected: false; reason: string };

interface PywebviewWindow {
  pywebview?: { api?: Partial<DesktopApi> };
}

const REQUIRED_METHODS = ['info', 'snapshot', 'read', 'write', 'remove', 'list'] as const;

/**
 * Waits for the host to inject its API, then verifies the contract.
 *
 * Verification is not ceremony: a host from a different version of Ideno, or a page
 * that happens to define `window.pywebview` for its own reasons, would otherwise
 * produce failures much later and much further from their cause.
 */
export async function connectDesktopHost(timeoutMs = 3000): Promise<DesktopConnection> {
  const api = await waitForApi(timeoutMs);
  if (!api) {
    return { connected: false, reason: 'No desktop host was detected; this is a browser session.' };
  }

  const missing = REQUIRED_METHODS.filter((method) => typeof api[method] !== 'function');
  if (missing.length > 0) {
    return {
      connected: false,
      reason: `The desktop host does not provide \`${missing.join('`, `')}\`, so it cannot be used for storage.`,
    };
  }
  const host = api as DesktopApi;

  let info: BridgeResult;
  try {
    info = await host.info();
  } catch (error) {
    return { connected: false, reason: `The desktop host did not answer: ${messageOf(error)}` };
  }
  if (!info.ok) {
    return { connected: false, reason: `The desktop host reported an error: ${info.error}` };
  }

  const protocol = typeof info.protocol === 'number' ? info.protocol : null;
  if (protocol !== DESKTOP_PROTOCOL_VERSION) {
    return {
      connected: false,
      reason:
        `The desktop host speaks storage protocol v${protocol ?? 'unknown'}; ` +
        `this build needs v${DESKTOP_PROTOCOL_VERSION}. Update one of them.`,
    };
  }

  return {
    connected: true,
    host: {
      api: host,
      version: typeof info.version === 'string' ? info.version : 'unknown',
      protocol,
      dataDir: typeof info.data_dir === 'string' ? info.data_dir : null,
      workspaceDir: typeof info.workspace_dir === 'string' ? info.workspace_dir : null,
      python: typeof info.python === 'string' ? info.python : null,
      platform: typeof info.platform === 'string' ? info.platform : null,
    },
  };
}

/**
 * Blocks until `window.pywebview.api` exists.
 *
 * The host dispatches a `pywebviewready` event when the bridge is live; polling is
 * the fallback for a host that injects before this module loads, in which case the
 * event has already fired and will never be seen.
 */
function waitForApi(timeoutMs: number): Promise<Partial<DesktopApi> | null> {
  return new Promise((resolve) => {
    const target = globalThis as PywebviewWindow;
    const current = (): Partial<DesktopApi> | null => {
      const candidate = target.pywebview?.api;
      return isApiShaped(candidate) ? candidate : null;
    };

    const existing = current();
    if (existing) {
      resolve(existing);
      return;
    }
    if (typeof window === 'undefined') {
      // No DOM (a worker, or an environment that did not set one up): there is
      // nothing to wait for and nothing to wait with.
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: Partial<DesktopApi> | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('pywebviewready', onReady);
      clearTimeout(timer);
      clearInterval(poll);
      resolve(value);
    };
    const onReady = (): void => finish(current());
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Polling as well as listening: a host that injects the API before this module
    // runs has already fired the event, and an event that fired in the past is never
    // going to be heard.
    const poll = setInterval(() => {
      const found = current();
      if (found) finish(found);
    }, 25);

    window.addEventListener('pywebviewready', onReady, { once: true });
  });
}

function isApiShaped(value: unknown): value is Partial<DesktopApi> {
  return typeof value === 'object' && value !== null && typeof (value as DesktopApi).write === 'function';
}

/**
 * One callback shape for everything this store has to say.
 *
 * Every report is a sentence meant for the person using Ideno, so they all arrive
 * the same way and the UI has one place to put them.
 */
export type DesktopReport = (message: string) => void;

export interface DesktopStoreOptions {
  /** Called when a mirrored write fails. The UI turns this into a warning. */
  onFailure?: DesktopReport;
  /**
   * Called once per boot when some stored documents could not be read, with a
   * sentence naming them. A partial load is not a failed load: the readable
   * documents are still there, and the user needs to know which are missing.
   */
  onPartialLoad?: DesktopReport;
}

/**
 * A `Store` backed by files on the user's machine, via the desktop host.
 *
 * Reads are cache hits. Writes are synchronous to the cache and mirrored to disk
 * asynchronously, in order. A failed mirror is reported through `onFailure` — it is
 * not retried silently, because "your idea did not save" is exactly the kind of
 * thing that must not be quietly absorbed.
 */
export class DesktopStore implements Store {
  readonly kind: StoreKind = 'desktop_file';

  #api: DesktopApi;
  #host: DesktopHost;
  #onFailure: DesktopReport | null;
  #onPartialLoad: DesktopReport | null;
  #chain: Promise<void> = Promise.resolve();
  #workspaceDir: string | null;
  /**
   * Everything the host had at boot, plus every write since.
   *
   * The cache is not an optimisation, it is the read path: `Store.read` is
   * synchronous and the bridge is not. See the module comment for why that trade is
   * the right one here and what it costs.
   */
  #cache = new Map<string, string>();

  constructor(host: DesktopHost, options: DesktopStoreOptions = {}) {
    this.#api = host.api;
    this.#host = host;
    this.#onFailure = options.onFailure ?? null;
    this.#onPartialLoad = options.onPartialLoad ?? null;
    this.#workspaceDir = host.workspaceDir;
  }

  /** The host this store talks to: version, protocol, where the files are. */
  get host(): DesktopHost {
    return this.#host;
  }

  get workspaceDir(): string | null {
    return this.#workspaceDir;
  }

  read(key: string): string | null {
    return this.#cache.get(key) ?? null;
  }

  /**
   * Loads every stored document into the cache. Called once at boot, before the
   * State Manager reads anything.
   *
   * A partial load is still a successful load: the documents that could be read are
   * cached, and the ones that could not are reported by name so the user is not
   * shown a workspace that silently lacks an idea.
   */
  async load(options: { onPartialLoad?: DesktopReport } = {}): Promise<void> {
    const result = await this.#api.snapshot();
    if (!result.ok) {
      throw new Error(result.error);
    }
    for (const [key, value] of Object.entries(result.values ?? {})) {
      this.#cache.set(key, value);
    }
    const failures = result.failures ?? [];
    if (failures.length === 0) return;
    const message =
      failures.length === 1
        ? `One stored document could not be read (${failures[0]}).`
        : `${failures.length} stored documents could not be read (${failures.join('; ')}).`;
    // An explicit argument wins over the one supplied at construction. They are
    // handled separately rather than unified into one variable: two callables with
    // the same signature are not interchangeable to the type checker, and the
    // resulting intersection makes the call site unreadable for no benefit.
    const report = options.onPartialLoad ?? this.#onPartialLoad;
    if (report) report(message);
    else this.#report(message);
  }

  write(key: string, value: string): void {
    this.#cache.set(key, value);
    this.#enqueue(() => this.#api.write(key, value), `save "${key}"`);
  }

  remove(key: string): void {
    this.#cache.delete(key);
    this.#enqueue(() => this.#api.remove(key), `remove "${key}"`);
  }

  /** Keys currently held. Used by diagnostics and by the test suite. */
  keys(): string[] {
    return [...this.#cache.keys()].sort();
  }

  /**
   * Resolves once every mirrored write has been answered.
   *
   * Awaited on `pagehide` and on teardown. It is also the right thing to await in a
   * test, which is what makes this path testable rather than merely plausible.
   */
  whenSettled(): Promise<void> {
    return this.#chain;
  }

  /**
   * Serialises mirroring. Ordering matters: a snapshot written before an index entry
   * that refers to it would leave a stored workspace pointing at a document that is
   * not there yet, and the failure would only appear on the next boot.
   */
  #enqueue(call: () => Promise<BridgeResult>, description: string): void {
    this.#chain = this.#chain.then(async () => {
      let result: BridgeResult;
      try {
        result = await call();
      } catch (error) {
        this.#report(`The desktop host could not be reached to ${description}: ${messageOf(error)}`);
        return;
      }
      if (!result.ok) {
        // A quota-shaped failure is reported as one, so the State Manager's
        // prune-and-retry path still applies on the desktop — a full disk is a real
        // possibility there, even though the ~5 MB browser ceiling is not.
        const quota = (result.kind ?? '').includes('quota') || isQuotaError(new Error(result.error));
        this.#report(
          `Could not ${description}: ${result.error}${quota ? ' The disk may be full.' : ''}`,
        );
      }
    });
  }

  #report(message: string): void {
    try {
      this.#onFailure?.(message);
    } catch {
      // A broken listener must not break persistence.
    }
  }
}

/**
 * Attaches to the desktop host if there is one.
 *
 * Returns null in a plain browser, which is the common case and not an error. The
 * caller keeps using the browser store, so the same bundle serves both the website
 * and the desktop application without a build-time switch.
 */
export async function initDesktopStore(options: DesktopStoreOptions = {}): Promise<DesktopStore | null> {
  const connection = await connectDesktopHost();
  if (!connection.connected) return null;
  const store = new DesktopStore(connection.host, options);
  try {
    await store.load(options);
  } catch (error) {
    options.onFailure?.(`The desktop workspace could not be read (${messageOf(error)}); using browser storage instead.`);
    return null;
  }
  return store;
}
