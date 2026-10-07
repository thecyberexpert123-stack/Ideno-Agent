/**
 * Regression tests for the defects found in the v0.2 hardening pass.
 *
 * Every test here corresponds to something that was *reproduced* in v0.1 before it
 * was fixed, with the measurement recorded in `docs/V0_2_PLAN.md`. They are kept
 * separate from the feature suites so that the question "did we fix the thing we
 * said we fixed?" has one obvious place to look.
 *
 * The defects, in one line each:
 *
 *  D1 persistence re-validated the whole workspace on every mutation (quadratic);
 *  D2 a session past ~170 edits exceeded browser storage and nothing saved;
 *  D3 the version cap threw *after* the state had been written;
 *  D4 the transcript could outgrow its schema bound, making the workspace
 *     silently unsavable;
 *  D5 the change log could do the same;
 *  D6 a session opened mid-turn received that turn's changes;
 *  D7 rejecting a queue serialised the workspace once per record.
 */
import { describe, expect, it } from 'vitest';

import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore, isQuotaError, type Store } from '../src/core/state_manager/store.js';
import { migrateStoredSession, migrateSessionShape } from '../src/core/state_manager/migration.js';
import { prunableVersions, branchLineage, commonAncestor } from '../src/core/versioning/branch.js';
import { fixedClock } from '../src/core/ids.js';
import {
  LEGACY_WORKSPACE_KEY,
  MAX_TRANSCRIPT_ENTRIES,
  WORKSPACE_INDEX_KEY,
  WORKSPACE_SCHEMA_VERSION,
  sessionStorageKey,
} from '../src/core/schemas/index.js';
import { makeManager, userGroundedChangeSet } from './helpers.js';

/** A store whose writes fail like a full browser does, above a byte budget. */
class QuotaStore extends MemoryStore {
  #budget: number;

  constructor(budget: number) {
    super();
    this.#budget = budget;
  }

  override write(key: string, value: string): void {
    if (value.length > this.#budget) {
      const error = new Error('The quota has been exceeded.');
      error.name = 'QuotaExceededError';
      throw error;
    }
    super.write(key, value);
  }
}

