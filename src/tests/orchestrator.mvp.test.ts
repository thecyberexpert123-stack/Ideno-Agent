import { beforeEach, describe, expect, it } from 'vitest';
import { AIRuntime } from '../ai/runtime.js';
import type { CompletionRequest } from '../ai/types.js';
import { Orchestrator } from '../core/orchestrator.js';
import { StateManager } from '../core/state_manager.js';
import { MemoryCaseStore } from '../core/store/memory_store.js';
import type { IdeaCase } from '../core/schemas.js';
import { ScriptedProvider, json } from './support/scripted_provider.js';

/**
 * The MVP success test from the specification, end to end.
 *
 *   "I want to build a small autonomous greenhouse."
 *   "It has to fit on a balcony."
 *   "I don't want cloud connectivity."
 *   "Show me alternative architectures."
 *   "Let's use the second one."
 *
 * The model is scripted, so what is under test is Ideno's own behaviour:
 * extraction routing, impact analysis, non-linear re-entry into exploration,
 * decision recording, versioning and the epistemic guarantees. Model quality
 * is explicitly not what this verifies.
 *
 * Replies are routed by *which turn* they answer rather than by call order,
 * so a test can send the same turns in a different sequence.
 */

const CASE_IDEA = 'I want to build a small autonomous greenhouse.';

function latestUserMessage(request: CompletionRequest): string {
  const content = request.messages.map((message) => message.content).join('\n');
  const section = /# USER MESSAGE \(latest turn\)\n([\s\S]*?)(?:\n\n# |$)/u.exec(content);
  return (section?.[1] ?? '').toLowerCase();
}

function turnKey(request: CompletionRequest): string {
  const message = latestUserMessage(request);
  const turn = message.includes('balcony')
    ? 'balcony'
    : message.includes('cloud')
      ? 'nocloud'
      : message.includes('alternative architectures')
        ? 'alternatives'
        : message.includes('second one')
          ? 'decide'
          : 'initial';
  return `${request.purpose ?? 'unknown'}:${turn}`;
}

/** Pulls item ids of a given prefix out of the structured context we sent. */
function idsFromContext(request: CompletionRequest, prefix: string): string[] {
  const context = request.messages.map((message) => message.content).join('\n');
  const matches = context.matchAll(new RegExp(`\\[(${prefix}-[0-9a-f]{8})\\]`, 'gu'));
  return [...new Set([...matches].map((match) => match[1] as string))];
}

const UNDERSTAND_INITIAL = json({
  turn_intent: 'new_idea',
  intent_summary:
    'You want a small greenhouse that looks after plants on its own, with as little manual intervention as possible.',
  goal: 'Build a small greenhouse that manages watering and climate autonomously.',
  title_suggestion: 'Small autonomous greenhouse',
  phase: 'capturing',
  requirements: [
    {
      text: 'The greenhouse must water plants without manual intervention',
      basis: 'implied',
      rationale: '"Autonomous" implies unattended watering.',
    },
    {
      text: 'The greenhouse must regulate temperature and humidity',
      basis: 'inferred',
      confidence: 0.6,
    },
  ],
  constraints: [
    { text: 'The build must stay small', basis: 'stated', source_quote: 'small autonomous greenhouse' },
  ],
  assumptions: [
    {
      text: 'Mains electricity is available at the installation site',
      basis: 'inferred',
      confidence: 0.5,
    },
    {
      text: 'Remote monitoring happens through a hosted cloud dashboard',
      basis: 'inferred',
      confidence: 0.4,
    },
  ],
  unknowns: [
    {
      text: 'What will be grown, and what are its water and light needs?',
      basis: 'inferred',
      impact: 0.9,
      blocks: ['sizing', 'irrigation'],
    },
  ],
  evidence: [],
  decision: null,
  rejections: [],
  affected_item_ids: [],
  needs_critique: true,
  needs_exploration: false,
  needs_research: false,
});

const UNDERSTAND_BALCONY = json({
  turn_intent: 'add_constraint',
  intent_summary: 'The greenhouse has to fit in a balcony footprint.',
  phase: 'exploring',
  requirements: [],
  constraints: [
    { text: 'Must fit within a balcony footprint', basis: 'stated', source_quote: 'fit on a balcony' },
  ],
  assumptions: [],
  unknowns: [
    {
      text: 'What are the balcony dimensions and its load limit?',
      basis: 'implied',
      impact: 0.85,
      blocks: ['structure', 'sizing'],
    },
  ],
  evidence: [],
  decision: null,
  rejections: [],
  affected_item_ids: [],
  needs_critique: false,
  needs_exploration: false,
  needs_research: false,
});

