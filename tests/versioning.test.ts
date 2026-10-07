import { describe, expect, it } from 'vitest';

import { describeEntries, diffBodies, diffVersions, diffAgainstParent } from '../src/core/versioning/diff.js';
import { bodyOf, createIdeaCase, snapshotOf } from '../src/core/idea_state/create.js';
import { fixedClock } from '../src/core/ids.js';
import type { IdeaCaseBody } from '../src/core/schemas/index.js';
import { makeManager, userGroundedChangeSet } from './helpers.js';

function seededBody(): IdeaCaseBody {
  return bodyOf(
    createIdeaCase({ original_idea: 'A plant watering system.', clock: fixedClock() }),
  );
}

describe('diffBodies', () => {
  it('reports an added item with its label and provenance', () => {
    const before = seededBody();
    const after = seededBody();
    after.constraints.push({
      id: 'con_1',
      text: 'Must operate without mains electricity.',
      provenance: 'user_stated',
      origin_operation: 'update',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'active',
      category: 'power',
      hard: true,
    });

    const entries = diffBodies(before, after);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      collection: 'constraints',
      kind: 'added',
      item_id: 'con_1',
      label: 'Must operate without mains electricity.',
      provenance: 'user_stated',
    });
  });

  it('reports a modified item field by field', () => {
    const before = seededBody();
    const after = seededBody();
    const requirement = {
      id: 'req_1',
      text: 'Waters 3 plants.',
      provenance: 'user_stated' as const,
      origin_operation: 'understand' as const,
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'open' as const,
      priority: 'must' as const,
      kind: 'explicit' as const,
    };
    before.requirements.push(requirement);
    after.requirements.push({ ...requirement, text: 'Waters 20 plants.', updated_at: '2026-01-02T00:00:00.000Z' });

    const entries = diffBodies(before, after);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('modified');
    // `updated_at` is bookkeeping, not a change to the idea.
    expect(entries[0]?.fields).toEqual([{ field: 'text', before: 'Waters 3 plants.', after: 'Waters 20 plants.' }]);
  });

  it('reports removed items and scalar goal changes', () => {
    const before = seededBody();
    const after = seededBody();
    before.current_intent = 'Original intent';
    after.current_intent = 'Refined intent';
    before.unknowns.push({
      id: 'unk_1',
      text: 'How many plants?',
      provenance: 'unknown',
      origin_operation: 'understand',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'open',
      impact: 'high',
      affected_areas: ['Watering'],
      resolution: null,
    });

    const entries = diffBodies(before, after);
    const goal = entries.find((entry) => entry.collection === 'idea');
    const removed = entries.find((entry) => entry.kind === 'removed');
    expect(goal?.fields[0]).toEqual({ field: 'goal', before: 'Original intent', after: 'Refined intent' });
    expect(removed).toMatchObject({ collection: 'unknowns', item_id: 'unk_1' });
  });

  it('produces no entries for identical bodies', () => {
    expect(diffBodies(seededBody(), seededBody())).toEqual([]);
  });
});

describe('describeEntries', () => {
  it('summarises a diff in plain language', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    manager.enqueueChanges(
      {
        constraints_added: [{ text: 'No cloud connectivity.', provenance: 'user_stated', category: 'connectivity' }],
        requirements_added: [
          { text: 'Runs offline.', provenance: 'user_stated' },
          { text: 'Alerts on dry soil.', provenance: 'model_inferred' },
        ],
      },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));

    const history = manager.versions();
    const diff = diffVersions(history[1]!, history[2]!);
    expect(diff.from_version).toBe(1);
    expect(diff.to_version).toBe(2);
    expect(diff.summary).toMatch(/1 Constraints added/);
    expect(diff.summary).toMatch(/2 Requirements added/);
    expect(describeEntries([])).toBe('No state change');
  });

  it('diffs a version against its parent and returns nothing for v0', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    const history = manager.versions();
    expect(diffAgainstParent(history[0]!, history)).toBeNull();

    const diff = diffAgainstParent(history[1]!, history);
    const constraint = diff?.entries.filter((entry) => entry.collection === 'constraints');
    expect(constraint).toHaveLength(1);
    expect(constraint?.[0]).toMatchObject({
      kind: 'added',
      label: 'Must fit on a balcony.',
      provenance: 'user_stated',
    });
    // The derived phase moved too, and the diff says so.
    expect(diff?.entries.some((entry) => entry.collection === 'idea' && entry.label === 'Phase')).toBe(true);
  });
});

describe('snapshots', () => {
  it('are deep copies that later mutations cannot reach', () => {
    const idea = createIdeaCase({ original_idea: 'A kite.', clock: fixedClock() });
    const snapshot = snapshotOf(idea);
    idea.requirements.push({
      id: 'req_late',
      text: 'Added after the snapshot',
      provenance: 'user_stated',
      origin_operation: 'user',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'open',
      priority: 'must',
      kind: 'explicit',
    });
    expect(snapshot.requirements).toHaveLength(0);
    expect(snapshot).not.toHaveProperty('version_history');
  });
});
