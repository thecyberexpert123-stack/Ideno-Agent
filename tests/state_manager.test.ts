import { describe, expect, it, vi } from 'vitest';

import {
  StateManager,
  WORKSPACE_STORAGE_KEY,
  shouldAutoApply,
} from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { COLLECTION_LIMITS } from '../src/core/state_manager/apply.js';
import {
  IdeaCaseBodySchema,
  WORKSPACE_INDEX_KEY,
  sessionStorageKey,
  type ChangeRecord,
} from '../src/core/schemas/index.js';
import { makeManager, managerWithoutSession, sampleChangeSet, userGroundedChangeSet } from './helpers.js';

describe('session start', () => {
  it('records the raw idea as v0 and never rewrites it', () => {
    const manager = makeManager();
    const idea = manager.idea;
    expect(idea).not.toBeNull();
    expect(idea?.original_idea).toBe('I want to build a small autonomous greenhouse.');
    expect(idea?.version_history).toHaveLength(1);
    expect(idea?.version_history[0]?.number).toBe(0);
    expect(idea?.version_history[0]?.trigger).toBe('initial');
    expect(idea?.version_history[0]?.parent_id).toBeNull();
    expect(idea?.current_state).toBe('seed');
  });

  it('derives a title from the first sentence', () => {
    const manager = makeManager({ idea: 'A solar still. It should work offline.' });
    expect(manager.idea?.title).toBe('A solar still');
  });

  it('refuses every mutation before a session exists', () => {
    const manager = managerWithoutSession();
    expect(manager.hasSession).toBe(false);
    expect(() => manager.enqueueChanges({}, { origin: 'update', message_id: null })).toThrowError(
      /before an idea existed/,
    );
    expect(manager.pendingChanges()).toEqual([]);
    expect(manager.versions()).toEqual([]);
  });
});

describe('review policy', () => {
  it('applies what the user said and queues what the model inferred (assisted)', () => {
    const manager = makeManager();

    const grounded = manager.enqueueChanges(userGroundedChangeSet(), {
      origin: 'update',
      message_id: null,
      rationale: 'You said it must fit on a balcony.',
    });
    expect(grounded.pending).toHaveLength(0);
    expect(grounded.applied).toHaveLength(1);
    expect(grounded.version?.number).toBe(1);
    expect(manager.idea?.constraints[0]?.text).toBe('Must fit on a balcony.');
    expect(manager.idea?.constraints[0]?.provenance).toBe('user_stated');

    const inferred = manager.enqueueChanges(sampleChangeSet(), {
      origin: 'understand',
      message_id: null,
      rationale: 'First structuring pass.',
    });
    expect(inferred.applied).toHaveLength(0);
    expect(inferred.pending.length).toBeGreaterThan(0);
    expect(inferred.version).toBeNull();
    expect(manager.idea?.requirements).toHaveLength(0);
    expect(manager.versions()).toHaveLength(2);
  });

  it('queues everything in strict mode, including the user\'s own words', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(userGroundedChangeSet(), {
      origin: 'update',
      message_id: null,
      review_mode: 'strict',
    });
    expect(result.pending).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
    expect(manager.idea?.constraints).toHaveLength(0);
  });

  it('never queues a change the user made directly', () => {
    const record: ChangeRecord = {
      id: 'chg_x',
      kind: 'evidence_added',
      draft: 'x',
      affects: { item_ids: [], areas: [] },
      rationale: '',
      provenance: 'evidence_supported',
      origin_operation: 'user',
      message_id: null,
      status: 'pending',
      created_at: '2026-01-01T00:00:00.000Z',
      resolved_at: null,
      resolved_item_id: null,
      rejection_reason: null,
      version_id: null,
      integrity_note: null,
    };
    expect(shouldAutoApply(record, 'strict')).toBe(true);
    expect(shouldAutoApply({ ...record, origin_operation: 'update' }, 'strict')).toBe(false);
    expect(
      shouldAutoApply({ ...record, origin_operation: 'update', provenance: 'user_decision' }, 'strict'),
    ).toBe(true);
  });

  it('accepts a batch as one version and rejects individually', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null });
    const pending = result.pending;
    expect(pending.length).toBeGreaterThanOrEqual(5);

    const [first, second, ...rest] = pending;
    const rejected = manager.rejectChange(second!.id, 'Not true here — there is no mains power.');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('Not true here — there is no mains power.');
    expect(manager.versions()).toHaveLength(1); // rejecting changes nothing

    const version = manager.acceptChanges([first!.id, ...rest.map((record) => record.id)]);
    expect(version?.number).toBe(1);
    expect(version?.trigger).toBe('accept');
    expect(version?.applied_change_ids).toContain(first!.id);
    expect(manager.idea?.requirements.length).toBeGreaterThan(0);
    expect(manager.pendingChanges()).toHaveLength(0);
    // The rejected assumption never entered the state.
    expect(manager.idea?.assumptions.some((item) => item.id === rejected.resolved_item_id)).toBe(false);
  });

  it('refuses to resolve the same change twice', () => {
    const manager = makeManager();
    const [pending] = manager.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null }).pending;
    manager.rejectChange(pending!.id);
    expect(() => manager.rejectChange(pending!.id)).toThrowError(/already rejected/);
    expect(() => manager.rejectChange('chg_missing')).toThrowError(/No change record/);
  });

  it('rejects all pending changes on request', () => {
    const manager = makeManager();
    manager.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null });
    const count = manager.pendingChanges().length;
    expect(manager.rejectAllPending('Starting over.')).toBe(count);
    expect(manager.pendingChanges()).toHaveLength(0);
  });
});

