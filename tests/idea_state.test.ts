import { describe, expect, it } from 'vitest';

import { createIdeaCase, deriveTitle, bodyOf } from '../src/core/idea_state/create.js';
import {
  computeStats,
  decideQuestion,
  deriveCurrentState,
  openFindings,
  rankUnknowns,
} from '../src/core/idea_state/selectors.js';
import { findItem, itemLabel, parseItem, allItems } from '../src/core/idea_state/collections.js';
import { fixedClock, newId } from '../src/core/ids.js';
import type { IdeaCaseBody } from '../src/core/schemas/index.js';

function body(): IdeaCaseBody {
  return bodyOf(createIdeaCase({ original_idea: 'A compost heater.', clock: fixedClock() }));
}

function unknown(id: string, impact: 'high' | 'medium' | 'low', areas: string[], status = 'open') {
  return {
    id,
    text: `Unknown ${id}`,
    provenance: 'unknown' as const,
    origin_operation: 'understand' as const,
    source_message_id: null,
    evidence_refs: [],
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    status: status as 'open' | 'resolved',
    impact,
    affected_areas: areas,
    resolution: null,
  };
}

describe('deriveTitle', () => {
  it('takes the first sentence and drops its full stop', () => {
    expect(deriveTitle('A solar still. It must work offline.')).toBe('A solar still');
  });

  it('takes the first non-empty line when there is no punctuation', () => {
    expect(deriveTitle('\n\nA vertical farm\nmore detail here')).toBe('A vertical farm');
  });

  it('truncates long input without breaking mid-word silently', () => {
    const long = 'word '.repeat(40).trim();
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns an empty string for empty input rather than inventing a title', () => {
    expect(deriveTitle('   ')).toBe('');
  });
});

describe('createIdeaCase', () => {
  it('keeps the original idea verbatim and mirrors it into the intent', () => {
    const idea = createIdeaCase({ original_idea: '  A tidal pump.  ', clock: fixedClock() });
    expect(idea.original_idea).toBe('A tidal pump.');
    expect(idea.current_intent).toBe('A tidal pump.');
    expect(idea.current_state).toBe('seed');
    expect(idea.id).toMatch(/^idea_/);
  });

  it('refuses an empty idea instead of creating a hollow case', () => {
    expect(() => createIdeaCase({ original_idea: '   ' })).toThrowError(/must not be empty/);
  });
});

describe('deriveCurrentState', () => {
  it('is seed until something is structured', () => {
    expect(deriveCurrentState(body())).toBe('seed');
  });

  it('is structuring once requirements exist', () => {
    const state = body();
    state.requirements.push({
      id: 'req_1',
      text: 'Must water automatically',
      provenance: 'model_inferred',
      origin_operation: 'understand',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'open',
      priority: 'must',
      kind: 'implied',
    });
    expect(deriveCurrentState(state)).toBe('structuring');
  });

  it('is exploring when two live alternatives exist', () => {
    const state = body();
    for (const id of ['alt_1', 'alt_2']) {
      state.alternatives.push({
        id,
        name: id,
        text: id,
        summary: id,
        provenance: 'model_suggestion',
        origin_operation: 'explore',
        source_message_id: null,
        evidence_refs: [],
        notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        status: 'proposed',
        pros: [],
        cons: [],
        addresses: [],
        spec: null,
      });
    }
    expect(deriveCurrentState(state)).toBe('exploring');

    state.alternatives[1]!.status = 'rejected';
    expect(deriveCurrentState(state)).toBe('structuring');
  });

  it('is blocked by an open critical finding, whatever else is true', () => {
    const state = body();
    state.selected_alternative_id = 'alt_1';
    state.findings.push({
      id: 'fnd_1',
      text: 'The two constraints cannot both hold.',
      kind: 'contradiction',
      severity: 'critical',
      provenance: 'model_inferred',
      origin_operation: 'critique',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      related_ids: [],
      recommendation: null,
      status: 'open',
    });
    expect(deriveCurrentState(state)).toBe('blocked');

    state.findings[0]!.status = 'resolved';
    expect(deriveCurrentState(state)).not.toBe('blocked');
  });

  it('is refining while a decision is open, decided once it is settled', () => {
    const state = body();
    state.alternatives.push({
      id: 'alt_1',
      name: 'Passive',
      text: 'Passive',
      summary: 'Passive',
      provenance: 'model_suggestion',
      origin_operation: 'explore',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'proposed',
      pros: [],
      cons: [],
      addresses: [],
      spec: null,
    });
    state.selected_alternative_id = 'alt_1';
    expect(deriveCurrentState(state)).toBe('refining');

    state.decisions.push({
      id: 'dec_1',
      text: 'Build the passive version first.',
      provenance: 'user_decision',
      origin_operation: 'decision',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'active',
      rationale: null,
      alternatives_considered: ['alt_1'],
      decided_by: 'user',
    });
    expect(deriveCurrentState(state)).toBe('decided');

    // A remaining high-impact unknown means the idea is not finished.
    state.unknowns.push(unknown('unk_1', 'high', ['Structure']));
    expect(deriveCurrentState(state)).toBe('refining');
  });
});

