import { describe, expect, it } from 'vitest';
import { createIdeaCase } from '../core/idea_state.js';
import { applyOperations, quoteOccursIn, reconcileEpistemicStatus } from '../core/patch.js';
import type { ApplyEntry } from '../core/patch.js';
import type { IdeaCase, StateOperation } from '../core/schemas.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function freshCase(): IdeaCase {
  return createIdeaCase({
    id: '11111111-1111-4111-8111-111111111111',
    originalIdea: 'I want to build a small autonomous greenhouse.',
    now: NOW,
  });
}

function entry(operation: StateOperation, id = `e${Math.random().toString(16).slice(2, 8)}`): ApplyEntry {
  return { id, operation };
}

describe('quoteOccursIn', () => {
  it('accepts a verbatim quote regardless of whitespace and case', () => {
    expect(quoteOccursIn('Fit ON a   Balcony', 'It has to fit on a balcony.')).toBe(true);
  });

  it('rejects a paraphrase', () => {
    expect(quoteOccursIn('must be balcony sized', 'It has to fit on a balcony.')).toBe(false);
  });

  it('rejects quotes that are too short to be meaningful', () => {
    expect(quoteOccursIn('it', 'It has to fit on a balcony.')).toBe(false);
  });

  it('rejects anything when there is no user message to check against', () => {
    expect(quoteOccursIn('fit on a balcony', null)).toBe(false);
  });
});

describe('reconcileEpistemicStatus', () => {
  it('downgrades an unverifiable model claim of "known"', () => {
    const result = reconcileEpistemicStatus({
      requested: 'known',
      collection: 'constraints',
      origin: 'model',
      quoteVerified: false,
      resolvedEvidenceCount: 0,
    });
    expect(result.status).toBe('model_suggestion');
    expect(result.note).toMatch(/not traceable/u);
  });

  it('keeps "known" when the quote was verified', () => {
    const result = reconcileEpistemicStatus({
      requested: 'known',
      collection: 'constraints',
      origin: 'model',
      quoteVerified: true,
      resolvedEvidenceCount: 0,
    });
    expect(result.status).toBe('known');
    expect(result.note).toBeNull();
  });

  it('refuses "evidence_supported" without evidence', () => {
    const result = reconcileEpistemicStatus({
      requested: 'evidence_supported',
      collection: 'requirements',
      origin: 'model',
      quoteVerified: false,
      resolvedEvidenceCount: 0,
    });
    expect(result.status).toBe('model_suggestion');
  });

  it('allows "evidence_supported" when evidence resolved', () => {
    const result = reconcileEpistemicStatus({
      requested: 'evidence_supported',
      collection: 'requirements',
      origin: 'model',
      quoteVerified: false,
      resolvedEvidenceCount: 2,
    });
    expect(result.status).toBe('evidence_supported');
  });
});