const UNDERSTAND_NO_CLOUD = json({
  turn_intent: 'add_constraint',
  intent_summary: 'No part of the system may depend on a cloud service.',
  requirements: [],
  constraints: [
    {
      text: 'The system must operate without cloud connectivity',
      basis: 'stated',
      source_quote: "don't want cloud connectivity",
    },
  ],
  assumptions: [],
  unknowns: [],
  evidence: [],
  decision: null,
  rejections: [],
  affected_item_ids: [],
  needs_critique: false,
  needs_exploration: false,
  needs_research: false,
});

const UNDERSTAND_ALTERNATIVES = json({
  turn_intent: 'request_alternatives',
  intent_summary: 'You want to see the architectures that are actually open to you.',
  requirements: [],
  constraints: [],
  assumptions: [],
  unknowns: [],
  evidence: [],
  decision: null,
  rejections: [],
  affected_item_ids: [],
  needs_critique: false,
  needs_exploration: true,
  needs_research: false,
});

/** Resolves "the second one" against the ids present in the structured context. */
const UNDERSTAND_DECIDE = (request: CompletionRequest): string => {
  const alternatives = idsFromContext(request, 'alt');
  return json({
    turn_intent: 'make_decision',
    intent_summary: 'You are going with the second architecture.',
    phase: 'converging',
    requirements: [],
    constraints: [],
    assumptions: [],
    unknowns: [],
    evidence: [],
    decision: {
      question: 'Which control architecture should the greenhouse use?',
      chosen: 'Local microcontroller with an on-device schedule',
      alternative_id: alternatives[1] ?? null,
      source_quote: "Let's use the second one",
    },
    rejections: [],
    affected_item_ids: alternatives.slice(0, 3),
    needs_critique: false,
    needs_exploration: false,
    needs_research: false,
  });
};

const IMPACT_BALCONY = json({
  impacts: [],
  affected_areas: ['structure', 'sizing'],
  newly_relevant_unknowns: [],
  summary: 'A balcony footprint bounds the structure but does not contradict anything recorded so far.',
});

/** Invalidates whichever assumption mentions the cloud dashboard. */
const IMPACT_NO_CLOUD = (request: CompletionRequest): string => {
  const context = request.messages.map((message) => message.content).join('\n');
  const dashboard = /\[(asm-[0-9a-f]{8})\][^\n]*hosted cloud dashboard/u.exec(context)?.[1];
  return json({
    impacts: dashboard
      ? [
          {
            cause_ref: '@n1',
            item_id: dashboard,
            effect: 'invalidates',
            reason: 'A hosted dashboard is a cloud dependency, which is now ruled out.',
          },
        ]
      : [],
    affected_areas: ['control architecture', 'connectivity', 'user interface'],
    newly_relevant_unknowns: [
      {
        text: 'How will you see sensor data and change settings without a cloud dashboard?',
        basis: 'implied',
        impact: 0.75,
        blocks: ['user interface'],
      },
    ],
    summary:
      'Removing cloud connectivity invalidates the hosted dashboard assumption and moves the control architecture on-device.',
  });
};

const IMPACT_DECIDE = json({
  impacts: [],
  affected_areas: ['control architecture'],
  newly_relevant_unknowns: [],
  summary: 'The decision fixes the control architecture; nothing recorded conflicts with it.',
});

const CRITIQUE_INITIAL = json({
  findings: [
    {
      kind: 'missing_requirement',
      text: 'There is no water reservoir strategy, and an autonomous system cannot refill itself',
      severity: 'high',
      related_item_ids: [],
      record_as: 'requirement',
      research_question: null,
    },
    {
      kind: 'unrealistic_assumption',
      text: 'Unattended watering without a failure mode risks flooding or drying out the plants',
      severity: 'high',
      related_item_ids: [],
      record_as: 'open_question',
      impact: 0.8,
    },
  ],
  summary: 'The biggest gaps are the water supply and what happens when a pump or sensor fails unattended.',
});

