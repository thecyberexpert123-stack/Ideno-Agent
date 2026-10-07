import { describe, expect, it } from 'vitest';

import {
  ResearchRegistry,
  analyzeEvidenceGap,
  findingsToEvidenceDrafts,
  runResearch,
  type ResearchFinding,
  type ResearchSource,
} from '../src/research/evidence.js';
import { bodyOf, createIdeaCase } from '../src/core/idea_state/create.js';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { AIRuntime } from '../src/ai/runtime/runtime.js';
import { ScriptedProvider } from '../src/ai/providers/scripted.js';
import { fixedClock } from '../src/core/ids.js';
import {
  TurnPlanSchema,
  type IdeaCaseBody,
  type ResearchItem,
  type TurnPlanInput,
} from '../src/core/schemas/index.js';
import { SettingsSchema } from '../src/ai/settings.js';
import { makeManager } from './helpers.js';

function source(id: string, findings: ResearchFinding[] | Error): ResearchSource {
  return {
    id,
    label: `Source ${id}`,
    async search() {
      if (findings instanceof Error) throw findings;
      return findings;
    },
  };
}

const FINDING: ResearchFinding = {
  claim: 'Drip emitters deliver about 2 L/h at 1 bar.',
  source: { title: 'Supplier datasheet', locator: 'https://example.com/dripper.pdf', publisher: 'Example Ltd' },
  relevance: 'Sizes the pump and reservoir.',
  confidence: 0.85,
  retrieved_at: '2026-02-01T00:00:00.000Z',
};

function researchItem(overrides: Partial<ResearchItem> = {}): ResearchItem {
  return {
    id: 'res_1',
    question: 'What flow rate do drip emitters deliver?',
    priority: 'high',
    status: 'open',
    rationale: null,
    evidence_refs: [],
    origin_operation: 'understand',
    source_message_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    ...overrides,
  };
}

describe('ResearchRegistry', () => {
  it('registers, lists and looks up sources', () => {
    const registry = new ResearchRegistry();
    expect(registry.empty).toBe(true);
    registry.register(source('a', []));
    registry.register(source('b', []));
    expect(registry.empty).toBe(false);
    expect(registry.list().map((item) => item.id)).toEqual(['a', 'b']);
    expect(registry.get('a')?.label).toBe('Source a');
    expect(registry.get('missing')).toBeNull();
    expect(registry.unregister('a')).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses a duplicate source id', () => {
    const registry = new ResearchRegistry();
    registry.register(source('dup', []));
    expect(() => registry.register(source('dup', []))).toThrowError(/already registered/);
  });
});

describe('runResearch', () => {
  it('queries every registered source with the research question', async () => {
    const seen: string[] = [];
    const registry = new ResearchRegistry();
    registry.register({
      id: 'a',
      label: 'A',
      async search(query) {
        seen.push(query);
        return [FINDING];
      },
    });
    registry.register(source('b', [{ ...FINDING, claim: 'Second source agrees.' }]));

    const result = await runResearch(registry, researchItem());
    expect(seen).toEqual(['What flow rate do drip emitters deliver?']);
    expect(result.findings).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });

  it('keeps the findings of healthy sources when one fails', async () => {
    const registry = new ResearchRegistry();
    registry.register(source('broken', new Error('rate limited')));
    registry.register(source('healthy', [FINDING]));

    const result = await runResearch(registry, researchItem());
    expect(result.findings).toEqual([FINDING]);
    expect(result.failures).toEqual([{ source_id: 'broken', message: 'rate limited' }]);
  });

  it('returns nothing, and no failures, when no source is registered', async () => {
    const result = await runResearch(new ResearchRegistry(), researchItem());
    expect(result).toEqual({ findings: [], failures: [] });
  });

  it('passes search options through to the source', async () => {
    let received: { limit?: number } | undefined;
    const registry = new ResearchRegistry();
    registry.register({
      id: 'a',
      label: 'A',
      async search(_query, options) {
        received = options;
        return [];
      },
    });
    await runResearch(registry, researchItem(), { limit: 3 });
    expect(received?.limit).toBe(3);
  });
});