describe('applyOperations', () => {
  it('never mutates the input case', () => {
    const original = freshCase();
    const snapshot = structuredClone(original);
    applyOperations(
      original,
      [
        entry({
          op: 'add',
          collection: 'constraints',
          item: { text: 'Must fit on a balcony', epistemic_status: 'assumed' },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );
    expect(original).toEqual(snapshot);
  });

  it('assigns ids, stamps provenance and records the version', () => {
    const result = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'constraints',
          item: {
            text: 'Must fit on a balcony',
            epistemic_status: 'known',
            source_quote: 'fit on a balcony',
          },
        }),
      ],
      {
        origin: 'model',
        userMessage: 'It has to fit on a balcony.',
        versionIndex: 3,
        now: NOW,
      },
    );

    const constraint = result.ideaCase.constraints[0];
    expect(constraint?.id).toMatch(/^con-[0-9a-f]{8}$/u);
    expect(constraint?.epistemic_status).toBe('known');
    expect(constraint?.origin).toBe('model');
    expect(constraint?.created_in_version).toBe(3);
    expect(constraint?.source_quote).toBe('fit on a balcony');
    expect(result.changed).toBe(true);
  });

  it('downgrades a fabricated quote and strips it', () => {
    const operationId = 'op-1';
    const result = applyOperations(
      freshCase(),
      [
        entry(
          {
            op: 'add',
            collection: 'requirements',
            item: {
              text: 'Must water 20 plants',
              epistemic_status: 'known',
              source_quote: 'I have exactly twenty plants',
            },
          },
          operationId,
        ),
      ],
      { origin: 'model', userMessage: 'I have some plants on the balcony.', versionIndex: 1, now: NOW },
    );

    const requirement = result.ideaCase.requirements[0];
    expect(requirement?.epistemic_status).toBe('model_suggestion');
    expect(requirement?.source_quote).toBeNull();
    expect(result.outcomes.get(operationId)?.note).toMatch(/not found in your message/u);
  });

  it('drops evidence references that do not resolve', () => {
    const operationId = 'op-2';
    const result = applyOperations(
      freshCase(),
      [
        entry(
          {
            op: 'add',
            collection: 'requirements',
            item: {
              text: 'Panels must deliver 5 W',
              epistemic_status: 'evidence_supported',
              supported_by: ['evd-deadbeef'],
            },
          },
          operationId,
        ),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );

    const requirement = result.ideaCase.requirements[0];
    expect(requirement?.supported_by).toEqual([]);
    expect(requirement?.epistemic_status).toBe('model_suggestion');
    expect(result.outcomes.get(operationId)?.note).toMatch(/unresolvable evidence/u);
  });

  it('links an item to evidence added in the same batch via a local ref', () => {
    const result = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'evidence',
          ref: 'e1',
          item: {
            text: 'Balcony rail loads are regulated',
            epistemic_status: 'evidence_supported',
            claim: 'Balcony rail loads are regulated',
            relevance: 'Limits how heavy the structure can be',
            source: {
              type: 'url',
              url: 'https://example.org/standard',
              retrieved_at: NOW.toISOString(),
              fetched_by_ideno: true,
            },
          },
        }),
        entry({
          op: 'add',
          collection: 'requirements',
          item: {
            text: 'Total mass under the rail load limit',
            epistemic_status: 'evidence_supported',
            supported_by: ['@e1'],
          },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );

    const evidenceId = result.ideaCase.evidence[0]?.id;
    expect(evidenceId).toBeDefined();
    expect(result.ideaCase.requirements[0]?.supported_by).toEqual([evidenceId]);
    expect(result.ideaCase.requirements[0]?.epistemic_status).toBe('evidence_supported');
  });

  it('forces evidence records to carry evidence_supported', () => {
    const operationId = 'op-3';
    const result = applyOperations(
      freshCase(),
      [
        entry(
          {
            op: 'add',
            collection: 'evidence',
            item: {
              text: 'Cited by the user',
              epistemic_status: 'model_suggestion',
              claim: 'Cited by the user',
              relevance: 'Context',
              source: { type: 'user', description: 'a datasheet they own' },
            },
          },
          operationId,
        ),
      ],
      { origin: 'user', versionIndex: 1, now: NOW },
    );
    expect(result.ideaCase.evidence[0]?.epistemic_status).toBe('evidence_supported');
    expect(result.outcomes.get(operationId)?.note).toMatch(/always recorded/u);
  });

  it('skips duplicates instead of accumulating them', () => {
    const base = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'constraints',
          item: { text: 'Must fit on a balcony', epistemic_status: 'assumed' },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );

    const duplicateId = 'op-dup';
    const second = applyOperations(
      base.ideaCase,
      [
        entry(
          {
            op: 'add',
            collection: 'constraints',
            item: { text: '  must FIT on a balcony ', epistemic_status: 'assumed' },
          },
          duplicateId,
        ),
      ],
      { origin: 'model', versionIndex: 2, now: NOW },
    );

    expect(second.ideaCase.constraints).toHaveLength(1);
    expect(second.outcomes.get(duplicateId)?.applied).toBe(false);
    expect(second.outcomes.get(duplicateId)?.note).toMatch(/Already tracked/u);
    expect(second.changed).toBe(false);
  });

  it('skips operations that target an id that does not exist', () => {
    const operationId = 'op-missing';
    const result = applyOperations(
      freshCase(),
      [entry({ op: 'invalidate', target_id: 'asm-00000000', reason: 'nope' }, operationId)],
      { origin: 'model', versionIndex: 1, now: NOW },
    );
    expect(result.changed).toBe(false);
    expect(result.outcomes.get(operationId)?.note).toMatch(/No item with id "asm-00000000" exists/u);
  });

  it('invalidates an item and records why', () => {
    const base = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'assumptions',
          item: { text: 'Mains power is available', epistemic_status: 'assumed' },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );
    const assumptionId = base.ideaCase.assumptions[0]?.id as string;

    const result = applyOperations(
      base.ideaCase,
      [
        entry({
          op: 'invalidate',
          target_id: assumptionId,
          reason: 'The system must run without mains electricity.',
        }),
      ],
      { origin: 'model', versionIndex: 2, now: NOW },
    );

    expect(result.ideaCase.assumptions[0]?.status).toBe('invalidated');
    expect(result.ideaCase.assumptions[0]?.status_reason).toMatch(/without mains/u);
  });

  it('keeps alternative selection exclusive', () => {
    const base = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'alternatives',
          item: {
            text: 'A',
            epistemic_status: 'model_suggestion',
            summary: 'A',
            approach: 'Approach A',
          },
        }),
        entry({
          op: 'add',
          collection: 'alternatives',
          item: {
            text: 'B',
            epistemic_status: 'model_suggestion',
            summary: 'B',
            approach: 'Approach B',
          },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );

    const [first, second] = base.ideaCase.alternatives;
    const afterFirst = applyOperations(
      base.ideaCase,
      [entry({ op: 'update', target_id: first?.id as string, changes: { selected: true }, reason: 'chosen' })],
      { origin: 'user', versionIndex: 2, now: NOW },
    );
    const afterSecond = applyOperations(
      afterFirst.ideaCase,
      [entry({ op: 'update', target_id: second?.id as string, changes: { selected: true }, reason: 'changed mind' })],
      { origin: 'user', versionIndex: 3, now: NOW },
    );

    expect(afterSecond.ideaCase.alternatives.filter((item) => item.selected)).toHaveLength(1);
    expect(afterSecond.ideaCase.alternatives.find((item) => item.selected)?.id).toBe(second?.id);
  });

  it('refuses self-relations and duplicate links', () => {
    const base = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'constraints',
          ref: 'c1',
          item: { text: 'No cloud connectivity', epistemic_status: 'assumed' },
        }),
        entry({
          op: 'add',
          collection: 'assumptions',
          ref: 'a1',
          item: { text: 'Remote monitoring via a hosted dashboard', epistemic_status: 'assumed' },
        }),
        entry({ op: 'relate', from: '@c1', to: '@a1', type: 'contradicts' }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );
    expect(base.ideaCase.relations).toHaveLength(1);

    const selfId = 'op-self';
    const dupeId = 'op-dupe';
    const constraintId = base.ideaCase.constraints[0]?.id as string;
    const assumptionId = base.ideaCase.assumptions[0]?.id as string;

    const result = applyOperations(
      base.ideaCase,
      [
        entry({ op: 'relate', from: constraintId, to: constraintId, type: 'affects' }, selfId),
        entry({ op: 'relate', from: constraintId, to: assumptionId, type: 'contradicts' }, dupeId),
      ],
      { origin: 'model', versionIndex: 2, now: NOW },
    );

    expect(result.ideaCase.relations).toHaveLength(1);
    expect(result.outcomes.get(selfId)?.note).toMatch(/cannot be related to itself/u);
    expect(result.outcomes.get(dupeId)?.note).toMatch(/already exists/u);
  });

  it('enforces the per-collection cap', () => {
    const cappedId = 'op-capped';
    const result = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'requirements',
          item: { text: 'First', epistemic_status: 'assumed' },
        }),
        entry(
          {
            op: 'add',
            collection: 'requirements',
            item: { text: 'Second', epistemic_status: 'assumed' },
          },
          cappedId,
        ),
      ],
      { origin: 'model', versionIndex: 1, now: NOW, maxItemsPerCollection: 1 },
    );

    expect(result.ideaCase.requirements).toHaveLength(1);
    expect(result.outcomes.get(cappedId)?.note).toMatch(/limit of 1 items/u);
  });

  it('ignores fields that do not apply to the target collection', () => {
    const base = applyOperations(
      freshCase(),
      [
        entry({
          op: 'add',
          collection: 'requirements',
          item: { text: 'Watering must be automatic', epistemic_status: 'assumed' },
        }),
      ],
      { origin: 'model', versionIndex: 1, now: NOW },
    );
    const requirementId = base.ideaCase.requirements[0]?.id as string;
    const operationId = 'op-badfield';

    const result = applyOperations(
      base.ideaCase,
      [
        entry(
          {
            op: 'update',
            target_id: requirementId,
            changes: { impact: 0.9, confidence: 0.4 },
            reason: 'refined',
          },
          operationId,
        ),
      ],
      { origin: 'model', versionIndex: 2, now: NOW },
    );

    expect(result.ideaCase.requirements[0]?.confidence).toBe(0.4);
    expect(result.outcomes.get(operationId)?.note).toMatch(/"impact" does not apply/u);
  });
});
