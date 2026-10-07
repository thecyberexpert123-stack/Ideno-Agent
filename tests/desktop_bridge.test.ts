// @vitest-environment jsdom
/**
 * The desktop host bridge.
 *
 * These tests stand in for the Python host with an in-memory fake that follows the
 * same protocol, so the TypeScript half of the desktop path is verified without a
 * display, a web engine or a window. The Python half has its own suite
 * (`desktop/ideno_desktop/tests`), and the two are held to the same contract by
 * `DESKTOP_PROTOCOL_VERSION` on this side and `PROTOCOL_VERSION` on that one.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { StateManager } from '../src/core/state_manager/state_manager.js';
import { loadSettings, saveSettings } from '../src/ai/settings_store.js';
import { SettingsSchema } from '../src/ai/settings.js';
import { fixedClock } from '../src/core/ids.js';
import { WORKSPACE_INDEX_KEY, sessionStorageKey } from '../src/core/schemas/index.js';
import {
  DESKTOP_PROTOCOL_VERSION,
  DesktopStore,
  connectDesktopHost,
  initDesktopStore,
  type DesktopApi,
  type DesktopHost,
} from '../src/ui/desktop_bridge.js';

interface FakeHostOptions {
  files?: Map<string, string>;
  protocol?: number;
  version?: string;
  /** Keys whose write should fail, with the error to report. */
  failWrites?: Record<string, { error: string; kind?: string }>;
  /** Documents `snapshot` reports as unreadable. */
  unreadable?: string[];
  /** Throw instead of resolving, to model a host that stops answering. */
  unreachable?: boolean;
  /** Omit a method, to model a host from a different version. */
  omit?: (keyof DesktopApi)[];
}

function fakeHost(options: FakeHostOptions = {}): { api: DesktopApi; files: Map<string, string>; calls: string[] } {
  const files = options.files ?? new Map<string, string>();
  const calls: string[] = [];
  const unreachable = (): never => {
    throw new Error('the host stopped answering');
  };

  const ok = <T extends object>(payload: T) => ({ ok: true as const, ...payload });
  const api: DesktopApi = {
    async info() {
      calls.push('info');
      if (options.unreachable) unreachable();
      return ok({
        protocol: options.protocol ?? DESKTOP_PROTOCOL_VERSION,
        version: options.version ?? '0.2.0',
        kind: 'desktop-file',
        data_dir: '/home/tester/.local/share/ideno/v1',
        workspace_dir: '/home/tester/.local/share/ideno/v1/workspace',
        python: '3.11.2',
        platform: 'Linux',
      });
    },
    async snapshot() {
      calls.push('snapshot');
      if (options.unreachable) unreachable();
      const values: Record<string, string> = {};
      for (const [key, value] of files) {
        if (options.unreadable?.includes(key)) continue;
        values[key] = value;
      }
      return ok({
        protocol: DESKTOP_PROTOCOL_VERSION,
        values,
        workspace_dir: '/home/tester/.local/share/ideno/v1/workspace',
        ...(options.unreadable?.length ? { failures: options.unreadable.map((key) => `${key}: permission denied`) } : {}),
      });
    },
    async read(key: string) {
      calls.push(`read:${key}`);
      if (options.unreachable) unreachable();
      return ok({ value: files.get(key) ?? null });
    },
    async write(key: string, value: string) {
      calls.push(`write:${key}`);
      if (options.unreachable) unreachable();
      const failure = options.failWrites?.[key];
      if (failure) return { ok: false as const, error: failure.error, kind: failure.kind };
      files.set(key, value);
      return ok({});
    },
    async remove(key: string) {
      calls.push(`remove:${key}`);
      if (options.unreachable) unreachable();
      files.delete(key);
      return ok({});
    },
    async list() {
      calls.push('list');
      return ok({ keys: [...files.keys()].sort() });
    },
  };

  for (const method of options.omit ?? []) {
    delete (api as Partial<DesktopApi>)[method];
  }
  return { api, files, calls };
}

function hostOf(api: DesktopApi): DesktopHost {
  return {
    api,
    version: '0.2.0',
    protocol: DESKTOP_PROTOCOL_VERSION,
    dataDir: '/home/tester/.local/share/ideno/v1',
    workspaceDir: '/home/tester/.local/share/ideno/v1/workspace',
    python: '3.11.2',
    platform: 'Linux',
  };
}

/** Installs a fake host the way pywebview does, and removes it again. */
function installHost(api: DesktopApi): () => void {
  const target = globalThis as unknown as { pywebview?: { api?: DesktopApi } };
  target.pywebview = { api };
  return () => {
    delete target.pywebview;
  };
}

afterEach(() => {
  const target = globalThis as unknown as { pywebview?: unknown };
  delete target.pywebview;
});