describe('findingsToEvidenceDrafts', () => {
  it('marks retrieved findings as research_source, which is what earns evidence status', () => {
    const { drafts, dropped } = findingsToEvidenceDrafts([FINDING]);
    expect(dropped).toEqual([]);
    expect(drafts[0]).toMatchObject({
      claim: FINDING.claim,
      origin: 'research_source',
      confidence: 0.85,
      notes: 'Retrieved 2026-02-01T00:00:00.000Z',
      source: { title: 'Supplier datasheet', locator: 'https://example.com/dripper.pdf', publisher: 'Example Ltd' },
    });
  });

  it('discards a finding with no usable locator instead of weakening it into existence', () => {
    const { drafts, dropped } = findingsToEvidenceDrafts([
      { ...FINDING, source: { title: 'Somewhere', locator: '   ' } },
      { ...FINDING, source: { title: '', locator: 'https://example.com' } },
    ]);
    expect(drafts).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toMatch(/named no usable source/);
  });

  it('clamps an impossible confidence rather than storing it', () => {
    expect(findingsToEvidenceDrafts([{ ...FINDING, confidence: 4 }]).drafts[0]?.confidence).toBe(1);
    expect(findingsToEvidenceDrafts([{ ...FINDING, confidence: -2 }]).drafts[0]?.confidence).toBe(0);
    expect(findingsToEvidenceDrafts([{ ...FINDING, confidence: Number.NaN }]).drafts[0]?.confidence).toBe(0.5);
  });
});

describe('retrieved evidence entering the state', () => {
  it('is stored as evidence_supported, while model recall is not', () => {
    const state = makeManager();
    const { drafts } = findingsToEvidenceDrafts([FINDING]);

    const retrieved = state.enqueueChanges({ evidence_added: drafts }, {
      origin: 'research',
      message_id: null,
      rationale: 'Returned by a registered research source.',
    });
    state.acceptChanges(retrieved.records.map((record) => record.id));

    const recalled = state.enqueueChanges(
      {
        evidence_added: [
          { ...drafts[0]!, origin: 'model_recall', notes: 'From memory.' },
        ],
      },
      { origin: 'research', message_id: null },
    );
    state.acceptChanges(recalled.records.map((record) => record.id));

    const [first, second] = state.idea!.evidence;
    expect(first?.provenance).toBe('evidence_supported');
    expect(first?.origin).toBe('research_source');
    expect(second?.provenance).toBe('model_suggestion');
    expect(second?.origin).toBe('model_recall');
  });
});

describe('analyzeEvidenceGap', () => {
  function body(): IdeaCaseBody {
    return bodyOf(createIdeaCase({ original_idea: 'A greenhouse.', clock: fixedClock() }));
  }

  it('lists what the idea rests on that nobody has checked', () => {
    const state = body();
    state.requirements.push({
      id: 'req_user',
      text: 'Must run for a week unattended.',
      provenance: 'user_stated',
      origin_operation: 'understand',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'open',
      priority: 'must',
      kind: 'explicit',
    });
    state.assumptions.push({
      id: 'asm_1',
      text: 'Mains power is available.',
      provenance: 'model_inferred',
      origin_operation: 'understand',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'active',
      confidence: 0.5,
      if_false_impact: 'high',
    });
    state.constraints.push({
      id: 'con_dead',
      text: 'An abandoned constraint.',
      provenance: 'model_inferred',
      origin_operation: 'update',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'dropped',
      category: 'other',
      hard: true,
    });
    state.research_items.push(
      researchItem({ id: 'res_low', question: 'Low priority question', priority: 'low' }),
      researchItem({ id: 'res_high', question: 'High priority question', priority: 'high' }),
      researchItem({ id: 'res_done', question: 'Answered', status: 'answered' }),
    );

    const gap = analyzeEvidenceGap(state);
    expect(gap.unsupported.map((item) => item.id)).toEqual(['asm_1']);
    expect(gap.open_research.map((item) => item.id)).toEqual(['res_high', 'res_low']);
    expect(gap.evidence_count).toBe(0);
  });

  it('counts accepted evidence only', () => {
    const state = body();
    const evidence = {
      id: 'evd_1',
      claim: 'A checked claim.',
      source: { title: 'T', locator: 'https://example.com', publisher: null },
      relevance: 'R',
      confidence: 0.9,
      timestamp: '2026-01-01T00:00:00.000Z',
      origin: 'user_supplied' as const,
      status: 'accepted' as const,
      provenance: 'evidence_supported' as const,
      origin_operation: 'user' as const,
      source_message_id: null,
      notes: null,
    };
    state.evidence.push(evidence, { ...evidence, id: 'evd_2', status: 'retracted' as const });
    const gap = analyzeEvidenceGap(state);
    expect(gap.evidence_count).toBe(1);
    // Evidence itself is never listed as an unsupported claim.
    expect(gap.unsupported).toEqual([]);
  });

  it('treats a user decision as grounded, not as an unchecked claim', () => {
    const state = body();
    state.decisions.push({
      id: 'dec_1',
      text: 'Use the passive design.',
      provenance: 'user_decision',
      origin_operation: 'decision',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
      status: 'active',
      rationale: null,
      alternatives_considered: [],
      decided_by: 'user',
    });
    expect(analyzeEvidenceGap(state).unsupported).toEqual([]);
  });
});