describe('provenance integrity', () => {
  it('stores model recall as a suggestion, never as evidence', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        evidence_added: [
          {
            claim: 'PETG is UV resistant enough for a season outdoors.',
            source: { title: 'Model recall', locator: 'model', publisher: null },
            relevance: 'Material choice for the enclosure.',
            confidence: 0.4,
            origin: 'model_recall',
            notes: null,
          },
        ],
      },
      { origin: 'research', message_id: null },
    );
    const record = result.records[0]!;
    expect(record.provenance).toBe('model_suggestion');

    manager.acceptChanges([record.id]);
    const evidence = manager.idea?.evidence[0];
    expect(evidence?.provenance).toBe('model_suggestion');
    expect(evidence?.origin).toBe('model_recall');
    expect(evidence?.status).toBe('accepted');
  });

  it('grants evidence status only when a real source is named', () => {
    const manager = makeManager();
    const result = manager.addUserEvidence({
      claim: 'Drip emitters deliver 2 L/h at 1 bar.',
      source_title: 'Supplier datasheet',
      source_locator: 'https://example.com/dripper-datasheet.pdf',
      relevance: 'Sizes the pump and reservoir.',
      confidence: 0.9,
    });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.provenance).toBe('evidence_supported');
    const evidence = manager.idea?.evidence[0];
    expect(evidence?.provenance).toBe('evidence_supported');
    expect(evidence?.origin).toBe('user_supplied');
    expect(evidence?.timestamp).toBeTruthy();
  });

  it('downgrades a claim of evidence support that cites nothing real', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        requirements_added: [
          {
            text: 'Must survive -5 °C nights.',
            provenance: 'evidence_supported',
            evidence_refs: ['evd_does_not_exist'],
          },
        ],
      },
      { origin: 'understand', message_id: null },
    );
    expect(result.records[0]?.provenance).toBe('model_suggestion');
    expect(result.integrity_notes.join(' ')).toMatch(/downgraded to a model suggestion/);
    expect(result.records[0]?.draft).toMatchObject({ evidence_refs: [] });
  });

  it('lets a requirement cite evidence added in the same batch by temp id', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        evidence_added: [
          {
            temp_id: 'e1',
            claim: 'Balcony load limits are commonly 250 kg/m².',
            source: { title: 'Building guide', locator: 'https://example.com/balcony-load', publisher: null },
            relevance: 'Bounds the weight of a filled greenhouse.',
            confidence: 0.7,
            origin: 'user_supplied',
            notes: null,
          },
        ],
        constraints_added: [
          {
            text: 'Total wet weight must stay within the balcony load limit.',
            provenance: 'evidence_supported',
            evidence_refs: ['e1'],
            category: 'physical',
            hard: true,
          },
        ],
      },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );

    const constraint = result.records.find((record) => record.kind === 'constraint_added')!;
    expect(constraint.provenance).toBe('evidence_supported');
    const evidence = result.records.find((record) => record.kind === 'evidence_added')!;
    expect((constraint.draft as { evidence_refs: string[] }).evidence_refs).toEqual([
      evidence.resolved_item_id,
    ]);

    manager.acceptChanges(result.records.map((record) => record.id));
    expect(manager.idea?.constraints[0]?.evidence_refs).toEqual([manager.idea?.evidence[0]?.id]);
  });

  it('prunes references to ids that do not exist and says so', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        findings_added: [
          {
            text: 'The watering schedule conflicts with the stated power budget.',
            kind: 'contradiction',
            severity: 'major',
            related_ids: ['req_nope', 'con_nope'],
            recommendation: 'Pick a power source before fixing the schedule.',
            notes: null,
          },
        ],
      },
      { origin: 'critique', message_id: null },
    );
    expect((result.records[0]!.draft as { related_ids: string[] }).related_ids).toEqual([]);
    expect(result.integrity_notes.join(' ')).toMatch(/dropped 2 unknown id\(s\) from "related_ids"/);
    expect(result.records[0]!.affects.item_ids).toEqual([]);
  });

  it('ignores updates and invalidations aimed at unknown items', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        items_updated: [{ id: 'unk_missing', status: 'resolved' }],
        items_invalidated: [{ id: 'asm_missing', reason: 'No longer relevant' }],
      },
      { origin: 'update', message_id: null },
    );
    expect(result.records).toHaveLength(0);
    expect(result.integrity_notes.join(' ')).toMatch(/unknown item "unk_missing"/);
    expect(result.integrity_notes.join(' ')).toMatch(/unknown item "asm_missing"/);
  });
});