describe('rankUnknowns', () => {
  it('orders by impact, then by how much of the design it blocks, then by age', () => {
    const state = body();
    state.unknowns.push(
      unknown('unk_low', 'low', ['a', 'b', 'c']),
      unknown('unk_high_small', 'high', ['a']),
      unknown('unk_high_wide', 'high', ['a', 'b', 'c']),
      unknown('unk_medium', 'medium', ['a', 'b']),
      unknown('unk_resolved', 'high', ['a'], 'resolved'),
    );
    expect(rankUnknowns(state).map((item) => item.id)).toEqual([
      'unk_high_wide',
      'unk_high_small',
      'unk_medium',
      'unk_low',
    ]);
  });
});

describe('decideQuestion', () => {
  const base = { why_it_matters: 'It sizes the pump.', impact: 'high' as const, unknown_id: null };

  it('passes a high-impact question through', () => {
    const decision = decideQuestion(body(), { ...base, text: 'How many plants?' });
    expect(decision.question?.text).toBe('How many plants?');
  });

  it('suppresses a low-impact question instead of interrogating the user', () => {
    const decision = decideQuestion(body(), { ...base, text: 'What colour?', impact: 'low' });
    expect(decision.question).toBeNull();
    expect(decision).toHaveProperty('suppressed_reason');
  });

  it('suppresses a question about an unknown that is already resolved', () => {
    const state = body();
    state.unknowns.push(unknown('unk_1', 'high', ['Watering'], 'resolved'));
    const decision = decideQuestion(state, { ...base, text: 'How many plants?', unknown_id: 'unk_1' });
    expect(decision.question).toBeNull();
    expect((decision as { suppressed_reason: string }).suppressed_reason).toMatch(/already resolved/);
  });

  it('suppresses a question that was already asked', () => {
    const state = body();
    state.open_questions.push({
      id: 'q_1',
      question: 'How many plants?',
      target: 'user',
      status: 'asked',
      impact: 'high',
      unknown_id: null,
      asked_at: '2026-01-01T00:00:00.000Z',
      origin_operation: 'understand',
      source_message_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const decision = decideQuestion(state, { ...base, text: 'how many PLANTS?' });
    expect(decision.question).toBeNull();
  });

  it('reports that nothing was proposed', () => {
    expect(decideQuestion(body(), null).question).toBeNull();
  });
});

describe('computeStats', () => {
  it('lists only open critique findings', () => {
    const state = body();
    const finding = {
      id: 'fnd_1',
      text: 'Contradiction',
      kind: 'contradiction' as const,
      severity: 'major' as const,
      provenance: 'model_inferred' as const,
      origin_operation: 'critique' as const,
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      related_ids: [],
      recommendation: null,
      status: 'open' as const,
    };
    state.findings.push(finding, { ...finding, id: 'fnd_2', status: 'dismissed' as const });
    expect(openFindings(state).map((item) => item.id)).toEqual(['fnd_1']);
    expect(computeStats(state).model_contributed).toBe(2);
  });

  it('counts open items separately from closed ones', () => {
    const state = body();
    state.unknowns.push(unknown('unk_1', 'high', ['a']), unknown('unk_2', 'low', ['b'], 'resolved'));
    const stats = computeStats(state);
    expect(stats.counts.unknowns).toEqual({ total: 2, open: 1 });
    expect(stats.open_high_impact_unknowns).toBe(1);
    expect(stats.phase).toBe('structuring');
    expect(stats.selected_alternative).toBeNull();
  });
});

describe('collection registry', () => {
  it('finds an item by id across every collection', () => {
    const state = body();
    state.unknowns.push(unknown('unk_1', 'high', ['a']));
    expect(findItem(state, 'unk_1')?.collection).toBe('unknowns');
    expect(findItem(state, 'nope')).toBeNull();
  });

  it('labels items using the field that holds their substance', () => {
    const state = body();
    state.evidence.push({
      id: 'evd_1',
      claim: 'Drip emitters deliver 2 L/h.',
      source: { title: 'Datasheet', locator: 'https://example.com/x', publisher: null },
      relevance: 'Pump sizing',
      confidence: 0.9,
      timestamp: '2026-01-01T00:00:00.000Z',
      origin: 'user_supplied',
      status: 'accepted',
      provenance: 'evidence_supported',
      origin_operation: 'user',
      source_message_id: null,
      notes: null,
    });
    expect(itemLabel('evidence', state.evidence[0]!)).toBe('Drip emitters deliver 2 L/h.');
  });

  it('walks every collection in a stable order', () => {
    const state = body();
    state.unknowns.push(unknown('unk_1', 'high', ['a']));
    const located = allItems(state);
    expect(located).toHaveLength(1);
    expect(located[0]).toMatchObject({ collection: 'unknowns', index: 0 });
  });

  it('rejects an item that does not satisfy its collection schema', () => {
    const result = parseItem('constraints', { id: 'con_1', text: 'x', status: 'selected' });
    expect(result.ok).toBe(false);
  });
});

describe('ids', () => {
  it('mints unique prefixed ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('req')));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^req_/);
  });

  it('advances a fixed clock deterministically', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z', 1000);
    expect(clock()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock()).toBe('2026-01-01T00:00:01.000Z');
    expect(() => fixedClock('not a date')).toThrowError(/invalid start timestamp/);
  });
});