describe('the research operation, end to end', () => {
  const researchPlan: TurnPlanInput = TurnPlanSchema.parse({
    operation: 'research',
    classification: 'new_information',
    reasoning_summary: 'Reviewed what the design rests on.',
    user_message: 'Here is what is not evidenced yet.',
    changes: {},
    question: null,
    followups: [],
  });

  function stack(sources: ResearchSource[]) {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession('A drip irrigation controller.');
    state.enqueueChanges(
      {
        research_items_added: [
          { question: 'What flow rate do the emitters deliver?', priority: 'high', rationale: 'Sizes the pump.' },
        ],
      },
      { origin: 'user', message_id: null },
    );

    const research = new ResearchRegistry();
    for (const entry of sources) research.register(entry);

    const provider = new ScriptedProvider({ responses: [{ text: JSON.stringify(researchPlan) }] });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider, { timeout_ms: 2000 }),
      state,
      getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
      research,
    });
    return { state, orchestrator, provider };
  }

  it('looks things up when a source is registered, and proposes what it found', async () => {
    const queries: string[] = [];
    const { state, orchestrator } = stack([
      {
        id: 'datasheets',
        label: 'Datasheets',
        async search(query) {
          queries.push(query);
          return [FINDING];
        },
      },
    ]);

    const result = await orchestrator.runOperation('research');

    expect(queries).toEqual(['What flow rate do the emitters deliver?']);
    const evidence = result.pending.filter((record) => record.kind === 'evidence_added');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.provenance).toBe('evidence_supported');
    expect(result.integrity_notes.join(' ')).toMatch(/Research retrieved 1 finding/);

    state.acceptChanges(result.pending.map((record) => record.id));
    const stored = state.idea?.evidence[0];
    expect(stored?.origin).toBe('research_source');
    expect(stored?.provenance).toBe('evidence_supported');
    expect(stored?.source.locator).toBe('https://example.com/dripper.pdf');
    expect(stored?.claim).toBe(FINDING.claim);
  });

  it('reports a source failure without inventing evidence', async () => {
    const { state, orchestrator } = stack([source('broken', new Error('upstream 503'))]);
    const result = await orchestrator.runOperation('research');

    expect(result.pending.filter((record) => record.kind === 'evidence_added')).toHaveLength(0);
    expect(result.integrity_notes.join(' ')).toMatch(/Research source "broken" failed.*upstream 503/);
    expect(state.idea?.evidence).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('says when a healthy source returned nothing', async () => {
    const { orchestrator } = stack([source('empty', [])]);
    const result = await orchestrator.runOperation('research');
    expect(result.integrity_notes.join(' ')).toMatch(/No findings were returned/);
  });

  it('discards findings that exceed the per-turn evidence limit', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...FINDING,
      claim: `Finding ${index}`,
      source: { ...FINDING.source, locator: `https://example.com/${index}` },
    }));
    const { orchestrator } = stack([source('busy', many)]);
    const result = await orchestrator.runOperation('research');
    expect(result.pending.filter((record) => record.kind === 'evidence_added')).toHaveLength(8);
    expect(result.integrity_notes.join(' ')).toMatch(/4 retrieved finding\(s\) exceeded the per-turn evidence limit/);
  });

  it('does nothing, and invents nothing, when no source is registered', async () => {
    const { state, orchestrator, provider } = stack([]);
    const result = await orchestrator.runOperation('research');
    expect(result.pending.filter((record) => record.kind === 'evidence_added')).toHaveLength(0);
    expect(state.idea?.evidence).toEqual([]);
    const joined = provider.requests[0]!.messages.map((turn) => turn.content).join('\n');
    expect(joined).toMatch(/No automated research source is registered/);
  });
});