describe('applying changes', () => {
  it('mints ids, timestamps and origin operations itself', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      {
        constraints_added: [
          { text: 'No cloud connectivity.', provenance: 'user_stated', category: 'connectivity', hard: true },
        ],
      },
      { origin: 'update', message_id: 'msg_42' },
    );
    manager.acceptChanges([]);
    const constraint = manager.idea?.constraints[0]!;
    expect(constraint.id).toMatch(/^con_/);
    expect(constraint.origin_operation).toBe('update');
    expect(constraint.source_message_id).toBe('msg_42');
    expect(constraint.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.applied).toHaveLength(1);
  });

  it('invalidates an earlier assumption when new information contradicts it', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      { assumptions_added: [{ text: 'Mains power is available.', provenance: 'model_inferred' }] },
      { origin: 'understand', message_id: null, review_mode: 'assisted' },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const assumption = manager.idea?.assumptions[0]!;

    manager.enqueueChanges(
      { items_invalidated: [{ id: assumption.id, reason: 'Battery-only operation was requested.' }] },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));

    const updated = manager.idea?.assumptions[0]!;
    expect(updated.id).toBe(assumption.id);
    expect(updated.status).toBe('invalidated');
    expect(updated.notes).toMatch(/battery-only operation was requested/i);
    expect(updated.updated_at).not.toBeNull();
  });

  it('updates the primary text of any collection through one mechanism', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      {
        requirements_added: [{ text: 'Supports 3 plants.', provenance: 'user_stated', kind: 'explicit' }],
        unknowns_added: [{ text: 'How many plants?', provenance: 'unknown', impact: 'high' }],
      },
      { origin: 'understand', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const requirement = manager.idea?.requirements[0]!;
    const unknown = manager.idea?.unknowns[0]!;

    manager.enqueueChanges(
      {
        items_updated: [
          { id: requirement.id, text: 'Supports 20 plants.' },
          { id: unknown.id, status: 'resolved', resolution: 'The user settled on 20 plants.' },
        ],
      },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));

    expect(manager.idea?.requirements[0]?.text).toBe('Supports 20 plants.');
    expect(manager.idea?.unknowns[0]?.status).toBe('resolved');
    expect(manager.idea?.unknowns[0]?.resolution).toBe('The user settled on 20 plants.');
  });

  it('ignores a field that is not valid for the target collection but keeps the rest', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      { requirements_added: [{ text: 'Must be quiet.', provenance: 'user_stated' }] },
      { origin: 'understand', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const requirement = manager.idea?.requirements[0]!;

    const integrity: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'integrity') integrity.push(event.message);
    });

    const queued = manager.enqueueChanges(
      {
        items_updated: [
          // `impact` belongs to unknowns, `confidence` to assumptions.
          { id: requirement.id, text: 'Must be quiet at night.', impact: 'high', confidence: 0.9 },
        ],
      },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );
    expect(queued.pending).toHaveLength(1);

    const version = manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    expect(version).not.toBeNull(); // the update still went through
    expect(manager.idea?.requirements[0]?.text).toBe('Must be quiet at night.');
    expect(integrity.join(' ')).toMatch(/ignored field\(s\) that requirements does not carry: confidence, impact/);
  });

  it('refuses an update whose status is illegal for that collection', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      { requirements_added: [{ text: 'Must be portable.', provenance: 'user_stated' }] },
      { origin: 'understand', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const requirement = manager.idea?.requirements[0]!;

    manager.enqueueChanges(
      { items_updated: [{ id: requirement.id, status: 'selected' }] },
      { origin: 'update', message_id: null, review_mode: 'strict' },
    );
    const rejected = manager.pendingChanges()[0]!;
    manager.acceptChanges([rejected.id]);

    // `selected` is an alternative status: the update is refused, text untouched.
    expect(manager.idea?.requirements[0]?.status).toBe('open');
    expect(manager.changeLog().find((record) => record.id === rejected.id)?.rejection_reason).toMatch(
      /Rejected update/,
    );
  });

  it('selects an alternative and demotes the previous selection', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      {
        alternatives_added: [
          { name: 'Passive', summary: 'No active control.', text: 'Passive', provenance: 'model_suggestion' },
          { name: 'Active', summary: 'Sensor driven.', text: 'Active', provenance: 'model_suggestion' },
        ],
      },
      { origin: 'explore', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const [first, second] = manager.idea!.alternatives;

    manager.selectAlternative(first!.id);
    expect(manager.idea?.selected_alternative_id).toBe(first!.id);
    expect(manager.idea?.alternatives[0]?.status).toBe('selected');

    manager.selectAlternative(second!.id);
    expect(manager.idea?.selected_alternative_id).toBe(second!.id);
    expect(manager.idea?.alternatives[0]?.status).toBe('proposed');
    expect(manager.idea?.alternatives[1]?.status).toBe('selected');

    manager.selectAlternative(null);
    expect(manager.idea?.selected_alternative_id).toBeNull();
    expect(manager.idea?.alternatives.some((item) => item.status === 'selected')).toBe(false);
  });

  it('ignores a selection that names no known alternative', () => {
    const manager = makeManager();
    const result = manager.enqueueChanges(
      { selected_alternative_id: 'alt_ghost' },
      { origin: 'update', message_id: null },
    );
    expect(result.records).toHaveLength(0);
    expect(result.integrity_notes.join(' ')).toMatch(/unknown alternative "alt_ghost"/);
  });

  it('records a user decision with user_decision provenance', () => {
    const manager = makeManager();
    manager.enqueueChanges(
      {
        alternatives_added: [
          { name: 'Option A', summary: 'A.', text: 'Option A', provenance: 'model_suggestion' },
        ],
      },
      { origin: 'explore', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    const alternative = manager.idea!.alternatives[0]!;

    const result = manager.recordUserDecision({
      decision: 'Use Option A.',
      rationale: 'Cheapest to build first.',
      alternative_id: alternative.id,
    });
    expect(result.applied).toHaveLength(2);
    expect(manager.idea?.decisions[0]?.provenance).toBe('user_decision');
    expect(manager.idea?.decisions[0]?.decided_by).toBe('user');
    expect(manager.idea?.selected_alternative_id).toBe(alternative.id);
    expect(result.version?.trigger).toBe('decision');
  });

  it('recomputes the phase from the data, never from a claim', () => {
    const manager = makeManager();
    expect(manager.idea?.current_state).toBe('seed');

    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    expect(manager.idea?.current_state).toBe('structuring');

    manager.enqueueChanges(
      {
        alternatives_added: [
          { name: 'A', summary: 'A', text: 'A', provenance: 'model_suggestion' },
          { name: 'B', summary: 'B', text: 'B', provenance: 'model_suggestion' },
        ],
      },
      { origin: 'explore', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    expect(manager.idea?.current_state).toBe('exploring');

    const alternative = manager.idea!.alternatives[1]!;
    manager.recordUserDecision({ decision: 'Use B.', alternative_id: alternative.id });
    expect(manager.idea?.current_state).toBe('decided');

    manager.enqueueChanges(
      {
        findings_added: [
          {
            text: 'B cannot be sealed against wind load.',
            kind: 'limitation',
            severity: 'critical',
            provenance: 'model_inferred',
          },
        ],
      },
      { origin: 'critique', message_id: null },
    );
    manager.acceptChanges(manager.pendingChanges().map((record) => record.id));
    expect(manager.idea?.current_state).toBe('blocked');
  });
});

describe('versioning', () => {
  it('numbers versions consecutively and links each to its parent', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    manager.enqueueChanges(
      { constraints_added: [{ text: 'No cloud.', provenance: 'user_stated', category: 'connectivity' }] },
      { origin: 'update', message_id: null },
    );
    const history = manager.versions();
    expect(history.map((version) => version.number)).toEqual([0, 1, 2]);
    expect(history[1]?.parent_id).toBe(history[0]?.id);
    expect(history[2]?.parent_id).toBe(history[1]?.id);
    expect(history[2]?.snapshot?.constraints).toHaveLength(2);
    expect(history[1]?.snapshot?.constraints).toHaveLength(1);
  });

  it('summarises a version from the actual diff', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    expect(manager.latestVersion()?.summary).toMatch(/1 Constraints added/i);
  });

  it('stores a full snapshot per version so any version can be restored', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    const v1 = manager.latestVersion()!;

    manager.enqueueChanges(
      {
        constraints_added: [{ text: 'No cloud connectivity.', provenance: 'user_stated', category: 'connectivity' }],
        requirements_added: [{ text: 'Must run offline.', provenance: 'user_stated', kind: 'explicit' }],
      },
      { origin: 'update', message_id: null },
    );
    expect(manager.idea?.constraints).toHaveLength(2);

    const restored = manager.restoreVersion(v1.id);
    expect(restored.trigger).toBe('restore');
    expect(restored.number).toBe(3);
    expect(restored.parent_id).toBe(manager.versions()[2]?.id);
    expect(manager.idea?.constraints).toHaveLength(1);
    expect(manager.idea?.requirements).toHaveLength(0);
    // History is appended to, never rewritten.
    expect(manager.versions().map((version) => version.number)).toEqual([0, 1, 2, 3]);
    expect(manager.versions()[1]?.snapshot?.constraints).toHaveLength(1);
    expect(manager.versions()[2]?.snapshot?.constraints).toHaveLength(2);
  });

  it('refuses to restore a version that does not exist', () => {
    const manager = makeManager();
    expect(() => manager.restoreVersion('ver_missing')).toThrowError(/No version with id/);
  });

  it('keeps the capacity guard aligned with the schema limits', () => {
    // apply.ts refuses to write past COLLECTION_LIMITS so that a batch can never
    // produce a body IdeaCaseBodySchema would reject. If the schema's .max()
    // changes without this constant, this test fails.
    const manager = makeManager();
    const base = manager.idea!;
    expect(COLLECTION_LIMITS.alternatives).toBe(60);

    const alternatives = Array.from({ length: COLLECTION_LIMITS.alternatives + 1 }, (_, index) => ({
      id: `alt_${index}`,
      name: `Alternative ${index}`,
      text: `Alternative ${index}`,
      summary: `Alternative ${index}`,
      provenance: 'model_suggestion',
      origin_operation: 'explore',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: base.created_at,
      updated_at: null,
      status: 'proposed',
      pros: [],
      cons: [],
      addresses: [],
      spec: null,
    }));
    expect(IdeaCaseBodySchema.safeParse({ ...base, alternatives }).success).toBe(false);
    expect(IdeaCaseBodySchema.safeParse({ ...base, alternatives: alternatives.slice(0, 60) }).success).toBe(true);
  });

  it('stops writing past a collection limit and reports it', () => {
    const manager = makeManager();
    const integrity: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'integrity') integrity.push(event.message);
    });

    // Alternatives are capped at 6 per change set, so fill the collection in
    // batches until the capacity guard fires.
    let counter = 0;
    for (let batch = 0; batch < 11; batch += 1) {
      const alternatives = Array.from({ length: 6 }, () => {
        counter += 1;
        return {
          name: `Alternative ${counter}`,
          text: `Alternative ${counter}`,
          summary: `Alternative ${counter}`,
          provenance: 'model_suggestion' as const,
        };
      });
      const result = manager.enqueueChanges(
        { alternatives_added: alternatives },
        { origin: 'explore', message_id: null, review_mode: 'strict' },
      );
      manager.acceptChanges(result.records.map((record) => record.id));
    }

    expect(manager.idea?.alternatives).toHaveLength(60);
    expect(integrity.join(' ')).toMatch(/at its limit of 60/);
    // The state is still valid after refusing the overflow.
    expect(manager.idea?.current_state).toBe('exploring');
  });
});