describe('connecting to the host', () => {
  it('finds a host that is already injected', async () => {
    const { api } = fakeHost();
    installHost(api);
    const connection = await connectDesktopHost(500);
    expect(connection.connected).toBe(true);
    if (!connection.connected) return;
    expect(connection.host.version).toBe('0.2.0');
    expect(connection.host.workspaceDir).toContain('workspace');
    expect(connection.host.python).toBe('3.11.2');
  });

  it('finds a host that appears after the page loads', async () => {
    // This is the real ordering inside pywebview: the bundle runs, then the bridge
    // is injected and `pywebviewready` fires.
    const pending = connectDesktopHost(2000);
    const { api } = fakeHost();
    await new Promise((resolve) => setTimeout(resolve, 10));
    installHost(api);
    window.dispatchEvent(new CustomEvent('pywebviewready'));

    const connection = await pending;
    expect(connection.connected).toBe(true);
  });

  it('reports no host in a plain browser instead of failing', async () => {
    const connection = await connectDesktopHost(50);
    expect(connection.connected).toBe(false);
    if (connection.connected) return;
    expect(connection.reason).toMatch(/browser session/);
  });

  it('refuses a host that is missing part of the contract', async () => {
    const { api } = fakeHost({ omit: ['snapshot', 'remove'] });
    installHost(api);
    const connection = await connectDesktopHost(200);
    expect(connection.connected).toBe(false);
    if (connection.connected) return;
    expect(connection.reason).toMatch(/snapshot/);
    expect(connection.reason).toMatch(/remove/);
  });

  it('refuses a host speaking a different protocol', async () => {
    const { api } = fakeHost({ protocol: DESKTOP_PROTOCOL_VERSION + 1 });
    installHost(api);
    const connection = await connectDesktopHost(200);
    expect(connection.connected).toBe(false);
    if (connection.connected) return;
    expect(connection.reason).toMatch(/storage protocol/);
    expect(connection.reason).toMatch(/Update one of them/);
  });

  it('reports a host that stops answering rather than hanging', async () => {
    const { api } = fakeHost({ unreachable: true });
    installHost(api);
    const connection = await connectDesktopHost(200);
    expect(connection.connected).toBe(false);
    if (connection.connected) return;
    expect(connection.reason).toMatch(/did not answer/);
  });
});

describe('the file-backed store', () => {
  it('loads everything at boot and serves reads from the cache', async () => {
    const { api, files, calls } = fakeHost({
      files: new Map([
        [WORKSPACE_INDEX_KEY, '{"schema_version":2}'],
        ['ideno.settings.v1', '{"provider_id":"puter"}'],
      ]),
    });
    const store = new DesktopStore(hostOf(api));
    await store.load();

    expect(store.kind).toBe('desktop_file');
    expect(store.read(WORKSPACE_INDEX_KEY)).toBe('{"schema_version":2}');
    expect(store.read('ideno.settings.v1')).toContain('puter');
    expect(store.read('ideno.absent')).toBeNull();
    // One round trip for the whole store, not one per key.
    expect(calls.filter((call) => call === 'snapshot')).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('read:'))).toHaveLength(0);
    expect(files.size).toBe(2);
  });

  it('mirrors writes to the host, in order, and reports when settled', async () => {
    const { api, files, calls } = fakeHost();
    const store = new DesktopStore(hostOf(api));
    await store.load();

    store.write('ideno.a', '1');
    store.write('ideno.b', '2');
    store.write('ideno.a', '3');
    // Reads are correct immediately: the cache is the read path.
    expect(store.read('ideno.a')).toBe('3');

    await store.whenSettled();
    expect(files.get('ideno.a')).toBe('3');
    expect(files.get('ideno.b')).toBe('2');
    expect(calls.filter((call) => call.startsWith('write:'))).toEqual([
      'write:ideno.a',
      'write:ideno.b',
      'write:ideno.a',
    ]);
  });

  it('mirrors removals', async () => {
    const { api, files } = fakeHost({ files: new Map([['ideno.gone', 'x']]) });
    const store = new DesktopStore(hostOf(api));
    await store.load();
    expect(store.read('ideno.gone')).toBe('x');

    store.remove('ideno.gone');
    expect(store.read('ideno.gone')).toBeNull();
    await store.whenSettled();
    expect(files.has('ideno.gone')).toBe(false);
  });

  it('reports a failed mirror instead of pretending the write happened', async () => {
    const failures: string[] = [];
    const { api } = fakeHost({
      failWrites: { 'ideno.session.v2.a': { error: 'No space left on device', kind: 'quota' } },
    });
    const store = new DesktopStore(hostOf(api), { onFailure: (message) => failures.push(message) });
    await store.load();

    store.write('ideno.session.v2.a', '{"big":true}');
    await store.whenSettled();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/No space left on device/);
    expect(failures[0]).toMatch(/disk may be full/);
    // The cache still holds the value, which is honest: it is in memory and it did
    // not reach disk, and the warning is what says so.
    expect(store.read('ideno.session.v2.a')).toBe('{"big":true}');
  });

  it('reports a host that stops answering mid-session', async () => {
    // The window closing, the Python process being killed, a suspended laptop: the
    // bridge can die while the page is still up. The app must keep working and say
    // what it could not save.
    const files = new Map<string, string>();
    let alive = true;
    const { api } = fakeHost({ files });
    const guarded: DesktopApi = {
      ...api,
      async write(key, value) {
        if (!alive) throw new Error('host gone');
        return api.write(key, value);
      },
    };

    const failures: string[] = [];
    const store = new DesktopStore(hostOf(guarded), { onFailure: (message) => failures.push(message) });
    await store.load();
    store.write('ideno.ok', '1');
    await store.whenSettled();
    expect(failures).toHaveLength(0);
    expect(files.get('ideno.ok')).toBe('1');

    alive = false;
    store.write('ideno.later', '2');
    await store.whenSettled();

    expect(failures.join(' ')).toMatch(/could not be reached/);
    expect(files.has('ideno.later')).toBe(false);
    // Still readable in memory, so the session can continue and be exported.
    expect(store.read('ideno.later')).toBe('2');
  });

  it('names the documents it could not read at boot', async () => {
    const partial: string[] = [];
    const { api } = fakeHost({
      files: new Map([
        ['ideno.session.v2.good', '{"a":1}'],
        ['ideno.session.v2.bad', '{"b":2}'],
      ]),
      unreadable: ['ideno.session.v2.bad'],
    });
    const store = new DesktopStore(hostOf(api), { onPartialLoad: (message) => partial.push(message) });
    await store.load();

    expect(store.read('ideno.session.v2.good')).toBe('{"a":1}');
    expect(store.read('ideno.session.v2.bad')).toBeNull();
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatch(/ideno\.session\.v2\.bad/);
    expect(partial[0]).toMatch(/One stored document could not be read/);
  });

  it('a throwing failure listener does not break persistence', async () => {
    const { api, files } = fakeHost({ failWrites: { 'ideno.x': { error: 'nope' } } });
    const store = new DesktopStore(hostOf(api), {
      onFailure: () => {
        throw new Error('listener blew up');
      },
    });
    await store.load();
    expect(() => store.write('ideno.x', '1')).not.toThrow();
    await expect(store.whenSettled()).resolves.toBeUndefined();
    expect(files.has('ideno.x')).toBe(false);
  });
});

