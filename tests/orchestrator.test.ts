import { describe, expect, it } from 'vitest';

import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { fixedClock } from '../src/core/ids.js';
import { AIError } from '../src/ai/errors.js';
import { AIRuntime } from '../src/ai/runtime/runtime.js';
import { ScriptedProvider, type ScriptedResponder, type ScriptedResponse } from '../src/ai/providers/scripted.js';
import { ResearchRegistry } from '../src/research/evidence.js';
import { TurnPlanSchema, type TurnPlanInput } from '../src/core/schemas/index.js';
import { SettingsSchema, type Settings } from '../src/ai/settings.js';
import {
  DEMO_MESSAGES,
  greenhouseResponder,
  turnAlternatives,
  turnBalcony,
  turnDecision,
  turnNoCloud,
  turnUnderstand,
  createLookup,
} from '../src/demo/greenhouse.js';

interface Stack {
  state: StateManager;
  provider: ScriptedProvider;
  orchestrator: Orchestrator;
  settings: Settings;
}

function makeStack(
  responses: ScriptedResponse[] | ScriptedResponder,
  settingsOverride: Partial<Settings> = {},
): Stack {
  const settings = SettingsSchema.parse({ provider_id: 'scripted', ...settingsOverride });
  const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
  const provider = new ScriptedProvider({ responses });
  const runtime = new AIRuntime(provider, { temperature: 0.2, timeout_ms: 2000, max_attempts: 2 });
  const orchestrator = new Orchestrator({
    runtime,
    state,
    getSettings: () => settings,
    research: new ResearchRegistry(),
  });
  return { state, provider, orchestrator, settings };
}

function planStack(plans: (TurnPlanInput | string)[], settings?: Partial<Settings>): Stack {
  return makeStack(
    plans.map((plan) => ({ text: typeof plan === 'string' ? plan : JSON.stringify(plan) })),
    settings,
  );
}

function acceptEverything(state: StateManager): number {
  const pending = state.pendingChanges();
  if (pending.length === 0) return 0;
  state.acceptChanges(pending.map((record) => record.id));
  return pending.length;
}