describe('transcript and events', () => {
  it('appends transcript entries with ids and timestamps', () => {
    const manager = makeManager();
    const entry = manager.appendTranscript({ role: 'user', text: 'It has to fit on a balcony.', turn_id: 'turn_1' });
    expect(entry.id).toMatch(/^msg_/);
    expect(entry.role).toBe('user');
    expect(manager.transcript()).toHaveLength(1);
    expect(() => manager.appendTranscript({ role: 'user', text: '   ' })).toThrowError();
  });

  it('notifies subscribers about queued changes, commits and resolutions', () => {
    const manager = makeManager();
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event.type));

    manager.appendTranscript({ role: 'user', text: 'It has to fit on a balcony.' });
    const result = manager.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null });
    manager.acceptChanges(result.pending.map((record) => record.id));
    unsubscribe();
    manager.appendTranscript({ role: 'user', text: 'ignored after unsubscribe' });

    expect(events).toContain('transcript_appended');
    expect(events).toContain('changes_queued');
    expect(events).toContain('version_committed');
    expect(events).toContain('change_resolved');
    expect(events.filter((type) => type === 'transcript_appended')).toHaveLength(1);
  });

  it('does not let a throwing subscriber break the state machine', () => {
    const manager = makeManager();
    manager.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    const spy = vi.fn();
    manager.subscribe(spy);
    expect(() => manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null })).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe('persistence', () => {
  it('round-trips a workspace through storage', () => {
    const store = new MemoryStore();
    const first = new StateManager({ store, clock: () => '2026-01-01T00:00:00.000Z' });
    first.startSession('A compost heater.');
    first.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });

    const second = new StateManager({ store, clock: () => '2026-01-02T00:00:00.000Z' });
    const outcome = second.loadPersisted();
    expect(outcome.status).toBe('loaded');
    expect(second.idea?.original_idea).toBe('A compost heater.');
    expect(second.idea?.constraints).toHaveLength(1);
    expect(second.versions()).toHaveLength(2);
  });

  it('reports empty storage instead of inventing a session', () => {
    const manager = new StateManager({ store: new MemoryStore() });
    expect(manager.loadPersisted().status).toBe('empty');
    expect(manager.hasSession).toBe(false);
  });

  it('reports corrupt storage and leaves the app usable', () => {
    const store = new MemoryStore();
    store.write(WORKSPACE_STORAGE_KEY, '{not json');
    const manager = new StateManager({ store });
    expect(manager.loadPersisted().status).toBe('corrupt');

    store.write(WORKSPACE_STORAGE_KEY, JSON.stringify({ schema_version: 99, session: {} }));
    const outcome = new StateManager({ store }).loadPersisted();
    expect(outcome.status).toBe('unsupported_version');
    expect(outcome).toMatchObject({ found: 99 });
  });

  it('reports a workspace that parses as JSON but fails validation', () => {
    const store = new MemoryStore();
    store.write(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ schema_version: 1, session: { id: 'session_1' }, saved_at: '2026-01-01T00:00:00.000Z' }),
    );
    const outcome = new StateManager({ store }).loadPersisted();
    expect(outcome.status).toBe('corrupt');
    expect(outcome).toHaveProperty('reason');
  });

  it('warns once when storage cannot be written', () => {
    // A quota failure is *recoverable*, so the manager first tries to shrink the
    // payload. With nothing prunable left (v0 is protected) it warns — once.
    const failing: MemoryStore = new MemoryStore();
    failing.write = () => {
      throw new Error('QuotaExceededError');
    };
    const manager = new StateManager({ store: failing });
    const integrity: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'integrity') integrity.push(event.message);
    });
    manager.startSession('A wind tunnel.');
    manager.appendTranscript({ role: 'user', text: 'hello' });
    expect(manager.persistenceWarning).toMatch(/QuotaExceededError/);
    // One warning even though two mutations failed: the banner is not a counter.
    expect(integrity.filter((message) => message.includes('out of storage space'))).toHaveLength(1);
    // The distinct failure is still reported, because "your idea is not saving"
    // and "your workspace list is not saving" call for different actions.
    expect(integrity.join(' ')).toMatch(/workspace list could not be saved/);
  });

  it('warns about a store that is broken rather than full', () => {
    const failing: MemoryStore = new MemoryStore();
    failing.write = () => {
      throw new Error('permission denied');
    };
    const manager = new StateManager({ store: failing });
    manager.startSession('A wind tunnel.');
    // Not a quota error, so no pruning is attempted: the reason goes straight up.
    expect(manager.persistenceWarning).toMatch(/permission denied/);
    expect(manager.persistenceWarning).not.toMatch(/out of storage space/);
  });

  it('clears stored data on request', () => {
    const store = new MemoryStore();
    const manager = new StateManager({ store });
    manager.startSession('A kite.');
    const first = manager.activeSessionId!;
    manager.startSession('A sail.');
    expect(store.read(WORKSPACE_INDEX_KEY)).not.toBeNull();
    expect(store.read(sessionStorageKey(first))).not.toBeNull();

    manager.clearPersisted();
    expect(store.read(WORKSPACE_INDEX_KEY)).toBeNull();
    expect(store.read(sessionStorageKey(first))).toBeNull();
    expect(store.read(sessionStorageKey(manager.activeSessionId!))).toBeNull();
    // The v0.1 blob is cleared too, so "wipe this browser" means it.
    expect(store.read(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it('exports and re-imports a validated workspace', () => {
    const manager = makeManager();
    manager.enqueueChanges(userGroundedChangeSet(), { origin: 'update', message_id: null });
    const json = manager.exportJson();
    expect(json).not.toBeNull();

    const other = managerWithoutSession();
    const imported = other.importJson(json!);
    expect(imported.ok).toBe(true);
    expect(other.idea?.constraints).toHaveLength(1);
    expect(other.importJson('{ broken').ok).toBe(false);
    expect(other.importJson(JSON.stringify({ nope: true })).ok).toBe(false);
  });
});