describe('the application on the desktop host', () => {
  it('initDesktopStore returns null in a browser and a loaded store on the desktop', async () => {
    expect(await initDesktopStore()).toBeNull();

    const { api, files } = fakeHost({ files: new Map([['ideno.settings.v1', '{"ok":true}']]) });
    installHost(api);
    const store = await initDesktopStore();
    expect(store).not.toBeNull();
    expect(store?.read('ideno.settings.v1')).toBe('{"ok":true}');
    expect(files.size).toBe(1);
  });

  it('falls back to browser storage when the workspace cannot be read', async () => {
    const failures: string[] = [];
    const { api } = fakeHost({ unreachable: true });
    installHost(api);
    const store = await initDesktopStore({ onFailure: (message) => failures.push(message) });
    // `info` fails first, so this is "no usable host", not a broken load; either way
    // the caller gets null and keeps the store it already had.
    expect(store).toBeNull();
    expect(failures).toHaveLength(0);
  });

  it('a state manager writes ideas to the host as files', async () => {
    const { api, files } = fakeHost();
    const store = new DesktopStore(hostOf(api));
    await store.load();

    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A greenhouse that runs itself.');
    manager.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated', category: 'physical' }] },
      { origin: 'user', message_id: null },
    );
    await store.whenSettled();

    const sessionId = manager.activeSessionId!;
    // The layout the Python side stores is the layout the web app writes: one index
    // document plus one document per idea.
    expect(files.has(WORKSPACE_INDEX_KEY)).toBe(true);
    expect(files.has(sessionStorageKey(sessionId))).toBe(true);
    const stored = JSON.parse(files.get(sessionStorageKey(sessionId))!) as {
      schema_version: number;
      session: { idea: { original_idea: string; constraints: { text: string }[] } };
    };
    expect(stored.schema_version).toBe(2);
    expect(stored.session.idea.original_idea).toBe('A greenhouse that runs itself.');
    expect(stored.session.idea.constraints.map((constraint) => constraint.text)).toContain('Must fit on a balcony.');

    // And a manager built from those files alone sees the same idea — which is the
    // whole point of storing it on disk rather than in a browser profile.
    const reopened = new StateManager({ store, clock: fixedClock(), persist: false });
    expect(reopened.loadPersisted().status).toBe('loaded');
    expect(reopened.idea?.constraints).toHaveLength(1);
  });

  it('settings live in the same place as the ideas', async () => {
    const { api, files } = fakeHost();
    const store = new DesktopStore(hostOf(api));
    await store.load();

    // Nothing stored yet: defaults, and no warning, because "no settings file" is a
    // first run rather than a failure.
    expect(loadSettings(store).warning).toBeNull();

    saveSettings(store, SettingsSchema.parse({ provider_id: 'puter', puter_model: 'gpt-5.6-luna' }), null);
    await store.whenSettled();
    expect(files.has('ideno.settings.v1')).toBe(true);

    // And they come back from the host, not from a browser profile.
    const reopened = new DesktopStore(hostOf(api));
    await reopened.load();
    expect(loadSettings(reopened).settings.puter_model).toBe('gpt-5.6-luna');
  });
});