const EXPLORE_THREE_ARCHITECTURES = json({
  alternatives: [
    {
      summary: 'Passive wicking bed with no electronics',
      approach:
        'A self-watering planter with a reservoir and capillary wicks; no pump, no controller, no power.',
      pros: ['No power needed', 'Almost nothing to fail'],
      cons: ['No climate control', 'Reservoir must be refilled by hand'],
      tradeoffs: ['Simplicity over control'],
      preconditions: ['Plants tolerant of constant moisture'],
      satisfies_constraint_ids: [],
      violates_constraint_ids: [],
      confidence: 0.7,
    },
    {
      summary: 'Local microcontroller with an on-device schedule',
      approach:
        'An ESP32 or similar drives a pump and fan from soil-moisture and temperature sensors, with a local web UI on the device itself.',
      pros: ['No cloud dependency', 'Local UI over Wi-Fi', 'Cheap parts'],
      cons: ['Needs power', 'Firmware must handle sensor failure'],
      tradeoffs: ['More capability for more failure modes'],
      preconditions: ['A power source at the balcony'],
      satisfies_constraint_ids: [],
      violates_constraint_ids: [],
      confidence: 0.75,
    },
    {
      summary: 'Single-board computer running a local automation stack',
      approach:
        'A Raspberry Pi running a local automation server with sensor integrations and local storage.',
      pros: ['Rich local dashboards', 'Easy to extend'],
      cons: ['Much higher idle power', 'More to go wrong outdoors'],
      tradeoffs: ['Flexibility over power budget'],
      preconditions: ['Weatherproof enclosure'],
      satisfies_constraint_ids: [],
      violates_constraint_ids: [],
      confidence: 0.55,
    },
  ],
  adjacent_possibilities: [],
  research_questions: [],
  summary: 'Three architectures that differ in how much computing sits on the balcony.',
});

const EXPLORE_REVISIT = json({
  alternatives: [
    {
      summary: 'Offline-first controller with a local access point',
      approach:
        'The controller serves its own Wi-Fi access point and stores history on an SD card, so nothing leaves the balcony.',
      pros: ['Works with no network at all'],
      cons: ['Manual data export'],
      tradeoffs: ['Autonomy over convenience'],
      preconditions: [],
      satisfies_constraint_ids: [],
      violates_constraint_ids: [],
      confidence: 0.6,
    },
  ],
  adjacent_possibilities: [],
  research_questions: [],
  summary: 'With the cloud ruled out, the viable architectures are the ones that keep state on the device.',
});

function buildScript(): ScriptedProvider {
  return new ScriptedProvider({
    keyFor: turnKey,
    replies: {
      'understand:initial': [UNDERSTAND_INITIAL],
      'understand:balcony': [UNDERSTAND_BALCONY],
      'understand:nocloud': [UNDERSTAND_NO_CLOUD],
      'understand:alternatives': [UNDERSTAND_ALTERNATIVES],
      'understand:decide': [UNDERSTAND_DECIDE],
      'impact:balcony': [IMPACT_BALCONY],
      'impact:nocloud': [IMPACT_NO_CLOUD],
      'impact:decide': [IMPACT_DECIDE],
      'critique:initial': [CRITIQUE_INITIAL],
      'explore:alternatives': [EXPLORE_THREE_ARCHITECTURES],
      'explore:nocloud': [EXPLORE_REVISIT],
    },
  });
}