function minimalPlan(overrides: Partial<TurnPlanInput> = {}): TurnPlanInput {
  return TurnPlanSchema.parse({
    operation: 'update',
    classification: 'new_information',
    reasoning_summary: 'Test plan.',
    user_message: 'Recorded.',
    changes: {},
    question: null,
    followups: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The MVP acceptance scenario, end to end
// ---------------------------------------------------------------------------

describe('MVP scenario: small autonomous greenhouse', () => {
  it('runs all five steps through the real orchestrator and state manager', async () => {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const provider = new ScriptedProvider({ responses: greenhouseResponder(state) });
    const runtime = new AIRuntime(provider, { temperature: 0.2, timeout_ms: 2000 });
    const orchestrator = new Orchestrator({
      runtime,
      state,
      getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
      research: new ResearchRegistry(),
    });

    expect(DEMO_MESSAGES).toHaveLength(5);

    // 1. "I want to build a small autonomous greenhouse."
    const first = await orchestrator.processMessage(DEMO_MESSAGES[0]!);
    expect(first.failures).toEqual([]);
    expect(first.operations).toEqual(['understand']);
    expect(state.idea?.original_idea).toBe(DEMO_MESSAGES[0]);
    // The one requirement grounded in the user's own words applied immediately.
    expect(state.idea?.requirements.map((item) => item.text)).toContain(
      'Operate for days at a time without the user intervening.',
    );
    // Everything Ideno inferred is waiting for the human, including its restatement
    // of the goal: a paraphrase is a claim, not a fact.
    expect(first.pending.length).toBeGreaterThan(5);
    expect(first.question?.text).toMatch(/indoors, on a balcony, or in a garden/);
    expect(first.entries.map((entry) => entry.role)).toEqual(['user', 'ideno']);
    // The derived title drops the sentence's full stop; the original idea does not.
    expect(state.idea?.title).toBe('I want to build a small autonomous greenhouse');
    acceptEverything(state);
    expect(state.idea?.title).toBe('Small autonomous greenhouse');
    expect(state.idea?.current_intent).toMatch(/self-managing greenhouse/);
    expect(state.idea?.unknowns.length).toBe(3);
    expect(state.idea?.assumptions.length).toBe(3);
    expect(state.idea?.current_state).toBe('structuring');

    // 2. "It has to fit on a balcony."
    const second = await orchestrator.processMessage(DEMO_MESSAGES[1]!);
    expect(second.failures).toEqual([]);
    expect(second.entries[1]?.classification).toBe('new_information');
    const balcony = state.idea?.constraints.find((item) => item.text.includes('balcony footprint'));
    expect(balcony?.provenance).toBe('user_stated');
    expect(balcony?.hard).toBe(true);
    expect(balcony?.category).toBe('physical');
    expect(second.question?.text).toMatch(/outdoor power outlet/);
    // Ideno's reading of what the balcony fact *invalidates* is an inference, so it
    // waits for review before touching the state.
    const supersededPending = state.pendingChanges().find((record) => record.kind === 'item_invalidated');
    expect(supersededPending).toBeTruthy();
    acceptEverything(state);
    // The vague constraint the balcony fact replaced was invalidated, not left standing.
    const superseded = state.idea?.constraints.find((item) => item.text.includes('domestic setting'));
    expect(superseded?.status).toBe('dropped');
    expect(superseded?.notes).toMatch(/superseded/i);
    // The placement unknown was resolved by the answer.
    expect(state.idea?.unknowns.find((item) => item.text.includes('Where will it be placed'))?.status).toBe(
      'resolved',
    );

    // 3. "I don't want cloud connectivity." — an architecture change.
    const third = await orchestrator.processMessage(DEMO_MESSAGES[2]!);
    expect(third.failures).toEqual([]);
    expect(third.entries[1]?.classification).toBe('revision');
    const noCloud = state.idea?.constraints.find((item) => item.text.includes('without cloud connectivity'));
    expect(noCloud?.provenance).toBe('user_stated');
    expect(noCloud?.category).toBe('connectivity');
    // The architectural consequences are inferences, so they queue for review:
    // invalidating an assumption is exactly the kind of judgement a human should see.
    expect(state.pendingChanges().some((record) => record.kind === 'item_invalidated')).toBe(true);
    expect(state.pendingChanges().some((record) => record.kind === 'finding_added')).toBe(true);
    acceptEverything(state);
    // The assumption the constraint contradicts was revisited, not ignored.
    const cloudAssumption = state.idea?.assumptions.find((item) =>
      item.text.includes('cloud or phone-based control path'),
    );
    expect(cloudAssumption?.status).toBe('invalidated');
    expect(cloudAssumption?.notes).toMatch(/ruled out cloud connectivity/i);
    // The hidden dependency is recorded as a finding with a recommendation.
    const finding = state.idea?.findings.find((item) => item.kind === 'hidden_dependency');
    expect(finding?.severity).toBe('major');
    expect(finding?.recommendation).toMatch(/local interface/);
    expect(finding?.related_ids).toContain(cloudAssumption?.id);
    expect(state.idea?.current_state).toBe('structuring');

    // 4. "Show me alternative architectures."
    const fourth = await orchestrator.processMessage(DEMO_MESSAGES[3]!);
    expect(fourth.failures).toEqual([]);
    expect(fourth.entries[1]?.classification).toBe('request_alternatives');
    // Proposing an architecture is a suggestion, so all three wait for review.
    expect(fourth.applied).toHaveLength(0);
    expect(fourth.pending.filter((record) => record.kind === 'alternative_added')).toHaveLength(3);
    acceptEverything(state);
    expect(state.idea?.alternatives).toHaveLength(3);
    const names = state.idea?.alternatives.map((item) => item.name) ?? [];
    expect(names).toEqual([
      'Passive solar with wicking beds',
      'Battery-powered sensor node with local scheduler',
      'Mains-powered cabinet controller',
    ]);
    // Alternatives are grounded in the recorded constraints, by id.
    const balconyId = state.idea?.constraints.find((item) => item.text.includes('balcony footprint'))?.id;
    expect(state.idea?.alternatives[1]?.addresses).toContain(balconyId);
    // And they carry a structured, renderer-independent component graph.
    const spec = state.idea?.alternatives[1]?.spec;
    expect(spec?.objects.length).toBeGreaterThan(4);
    expect(spec?.connections.some((link) => link.kind === 'fluid')).toBe(true);
    expect(spec?.constraints).toContainEqual({ key: 'cloud_connectivity', value: false });
    // Exploring does not interrogate: no question was asked.
    expect(fourth.question).toBeNull();
    expect(state.idea?.current_state).toBe('exploring');

    // 5. "Let's use the second one."
    const fifth = await orchestrator.processMessage(DEMO_MESSAGES[4]!);
    expect(fifth.failures).toEqual([]);
    expect(fifth.entries[1]?.classification).toBe('decision');
    const chosen = state.idea?.alternatives[1]!;
    expect(state.idea?.selected_alternative_id).toBe(chosen.id);
    expect(chosen.status).toBe('selected');
    const decision = state.idea?.decisions[0];
    expect(decision?.decided_by).toBe('user');
    expect(decision?.provenance).toBe('user_decision');
    expect(decision?.alternatives_considered).toContain(chosen.id);
    // The other two are remembered as rejected, with reasons. Rejecting them was
    // the user's act, so those records applied without a further click.
    expect(state.idea?.rejected_approaches.map((item) => item.name)).toEqual([
      'Passive solar with wicking beds',
      'Mains-powered cabinet controller',
    ]);
    expect(state.idea?.rejected_approaches[0]?.rejected_by).toBe('user');
    expect(fifth.pending.some((record) => record.kind === 'item_invalidated')).toBe(true);
    acceptEverything(state);
    // The decision invalidated the mains-power assumption and deferred the outlet unknown.
    expect(state.idea?.assumptions.find((item) => item.text.includes('Mains electricity'))?.status).toBe(
      'invalidated',
    );
    expect(state.idea?.unknowns.find((item) => item.text.includes('outdoor power outlet'))?.status).toBe(
      'deferred',
    );
    // A decision was recorded and an alternative selected, but two high-impact
    // unknowns are still open (balcony dimensions, runtime between charges), so
    // the derived phase is "refining" rather than "decided". The phase is computed
    // from the data, which is exactly why it is not allowed to claim completion.
    expect(state.idea?.current_state).toBe('refining');
    expect(state.idea?.decisions).toHaveLength(1);

    // The idea became progressively more precise, and every step is versioned.
    const history = state.versions();
    expect(history.length).toBeGreaterThanOrEqual(6);
    expect(history[0]?.summary).toBe('Original idea');
    expect(history.every((version, index) => version.number === index)).toBe(true);
    expect(history.every((version) => version.parent_id === (history[version.number - 1]?.id ?? null))).toBe(
      true,
    );
    expect(state.transcript().filter((entry) => entry.role === 'user')).toHaveLength(5);
    expect(state.transcript().filter((entry) => entry.role === 'ideno')).toHaveLength(5);
    expect(provider.callCount).toBe(5);
  });

  it('produces five demo turns that all satisfy the output contract', () => {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession(DEMO_MESSAGES[0]!);
    const lookup = createLookup(state);
    const plans = [turnUnderstand(), turnBalcony(lookup), turnNoCloud(lookup), turnAlternatives(lookup), turnDecision(lookup)];
    for (const plan of plans) {
      expect(TurnPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it('keeps working when the script runs out, without inventing more state', async () => {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const provider = new ScriptedProvider({ responses: greenhouseResponder(state) });
    const runtime = new AIRuntime(provider, { timeout_ms: 2000 });
    const orchestrator = new Orchestrator({
      runtime,
      state,
      getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
    });
    for (const message of DEMO_MESSAGES) await orchestrator.processMessage(message);
    acceptEverything(state);
    const versionsBefore = state.versions().length;

    const extra = await orchestrator.processMessage('And now?');
    expect(extra.failures).toEqual([]);
    expect(extra.entries[1]?.classification).toBe('out_of_scope');
    expect(extra.changes).toHaveLength(0);
    expect(state.versions()).toHaveLength(versionsBefore);
  });
});

// ---------------------------------------------------------------------------
// Loop behaviour
// ---------------------------------------------------------------------------

describe('the loop', () => {
  it('runs a follow-up operation against the state the first one produced', async () => {
    const first = minimalPlan({
      operation: 'understand',
      classification: 'new_idea',
      changes: { constraints_added: [{ text: 'Must be silent.', provenance: 'user_stated' }] },
      followups: ['critique'],
    });
    const second = minimalPlan({
      operation: 'critique',
      changes: {
        findings_added: [
          { text: 'Silent operation rules out most pumps.', kind: 'limitation', severity: 'major' },
        ],
      },
    });
    const stack = planStack([first, second]);

    const result = await stack.orchestrator.processMessage('A quiet pump for a bedroom.');
    expect(result.operations).toEqual(['understand', 'critique']);
    expect(result.entries.filter((entry) => entry.role === 'ideno')).toHaveLength(2);
    expect(stack.provider.callCount).toBe(2);

    acceptEverything(stack.state);
    expect(stack.state.idea?.findings[0]?.origin_operation).toBe('critique');
    // The second call saw the constraint the first one added.
    const secondRequest = stack.provider.requests[1]!;
    const digest = secondRequest.messages.map((turn) => turn.content).join('\n');
    expect(digest).toContain('Must be silent.');
  });

  it('does not run the same operation twice in one turn', async () => {
    const stack = planStack([
      minimalPlan({ operation: 'understand' }),
      minimalPlan({ operation: 'critique', followups: ['critique'] }),
      minimalPlan(),
    ]);
    await stack.orchestrator.processMessage('A rocket stove.');
    const result = await stack.orchestrator.runOperation('critique');
    expect(result.operations).toEqual(['critique']);
    expect(stack.provider.callCount).toBe(2);
  });

  it('stops at the operation budget even if the model keeps asking for more', async () => {
    const plans = [
      minimalPlan({ followups: ['critique'] }),
      minimalPlan({ operation: 'critique', followups: ['explore'] }),
      minimalPlan({ operation: 'explore', followups: ['research'] }),
      minimalPlan({ operation: 'research' }),
    ];
    const stack = planStack(plans);
    const result = await stack.orchestrator.processMessage('An idea.');
    expect(result.operations).toHaveLength(3);
    expect(stack.provider.callCount).toBe(3);
  });

  it('starts with understand on a raw idea and update once structure exists', async () => {
    const stack = planStack([
      minimalPlan({
        operation: 'understand',
        changes: { constraints_added: [{ text: 'Must survive salt water.', provenance: 'user_stated' }] },
      }),
      minimalPlan(),
    ]);
    await stack.orchestrator.processMessage('A tidal pump.');
    expect(stack.provider.requests[0]?.task).toBe('understand');
    await stack.orchestrator.processMessage('It must survive salt water.');
    expect(stack.provider.requests[1]?.task).toBe('update');
  });

  it('creates the session from the first message, with that message as v0', async () => {
    const stack = planStack([minimalPlan({ operation: 'understand' })]);
    expect(stack.state.hasSession).toBe(false);
    await stack.orchestrator.processMessage('  A compost heater.  ');
    expect(stack.state.idea?.original_idea).toBe('A compost heater.');
    expect(stack.state.versions()[0]?.trigger).toBe('initial');
    expect(stack.state.transcript()[0]?.role).toBe('user');
  });

  it('refuses an empty message rather than calling a model', async () => {
    const stack = planStack([minimalPlan()]);
    await expect(stack.orchestrator.processMessage('   ')).rejects.toThrowError(/empty message/);
    expect(stack.provider.callCount).toBe(0);
  });

  it('refuses to run two turns at once', async () => {
    const stack = planStack([minimalPlan(), minimalPlan()]);
    const first = stack.orchestrator.processMessage('One.');
    await expect(stack.orchestrator.processMessage('Two.')).rejects.toThrowError(/already working/);
    await first;
  });

  it('runs a toolbar operation with no new user message', async () => {
    const stack = planStack([minimalPlan({ operation: 'understand' }), minimalPlan({ operation: 'explore' })]);
    await stack.orchestrator.processMessage('A rocket stove.');
    const result = await stack.orchestrator.runOperation('explore');
    expect(result.operations).toEqual(['explore']);
    expect(result.entries[0]?.role).toBe('system');
    expect(result.entries[0]?.text).toMatch(/Exploration of alternatives requested/);
    expect(stack.state.transcript().filter((entry) => entry.role === 'user')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Questioning discipline
// ---------------------------------------------------------------------------

describe('questioning discipline', () => {
  it('passes a high-impact question through and records that it was asked', async () => {
    const stack = planStack([
      minimalPlan({
        question: {
          text: 'How many plants must it support?',
          why_it_matters: 'It sizes everything.',
          impact: 'high',
          unknown_id: null,
        },
        changes: {
          open_questions_added: [{ question: 'How many plants must it support?', target: 'user', impact: 'high' }],
        },
      }),
    ]);
    await stack.orchestrator.processMessage('A plant watering system.');
    acceptEverything(stack.state);
    expect(stack.state.idea?.open_questions[0]?.status).toBe('asked');
    expect(stack.state.transcript()[1]?.question?.text).toMatch(/How many plants/);
  });

  it('suppresses a low-impact question instead of interrogating the user', async () => {
    const stack = planStack([
      minimalPlan({
        question: { text: 'What colour should it be?', why_it_matters: 'Aesthetics.', impact: 'low', unknown_id: null },
      }),
    ]);
    const result = await stack.orchestrator.processMessage('A plant watering system.');
    expect(result.question).toBeNull();
    expect(result.integrity_notes.join(' ')).toMatch(/low impact/);
    expect(stack.state.transcript()[1]?.question).toBeNull();
  });

  it('does not ask the same question twice', async () => {
    const question = {
      text: 'How many plants?',
      why_it_matters: 'Sizing.',
      impact: 'high' as const,
      unknown_id: null,
    };
    const stack = planStack([
      minimalPlan({ question, changes: { open_questions_added: [{ question: question.text, target: 'user', impact: 'high' }] } }),
      minimalPlan({ question }),
    ]);
    const first = await stack.orchestrator.processMessage('A watering system.');
    acceptEverything(stack.state);
    const second = await stack.orchestrator.processMessage('It should be cheap.');
    expect(first.question?.text).toBe('How many plants?');
    expect(second.question).toBeNull();
    expect(second.integrity_notes.join(' ')).toMatch(/already asked/);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('failure handling', () => {
  it('changes nothing when the model returns prose instead of JSON', async () => {
    const prose = 'Sure! Here are some thoughts about your greenhouse idea, in plain prose.';
    // Two responses: the runtime spends one attempt, then one repair round-trip.
    const stack = planStack([prose, prose]);
    const result = await stack.orchestrator.processMessage('A greenhouse.');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('malformed_response');
    expect(result.failures[0]?.raw_text).toMatch(/plain prose/);
    expect(result.operations).toEqual([]);
    expect(stack.state.idea?.requirements).toEqual([]);
    expect(stack.state.versions()).toHaveLength(1); // only v0
    // The human still sees what the model said, clearly marked as unusable.
    const system = stack.state.transcript().find((entry) => entry.role === 'system');
    expect(system?.error_code).toBe('malformed_response');
    expect(system?.text).toMatch(/plain prose/);
  });

  it('recovers when the second attempt is valid', async () => {
    const stack = planStack([
      '{"operation": "update", "changes": {',
      JSON.stringify(
        minimalPlan({ changes: { constraints_added: [{ text: 'Must be portable.', provenance: 'user_stated' }] } }),
      ),
    ]);
    const result = await stack.orchestrator.processMessage('A portable greenhouse.');
    expect(result.failures).toEqual([]);
    expect(result.integrity_notes.join(' ')).toMatch(/corrected one was accepted/);
    expect(stack.provider.callCount).toBe(2);
    expect(stack.state.idea?.constraints[0]?.text).toBe('Must be portable.');
  });

  it('extracts JSON wrapped in prose and a code fence', async () => {
    const wrapped = `Here is the update:\n\`\`\`json\n${JSON.stringify(
      minimalPlan({ changes: { constraints_added: [{ text: 'Must fold flat.', provenance: 'user_stated' }] } }),
    )}\n\`\`\`\nHope that helps.`;
    const stack = planStack([wrapped]);
    const result = await stack.orchestrator.processMessage('A folding greenhouse.');
    expect(result.failures).toEqual([]);
    expect(stack.state.idea?.constraints[0]?.text).toBe('Must fold flat.');
  });

  it('reports a validation failure precisely and keeps the state intact', async () => {
    const invalid = { ...minimalPlan(), changes: { constraints_added: [{ text: '' }] }, user_message: '' };
    const stack = planStack([JSON.stringify(invalid), JSON.stringify(invalid)]);
    const result = await stack.orchestrator.processMessage('A greenhouse.');
    expect(result.failures[0]?.code).toBe('malformed_response');
    expect(stack.state.transcript().at(-1)?.text).toMatch(/Validation:/);
    expect(stack.state.idea?.constraints).toEqual([]);
  });

  it('reports an empty response', async () => {
    const stack = makeStack([{ text: '' }, { text: '' }]);
    const result = await stack.orchestrator.processMessage('A greenhouse.');
    expect(result.failures[0]?.code).toBe('empty_response');
    expect(result.operations).toEqual([]);
  });

  it('reports a timeout and does not apply a late answer', async () => {
    const stack = makeStack([{ text: JSON.stringify(minimalPlan()), delay_ms: 400 }]);
    const runtime = new AIRuntime(stack.provider, { timeout_ms: 50 });
    const orchestrator = new Orchestrator({
      runtime,
      state: stack.state,
      getSettings: () => stack.settings,
    });
    const result = await orchestrator.processMessage('A greenhouse.');
    expect(result.failures[0]?.code).toBe('timeout');
    expect(result.failures[0]?.hint).toMatch(/took too long/);
    expect(stack.state.versions()).toHaveLength(1);
  });

  it('reports a provider failure with its own message', async () => {
    const stack = makeStack([
      { error: new AIError('rate_limited', 'Too many requests.', { status: 429 }) },
    ]);
    const result = await stack.orchestrator.processMessage('A greenhouse.');
    expect(result.failures[0]?.code).toBe('rate_limited');
    expect(result.failures[0]?.hint).toMatch(/rate limiting/);
  });

  it('does not call the model at all when the provider is unavailable', async () => {
    const provider = new ScriptedProvider({
      responses: [{ text: JSON.stringify(minimalPlan()) }],
      availability: { available: false, action: 'configure', reason: 'No provider is configured.' },
    });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider),
      state,
      getSettings: () => SettingsSchema.parse({}),
    });
    const result = await orchestrator.processMessage('A greenhouse.');
    expect(result.failures[0]?.code).toBe('provider_unavailable');
    expect(result.failures[0]?.message).toMatch(/No provider is configured/);
    expect(provider.callCount).toBe(0);
    // The idea and the user's message still exist; nothing was lost.
    expect(state.idea?.original_idea).toBe('A greenhouse.');
    expect(state.transcript()).toHaveLength(2);
  });

  it('tries an interactive sign-in when that is all that is missing', async () => {
    let signedIn = false;
    const provider = new ScriptedProvider({
      responses: [{ text: JSON.stringify(minimalPlan()) }],
      availability: () =>
        signedIn ? { available: true } : { available: false, action: 'sign_in', reason: 'Sign in first.' },
      sign_in: async () => {
        signedIn = true;
        return { available: true };
      },
    });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider),
      state,
      getSettings: () => SettingsSchema.parse({}),
    });
    const result = await orchestrator.processMessage('A greenhouse.');
    expect(result.failures).toEqual([]);
    expect(provider.callCount).toBe(1);
  });

  it('stops the turn after a failure instead of running follow-ups', async () => {
    const stack = makeStack([
      { text: JSON.stringify(minimalPlan({ followups: ['critique'] })) },
      // The follow-up fails on both its attempt and its repair round-trip.
      { text: 'not json at all' },
      { text: 'still not json' },
    ]);
    const result = await stack.orchestrator.processMessage('A greenhouse.');
    expect(result.operations).toEqual(['understand']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('malformed_response');
    expect(stack.provider.callCount).toBe(3);
  });

  it('rejects a plan that breaks the contract before it can reach the state', async () => {
    // A 5000-character title violates ShortTextSchema, so the whole plan is
    // refused: an over-long field must not be silently truncated into the state.
    const oversized = JSON.stringify({ ...minimalPlan(), changes: { title: 'x'.repeat(5000) } });
    const provider = new ScriptedProvider({ responses: [{ text: oversized }, { text: oversized }] });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession('A greenhouse.');
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider),
      state,
      getSettings: () => SettingsSchema.parse({}),
    });
    // The plan itself is rejected by the contract before it can reach the state.
    const result = await orchestrator.processMessage('A greenhouse with a very long title.');
    expect(result.failures[0]?.code).toBe('malformed_response');
    expect(state.idea?.title).toBe('A greenhouse');
  });
});

// ---------------------------------------------------------------------------
// Context sent to the model
// ---------------------------------------------------------------------------

describe('model context', () => {
  it('sends the structured state, not a transcript dump', async () => {
    const stack = planStack([minimalPlan({ operation: 'understand' }), minimalPlan()]);
    await stack.orchestrator.processMessage('A greenhouse.');
    acceptEverything(stack.state);
    await stack.orchestrator.processMessage('It must fit on a balcony.');

    const request = stack.provider.requests[1]!;
    const joined = request.messages.map((turn) => turn.content).join('\n');
    expect(joined).toContain('## CURRENT IDEA STATE');
    expect(joined).toContain('"phase"');
    expect(joined).toContain('A greenhouse.');
    expect(joined).toContain('## PENDING REVIEW');
    expect(joined).toContain('## THE HUMAN\'S LATEST MESSAGE');
    expect(request.messages[0]?.role).toBe('system');
    expect(request.messages[0]?.content).toContain('You are Ideno');
    // The last turn carries the output contract closest to generation.
    expect(request.messages.at(-1)?.content).toContain('OUTPUT CONTRACT');
  });

  it('bounds the conversation window to the configured number of turns', async () => {
    const plans = Array.from({ length: 6 }, () => minimalPlan());
    const stack = planStack(plans, { context_transcript_turns: 2 });
    for (const message of ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']) {
      await stack.orchestrator.processMessage(message);
    }
    const last = stack.provider.requests.at(-1)!;
    // system, <bounded history>, task block, output contract.
    expect(last.messages.map((turn) => turn.role)).toEqual(['system', 'user', 'assistant', 'user', 'user']);
    expect(last.messages[1]?.content).toBe('Five.');
    expect(last.messages[2]?.content).toBe('Recorded.');
    // Earlier turns are gone from the window; the state digest still carries the
    // original idea, because the state — not the transcript — is the memory.
    expect(last.messages[3]?.content).toContain('"original_idea": "One."');
  });

  it('tells the model when no research source is registered', async () => {
    const stack = planStack([minimalPlan({ operation: 'understand' }), minimalPlan({ operation: 'research' })]);
    await stack.orchestrator.processMessage('A greenhouse.');
    await stack.orchestrator.runOperation('research');
    const joined = stack.provider.requests.at(-1)!.messages.map((turn) => turn.content).join('\n');
    expect(joined).toMatch(/No automated research source is registered/);
    expect(joined).toMatch(/model_recall/);
  });

  it('lists pending changes so the model does not propose them again', async () => {
    const stack = planStack([
      minimalPlan({ changes: { constraints_added: [{ text: 'Must be quiet.', provenance: 'model_inferred' }] } }),
      minimalPlan(),
    ]);
    await stack.orchestrator.processMessage('A quiet greenhouse.');
    expect(stack.state.pendingChanges()).toHaveLength(1);
    await stack.orchestrator.processMessage('And small.');
    const joined = stack.provider.requests.at(-1)!.messages.map((turn) => turn.content).join('\n');
    expect(joined).toContain('Must be quiet.');
    expect(joined).toMatch(/awaiting the human's review/);
  });
});

// ---------------------------------------------------------------------------
// Turn isolation and the research loop
// ---------------------------------------------------------------------------

describe('a turn is bound to the idea it started in', () => {
  it('aborts instead of writing into an idea opened mid-turn', async () => {
    const settings = SettingsSchema.parse({ provider_id: 'scripted' });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    // A deferred response: the model answers whenever the test says so, which is
    // the only way to get an idea opened *during* a turn rather than before it.
    let resolveResponse!: (value: ScriptedResponse) => void;
    const pending = new Promise<ScriptedResponse>((resolve) => {
      resolveResponse = resolve;
    });
    const responder: ScriptedResponder = () => pending;
    const provider = new ScriptedProvider({ responses: responder });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider, { timeout_ms: 5000 }),
      state,
      getSettings: () => settings,
      research: new ResearchRegistry(),
    });

    const turn = orchestrator.processMessage('I want to build a tide pool.');
    // Let the turn reach the model call, then open a different idea behind its back.
    await new Promise((resolve) => setTimeout(resolve, 20));
    state.startSession('A completely different idea.');
    resolveResponse({
      text: JSON.stringify(
        minimalPlan({
          changes: { constraints_added: [{ text: 'Must be tidal.', provenance: 'user_stated' }] },
        }),
      ),
    });

    const result = await turn;
    expect(result.failures.map((failure) => failure.code)).toContain('state_session_changed');
    // The idea that was opened mid-turn is untouched: no constraint, no turn entries.
    expect(state.idea?.original_idea).toBe('A completely different idea.');
    expect(state.idea?.constraints).toHaveLength(0);
  });
});

describe('research closes the loop', () => {
  it('marks a question answered once a source returned findings for it', async () => {
    const settings = SettingsSchema.parse({ provider_id: 'scripted' });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession('A greenhouse.');
    state.enqueueChanges(
      {
        research_items_added: [
          { question: 'What water volume do these plants need per day?', priority: 'high' },
        ],
      },
      { origin: 'research', message_id: null },
    );
    acceptEverything(state);
    expect(state.idea?.research_items[0]?.status).toBe('open');

    const research = new ResearchRegistry();
    research.register({
      id: 'stub',
      label: 'Stub source',
      async search(query) {
        return [
          {
            claim: `Retrieved an answer for: ${query}`,
            source: { title: 'A real page', locator: 'https://example.org/page', publisher: 'Example' },
            relevance: 'Directly answers the question.',
            confidence: 0.7,
            retrieved_at: '2026-03-01T00:00:00.000Z',
          },
        ];
      },
    });

    const provider = new ScriptedProvider({
      responses: [{ text: JSON.stringify(minimalPlan({ operation: 'research' })) }],
    });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider, { timeout_ms: 5000 }),
      state,
      getSettings: () => settings,
      research,
    });

    const result = await orchestrator.runOperation('research');
    expect(result.failures).toEqual([]);
    // The retrieved finding is proposed as evidence, and the question is closed.
    expect(result.integrity_notes.join(' ')).toMatch(/Research retrieved 1 finding/);
    acceptEverything(state);

    expect(state.idea?.research_items[0]?.status).toBe('answered');
    expect(state.idea?.evidence).toHaveLength(1);
    expect(state.idea?.evidence[0]?.origin).toBe('research_source');
    expect(state.idea?.evidence[0]?.provenance).toBe('evidence_supported');
  });

  it('leaves a question open when the source returned nothing usable', async () => {
    const settings = SettingsSchema.parse({ provider_id: 'scripted' });
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession('A greenhouse.');
    state.enqueueChanges(
      { research_items_added: [{ question: 'Does this need a permit?', priority: 'medium' }] },
      { origin: 'research', message_id: null },
    );
    acceptEverything(state);

    const research = new ResearchRegistry();
    research.register({
      id: 'empty',
      label: 'Source that finds nothing',
      async search() {
        // A finding with no locator is not evidence, and must not be dressed up.
        return [{ claim: 'Something.', source: { title: '', locator: '' }, relevance: 'Maybe.', confidence: 0.4 }];
      },
    });

    const provider = new ScriptedProvider({
      responses: [{ text: JSON.stringify(minimalPlan({ operation: 'research' })) }],
    });
    const orchestrator = new Orchestrator({
      runtime: new AIRuntime(provider, { timeout_ms: 5000 }),
      state,
      getSettings: () => settings,
      research,
    });

    const result = await orchestrator.runOperation('research');
    expect(result.integrity_notes.join(' ')).toMatch(/named no usable source/);
    acceptEverything(state);
    // Still open: nothing was retrieved, so nothing was answered.
    expect(state.idea?.research_items[0]?.status).toBe('open');
    expect(state.idea?.evidence).toHaveLength(0);
  });
});