describe('D1/D2 — persistence cost and storage pressure', () => {
  it('saves one idea per record, so a save does not grow with the workspace', () => {
    const store = new MemoryStore();
    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A compost heater.');
    manager.startSession('A tidal pump.');

    // Two ideas exist, and each has its own record.
    expect(manager.listIdeas()).toHaveLength(2);
    expect(store.read(WORKSPACE_INDEX_KEY)).not.toBeNull();
    const active = manager.activeSessionId!;
    expect(store.read(sessionStorageKey(active))).not.toBeNull();
    // The idea that is not open is stored too, under its own key.
    const other = manager.listIdeas().find((entry) => entry.session_id !== active)!;
    expect(store.read(sessionStorageKey(other.session_id))).not.toBeNull();
  });

  it('keeps a long session savable by pruning snapshots instead of failing', () => {
    // Measured on this codebase: 30 user-stated constraints produce a 201 KB
    // record, most of it snapshots of a body that has itself grown to 30 items —
    // the quadratic cost of full-snapshot versioning. A 60 KB budget therefore
    // cannot hold the history but comfortably holds the current state, which is
    // exactly the situation pruning exists for.
    const store = new QuotaStore(60_000);
    const integrity: string[] = [];
    const manager = new StateManager({ store, clock: fixedClock(), persist: true, keepRecentSnapshots: 2 });
    manager.subscribe((event) => {
      if (event.type === 'integrity') integrity.push(event.message);
    });

    manager.startSession('A greenhouse that runs itself.');
    for (let index = 0; index < 30; index += 1) {
      manager.enqueueChanges(
        { constraints_added: [{ text: `Constraint ${index}.`, provenance: 'user_stated' }] },
        { origin: 'user', message_id: null },
      );
    }

    // The state is intact and the workspace is still being saved.
    expect(manager.idea?.constraints.length).toBe(30);
    expect(manager.persistenceWarning).toBeNull();
    expect(store.read(sessionStorageKey(manager.activeSessionId!))).not.toBeNull();
    // …and the user was told what that cost them.
    expect(integrity.join(' ')).toMatch(/snapshot of v\d+ .* was dropped|storage ran out/);

    // A fresh manager reads back exactly what was saved.
    const reopened = new StateManager({ store, clock: fixedClock(), persist: false, keepRecentSnapshots: 2 });
    const outcome = reopened.loadPersisted();
    expect(outcome.status).toBe('loaded');
    expect(reopened.idea?.constraints.length).toBe(30);
    // Version records survive even where their snapshots do not: the account of
    // what happened is not the same thing as the state at that point.
    expect(reopened.versions().length).toBeGreaterThan(1);
    expect(reopened.versions().some((version) => version.snapshot_pruned)).toBe(true);
  });

  it('gives up with an actionable message when nothing is left to prune', () => {
    // v0 alone is bigger than this budget, and v0 is never prunable.
    const store = new QuotaStore(200);
    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A very long idea description that cannot possibly fit in the storage budget given to it here.');
    expect(manager.persistenceWarning).toMatch(/out of storage space/);
    expect(manager.persistenceWarning).toMatch(/Export the idea/);
    // The index write fails too, but the session warning is the one with an action
    // attached, so it is the one that survives.
    expect(manager.persistenceWarning).not.toMatch(/workspace list/);
  });

  it('detects a quota failure across the ways browsers report one', () => {
    const quota = new Error('The quota has been exceeded.');
    quota.name = 'QuotaExceededError';
    expect(isQuotaError(quota)).toBe(true);

    const safari = new Error('something failed');
    safari.name = 'NS_ERROR_DOM_QUOTA_REACHED';
    expect(isQuotaError(safari)).toBe(true);

    expect(isQuotaError({ code: 1014, message: 'no name here' })).toBe(true);
    expect(isQuotaError(new Error('exceeded the storage quota'))).toBe(true);

    // A broken store is not a full store: pruning would not help, so it must not
    // be classified as recoverable.
    expect(isQuotaError(new Error('permission denied'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe('D3 — the version cap', () => {
  it('prunes the oldest dispensable snapshot instead of throwing mid-commit', () => {
    const manager = new StateManager({
      store: new MemoryStore(),
      clock: fixedClock(),
      persist: false,
      maxVersions: 6,
      keepRecentSnapshots: 2,
    });
    manager.startSession('A kite.');

    // 10 commits against a cap of 6. v0.1 threw IdenoStateError('capacity') here,
    // after the state had already been written — a success reported as a failure.
    expect(() => {
      for (let index = 0; index < 10; index += 1) {
        manager.enqueueChanges(
          { unknowns_added: [{ text: `Unknown ${index}?`, provenance: 'unknown' }] },
          { origin: 'user', message_id: null },
        );
      }
    }).not.toThrow();

    expect(manager.idea?.unknowns).toHaveLength(10);
    const history = manager.versions();
    expect(history).toHaveLength(11); // every version is still recorded
    // The original idea is never the thing that gets dropped.
    expect(history[0]?.trigger).toBe('initial');
    expect(history[0]?.snapshot).not.toBeNull();
    expect(history.some((version) => version.snapshot_pruned)).toBe(true);
    // The recent past is still usable.
    expect(history[history.length - 1]?.snapshot).not.toBeNull();
  });

  it('never prunes the original idea, a label, or a branch head', () => {
    const manager = new StateManager({
      store: new MemoryStore(),
      clock: fixedClock(),
      persist: false,
      maxVersions: 4,
      keepRecentSnapshots: 1,
    });
    manager.startSession('A compost heater.');
    for (let index = 0; index < 8; index += 1) {
      manager.enqueueChanges(
        { requirements_added: [{ text: `Requirement ${index}.`, provenance: 'user_stated' }] },
        { origin: 'user', message_id: null },
      );
    }
    const history = manager.versions();
    const labelled = history[1];
    manager.labelVersion(labelled!.id, 'before the balcony constraint');

    // Re-open the pruning question with the label in place.
    const prunable = prunableVersions(history, manager.idea!.branches, { keepRecent: 1 });
    expect(prunable.some((version) => version.trigger === 'initial')).toBe(false);
    expect(prunable.some((version) => version.label !== null)).toBe(false);
    const heads = new Set(manager.idea!.branches.map((branch) => branch.head_version_id));
    expect(prunable.some((version) => heads.has(version.id))).toBe(false);
  });

  it('reports honestly when a pruned version cannot be compared or restored', () => {
    const manager = new StateManager({
      store: new MemoryStore(),
      clock: fixedClock(),
      persist: false,
      maxVersions: 3,
      keepRecentSnapshots: 1,
    });
    manager.startSession('A tidal pump.');
    for (let index = 0; index < 8; index += 1) {
      manager.enqueueChanges(
        { constraints_added: [{ text: `Constraint ${index}.`, provenance: 'user_stated' }] },
        { origin: 'user', message_id: null },
      );
    }
    const pruned = manager.versions().find((version) => version.snapshot_pruned);
    expect(pruned).toBeDefined();
    expect(() => manager.restoreVersion(pruned!.id)).toThrowError(/no longer stored/);
  });
});

describe('D4/D5 — append-only collections stay inside their bounds', () => {
  it('prunes the oldest transcript entries and keeps the workspace savable', () => {
    const store = new MemoryStore();
    const manager = new StateManager({
      store,
      clock: fixedClock(),
      persist: true,
      limits: { transcript: 20 },
    });
    manager.startSession('A wind tunnel.');
    const integrity: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'integrity') integrity.push(event.message);
    });

    for (let index = 0; index < 45; index += 1) {
      manager.appendTranscript({ role: 'user', text: `Message ${index}` });
    }

    expect(manager.transcript()).toHaveLength(20);
    // Newest survive: the conversation the user can still see is the recent one.
    expect(manager.transcript()[19]?.text).toBe('Message 44');
    expect(manager.transcript()[0]?.text).toBe('Message 25');
    expect(integrity.join(' ')).toMatch(/limit of 20 messages/);

    // The point of the fix: it still saves.
    expect(manager.toWorkspace()).not.toBeNull();
    expect(store.read(sessionStorageKey(manager.activeSessionId!))).not.toBeNull();
    expect(manager.persistenceWarning).toBeNull();
  });

  it('drops resolved change records before pending ones', () => {
    const manager = new StateManager({
      store: new MemoryStore(),
      clock: fixedClock(),
      persist: false,
      limits: { change_log: 24 },
    });
    manager.startSession('A greenhouse.');

    // 20 resolved records (user origin auto-applies and resolves immediately)…
    for (let index = 0; index < 20; index += 1) {
      manager.enqueueChanges(
        { constraints_added: [{ text: `Resolved ${index}.`, provenance: 'user_stated' }] },
        { origin: 'user', message_id: null },
      );
    }
    // …then 8 pending ones (strict mode queues them, so they stay unresolved).
    for (let index = 0; index < 8; index += 1) {
      manager.enqueueChanges(
        { assumptions_added: [{ text: `Pending ${index}.`, provenance: 'model_inferred' }] },
        { origin: 'critique', message_id: null, review_mode: 'strict' },
      );
    }

    expect(manager.changeLog().length).toBeLessThanOrEqual(24);
    // Every pending review the user has not dealt with is still in the queue:
    // silently dropping one would be dropping a decision they were asked to make.
    expect(manager.pendingChanges()).toHaveLength(8);
  });

  it('still honours the real defaults', () => {
    expect(MAX_TRANSCRIPT_ENTRIES).toBe(2000);
    const manager = makeManager();
    expect(manager.transcript()).toHaveLength(0);
  });
});

describe('D6 — a session opened mid-turn must not receive that turn', () => {
  it('refuses a mutation whose guard no longer matches', () => {
    const store = new MemoryStore();
    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A compost heater.');
    const guard = manager.guard;

    // The user opens a different idea while the first turn is still in flight.
    manager.startSession('A tidal pump.');

    expect(() =>
      manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null, guard }),
    ).toThrowError(/different idea was opened/);

    // Neither idea was touched by the abandoned turn.
    expect(manager.idea?.original_idea).toBe('A tidal pump.');
    expect(manager.idea?.constraints).toHaveLength(0);

    // The new session's own guard works.
    expect(() =>
      manager.enqueueChanges(userGroundedChangeSet(), {
        origin: 'update',
        message_id: null,
        guard: manager.guard,
      }),
    ).not.toThrow();
    expect(manager.idea?.constraints).toHaveLength(1);
  });

  it('guards transcript appends and accepts as well', () => {
    const manager = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    manager.startSession('A kite.');
    const guard = manager.guard;
    manager.startSession('A sail.');

    expect(() => manager.appendTranscript({ role: 'user', text: 'late write', guard })).toThrowError(
      /different idea was opened/,
    );
    expect(() => manager.acceptChanges(['chg_missing'], { guard })).toThrowError(/different idea was opened/);
  });

  it('treats an omitted guard as "no cross-session protection requested"', () => {
    // Direct user actions from the UI do not carry a guard: they are by definition
    // aimed at whatever is open now.
    const manager = makeManager();
    expect(() =>
      manager.enqueueChanges(userGroundedChangeSet(), { origin: 'user', message_id: null }),
    ).not.toThrow();
  });
});

describe('workspace layout and migration', () => {
  it('reads a v0.1 workspace, migrates it, and stops depending on the old blob', () => {
    const store = new MemoryStore();
    const legacy = new StateManager({ store, clock: fixedClock(), persist: true });
    legacy.startSession('A solar still.');
    legacy.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    // Simulate v0.1: one blob under the legacy key, no index.
    const blob = JSON.stringify({
      schema_version: 1,
      session: stripBranches(legacy.session!),
      saved_at: '2026-01-01T00:00:00.000Z',
    });
    store.write(LEGACY_WORKSPACE_KEY, blob);
    store.remove(WORKSPACE_INDEX_KEY);
    store.remove(sessionStorageKey(legacy.activeSessionId!));

    const notes: string[] = [];
    const upgraded = new StateManager({ store, clock: fixedClock('2026-02-01T00:00:00.000Z'), persist: true });
    upgraded.subscribe((event) => {
      if (event.type === 'integrity') notes.push(event.message);
    });
    const outcome = upgraded.loadPersisted();

    expect(outcome.status).toBe('loaded');
    expect(upgraded.idea?.original_idea).toBe('A solar still.');
    expect(upgraded.idea?.constraints).toHaveLength(1);
    // History survived, now on a named branch.
    expect(upgraded.versions().length).toBe(2);
    expect(upgraded.branches()).toHaveLength(1);
    expect(upgraded.branches()[0]?.name).toBe('main');
    expect(upgraded.versions().every((version) => version.branch_id !== null)).toBe(true);
    expect(notes.join(' ')).toMatch(/earlier version of Ideno/);

    // It is now stored in the new layout, and the legacy blob is gone.
    expect(store.read(WORKSPACE_INDEX_KEY)).not.toBeNull();
    expect(store.read(sessionStorageKey(upgraded.activeSessionId!))).not.toBeNull();
    expect(store.read(LEGACY_WORKSPACE_KEY)).toBeNull();

    // Idempotent: loading again changes nothing and adds no notes.
    const again = new StateManager({ store, clock: fixedClock('2026-03-01T00:00:00.000Z'), persist: false });
    const second = again.loadPersisted();
    expect(second.status).toBe('loaded');
    expect(again.branches()).toHaveLength(1);
  });

  it('refuses a workspace from a newer Ideno rather than guessing at it', () => {
    const store = new MemoryStore();
    store.write(
      WORKSPACE_INDEX_KEY,
      JSON.stringify({
        schema_version: WORKSPACE_SCHEMA_VERSION + 1,
        active_session_id: null,
        entries: [],
        saved_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const outcome = new StateManager({ store }).loadPersisted();
    expect(outcome).toMatchObject({ status: 'unsupported_version', found: WORKSPACE_SCHEMA_VERSION + 1 });
  });

  it('keeps the other ideas usable when one stored idea is corrupt', () => {
    const store = new MemoryStore();
    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A compost heater.');
    const goodId = manager.activeSessionId!;
    manager.startSession('A tidal pump.');
    store.write(sessionStorageKey(goodId), '{ not json');

    const reopened = new StateManager({ store, clock: fixedClock(), persist: false });
    const outcome = reopened.loadPersisted();
    // The active (newer) idea loads, so this workspace still opens.
    expect(outcome.status).toBe('loaded');

    // And the corrupt one is reported as corrupt, not silently dropped.
    const bad = reopened.openSession(goodId);
    expect(bad.status).toBe('corrupt');
    expect(reopened.listIdeas().map((entry) => entry.session_id)).toContain(goodId);
  });

  it('migration of session shape is idempotent', () => {
    const manager = makeManager();
    const once = migrateSessionShape(structuredClone(manager.session!));
    const twice = migrateSessionShape(structuredClone(once.session));
    expect(twice.notes).toHaveLength(0);
    expect(twice.session.idea.branches).toEqual(once.session.idea.branches);

    // The generic entry point agrees, and rejects junk.
    expect(migrateStoredSession({ nope: true }).ok).toBe(false);
    expect(migrateStoredSession(null).ok).toBe(false);
  });
});

describe('branch pointers', () => {
  it('walks a fork back through the history it inherited', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    const forkPoint = manager.latestVersion()!;
    const created = manager.createBranch({ name: 'passive-design' });

    manager.enqueueChanges(
      { constraints_added: [{ text: 'No electricity at all.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );

    // The returned Branch is still the live object after the switch: it is the same
    // entry the case now holds, not a copy taken before the idea was rewritten.
    const branch = manager.branches().find((entry) => entry.id === created.id);
    expect(branch).toBeDefined();
    expect(manager.activeBranch()?.id).toBe(created.id);

    const fork = branch!;
    const lineage = branchLineage(fork, manager.versions());
    expect(lineage.cycle_detected).toBe(false);
    // Newest first, and it runs all the way back to v0 through the shared history.
    expect(lineage.versions[lineage.versions.length - 1]?.number).toBe(0);
    expect(lineage.versions[0]?.branch_id).toBe(fork.id);
    expect(lineage.versions.some((version) => version.id === forkPoint.id)).toBe(true);

    const ancestor = commonAncestor(forkPoint, manager.latestVersion(), manager.versions());
    expect(ancestor?.id).toBe(forkPoint.id);
  });

  it('refuses to archive the only open branch', () => {
    const manager = makeManager();
    const only = manager.branches()[0]!;
    expect(() => manager.archiveBranch(only.id)).toThrowError(/only one open branch/);
  });
});

describe('D7 — rejecting a queue is one write, not one per record', () => {
  it('persists once for a batch rejection', () => {
    let writes = 0;
    const store: Store = {
      kind: 'memory',
      read: (key) => inner.read(key),
      write: (key, value) => {
        writes += 1;
        inner.write(key, value);
      },
      remove: (key) => inner.remove(key),
    };
    const inner = new MemoryStore();
    const manager = new StateManager({ store, clock: fixedClock(), persist: true });
    manager.startSession('A greenhouse.');
    for (let index = 0; index < 6; index += 1) {
      manager.enqueueChanges(
        { assumptions_added: [{ text: `Assumption ${index}.`, provenance: 'model_inferred' }] },
        { origin: 'critique', message_id: null, review_mode: 'strict' },
      );
    }
    expect(manager.pendingChanges().length).toBeGreaterThan(1);

    writes = 0;
    const rejected = manager.rejectAllPending('Not convinced.');
    expect(rejected).toBe(manager.changeLog().filter((record) => record.status === 'rejected').length);
    // One session write + one index write, regardless of how many were rejected.
    expect(writes).toBe(2);
  });
});

/** Removes branch data so a session looks like it was written by v0.1. */
function stripBranches(session: {
  idea: { branches?: unknown; active_branch_id?: unknown; version_history: { branch_id?: unknown }[] };
}): unknown {
  const clone = structuredClone(session) as {
    idea: { branches?: unknown; active_branch_id?: unknown; version_history: { branch_id?: unknown }[] };
  };
  clone.idea.branches = [];
  clone.idea.active_branch_id = null;
  for (const version of clone.idea.version_history) version.branch_id = null;
  return clone;
}

describe('coalesced persistence', () => {
  it('writes once for a burst of mutations, and immediately on flush', async () => {
    let writes = 0;
    const inner = new MemoryStore();
    const store: Store = {
      kind: 'memory',
      read: (key) => inner.read(key),
      write: (key, value) => {
        writes += 1;
        inner.write(key, value);
      },
      remove: (key) => inner.remove(key),
    };
    const manager = new StateManager({ store, clock: fixedClock(), persist: true, coalesceMs: 20 });
    manager.startSession('A greenhouse.');
    const afterStart = writes;

    for (let index = 0; index < 6; index += 1) {
      manager.enqueueChanges(
        { constraints_added: [{ text: `Constraint ${index}.`, provenance: 'user_stated' }] },
        { origin: 'user', message_id: null },
      );
    }
    // Nothing has been written for the burst yet — that is the whole point.
    expect(writes).toBe(afterStart);
    expect(manager.flush()).toBe(true);
    const afterFlush = writes;
    expect(afterFlush).toBeGreaterThan(afterStart);

    // And the stored copy is the current state, not an older one.
    const reopened = new StateManager({ store, clock: fixedClock(), persist: false });
    expect(reopened.loadPersisted().status).toBe('loaded');
    expect(reopened.idea?.constraints).toHaveLength(6);

    // A flush with nothing pending is a no-op, so callers can flush freely.
    writes = 0;
    manager.flush();
    expect(writes).toBe(0);
  });

  it('lands the pending write before another idea is opened', async () => {
    const store = new MemoryStore();
    const manager = new StateManager({ store, clock: fixedClock(), persist: true, coalesceMs: 5_000 });
    manager.startSession('A compost heater.');
    const firstId = manager.activeSessionId!;
    manager.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'user', message_id: null },
    );
    // The coalescing window is far from expiring, so without a flush on switch the
    // first idea would be stored without this constraint.
    manager.startSession('A tidal pump.');

    const reopened = new StateManager({ store, clock: fixedClock(), persist: false });
    expect(reopened.openSession(firstId).status).toBe('opened');
    expect(reopened.idea?.original_idea).toBe('A compost heater.');
    expect(reopened.idea?.constraints).toHaveLength(1);
  });
});