describe('MVP success test — progressive refinement of an idea', () => {
  let stateManager: StateManager;
  let orchestrator: Orchestrator;
  let ideaCase: IdeaCase;

  beforeEach(async () => {
    stateManager = new StateManager(new MemoryCaseStore());
    orchestrator = new Orchestrator({
      runtime: new AIRuntime({ providers: [buildScript()], maxAttempts: 1 }),
      stateManager,
    });
    ideaCase = await stateManager.createCase(CASE_IDEA);
  });

  async function say(message: string) {
    return orchestrator.runTurn({ caseId: ideaCase.id, message, autoAccept: true });
  }

  it('turns a rough idea into a structured state, then keeps it coherent as it changes', async () => {
    /* ---- 1. the original idea ---- */
    const first = await say(CASE_IDEA);
    let current = first.ideaCase;

    expect(first.plan.stages).toEqual(['understand', 'critique']);
    expect(current.title).toBe('Small autonomous greenhouse');
    expect(current.current_intent).toMatch(/manages watering and climate autonomously/u);
    expect(current.requirements.length).toBeGreaterThanOrEqual(2);
    expect(current.assumptions).toHaveLength(2);
    expect(current.unknowns.length).toBeGreaterThanOrEqual(1);
    expect(current.version_history.at(-1)?.index).toBe(1);

    // Epistemic discipline: a quote the user really wrote is "known"; an idea
    // the model had on its own is only ever a suggestion.
    const smallConstraint = current.constraints.find((item) => item.text.includes('small'));
    expect(smallConstraint?.epistemic_status).toBe('known');
    const climate = current.requirements.find((item) => item.text.includes('temperature'));
    expect(climate?.epistemic_status).toBe('model_suggestion');
    const inferredAssumption = current.assumptions.find((item) => item.text.includes('Mains'));
    expect(inferredAssumption?.epistemic_status).toBe('model_suggestion');

    // Critique findings land in the state, flagged as Ideno's own argument.
    const reservoir = current.requirements.find((item) => item.text.includes('reservoir'));
    expect(reservoir?.epistemic_status).toBe('model_suggestion');
    expect(reservoir?.tags).toContain('missing-requirement');

    // And Ideno asks exactly one question — the highest-impact gap.
    expect(first.question?.text).toMatch(/What will be grown/u);

    /* ---- 2. "It has to fit on a balcony." ---- */
    const second = await say('It has to fit on a balcony.');
    current = second.ideaCase;

    expect(second.plan.stages).toContain('impact');
    const balcony = current.constraints.find((item) => item.text.includes('balcony'));
    expect(balcony).toBeDefined();
    expect(balcony?.epistemic_status).toBe('known');
    expect(balcony?.source_quote).toBe('fit on a balcony');
    expect(current.version_history.at(-1)?.index).toBe(2);

    /* ---- 3. "I don't want cloud connectivity." ---- */
    const third = await say("I don't want cloud connectivity.");
    current = third.ideaCase;

    const noCloud = current.constraints.find((item) => item.text.includes('without cloud'));
    expect(noCloud?.epistemic_status).toBe('known');

    // The architecture changed: the hosted-dashboard assumption is retired,
    // not silently left behind, and the link records what retired it.
    const dashboard = current.assumptions.find((item) => item.text.includes('hosted cloud dashboard'));
    expect(dashboard?.status).toBe('invalidated');
    expect(dashboard?.status_reason).toMatch(/cloud dependency/u);
    expect(
      current.relations.some(
        (relation) => relation.to === dashboard?.id && relation.type === 'contradicts',
      ),
    ).toBe(true);
    expect(current.unknowns.some((item) => item.text.includes('without a cloud dashboard'))).toBe(true);

    /* ---- 4. "Show me alternative architectures." ---- */
    const fourth = await say('Show me alternative architectures.');
    current = fourth.ideaCase;

    expect(fourth.plan.stages).toContain('explore');
    expect(current.alternatives).toHaveLength(3);
    expect(current.alternatives.every((item) => item.epistemic_status === 'model_suggestion')).toBe(true);
    expect(current.alternatives[1]?.approach).toMatch(/ESP32/u);
    expect(fourth.reply).toMatch(/Approaches worth considering/u);

    /* ---- 5. "Let's use the second one." ---- */
    const fifth = await say("Let's use the second one.");
    current = fifth.ideaCase;

    expect(current.decisions).toHaveLength(1);
    const decision = current.decisions[0];
    expect(decision?.epistemic_status).toBe('user_decision');
    expect(decision?.decided_by).toBe('user');
    expect(decision?.alternative_id).toBe(current.alternatives[1]?.id);

    const selected = current.alternatives.filter((item) => item.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.summary).toBe('Local microcontroller with an on-device schedule');
    expect(current.current_state.phase).toBe('converging');

    /* ---- the state is a history, not just a snapshot ---- */
    expect(current.version_history.map((version) => version.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(current.version_history[0]?.label).toMatch(/original idea/u);
    expect(current.version_history.at(-1)?.operations.length).toBeGreaterThan(0);
    expect(current.changesets.every((changeset) => changeset.status !== 'pending')).toBe(true);
  });

  it('re-enters exploration on its own when a new constraint invalidates part of the design', async () => {
    await say(CASE_IDEA);
    await say('It has to fit on a balcony.');
    await say('Show me alternative architectures.');

    // Alternatives now exist. A constraint that invalidates an assumption must
    // send Ideno back through exploration without being asked.
    const outcome = await say("I don't want cloud connectivity.");

    expect(outcome.plan.stages).toContain('explore_revisit');
    expect(outcome.plan.reasons.join(' ')).toMatch(/invalidated/u);
    expect(
      outcome.ideaCase.alternatives.some((item) => item.summary.includes('local access point')),
    ).toBe(true);
  });

  it('leaves changes pending for review by default and applies only what is accepted', async () => {
    const outcome = await orchestrator.runTurn({ caseId: ideaCase.id, message: CASE_IDEA });

    expect(outcome.changeset?.status).toBe('pending');
    expect(outcome.ideaCase.requirements).toHaveLength(0);
    expect(outcome.reply).toMatch(/Review it in the panel/u);

    const changeset = outcome.changeset;
    if (!changeset) throw new Error('expected a changeset');

    const constraintEntry = changeset.entries.find(
      (entry) => entry.operation.op === 'add' && entry.operation.collection === 'constraints',
    );
    expect(constraintEntry).toBeDefined();

    const decided = await stateManager.decideChangeSet(ideaCase.id, changeset.id, {
      acceptedEntryIds: [constraintEntry?.id as string],
    });

    expect(decided.changeset.status).toBe('partially_accepted');
    expect(decided.ideaCase.constraints).toHaveLength(1);
    expect(decided.ideaCase.requirements).toHaveLength(0);
    expect(decided.version?.index).toBe(1);
    expect(
      decided.changeset.entries.filter((entry) => entry.status === 'rejected').length,
    ).toBeGreaterThan(0);
  });
});
