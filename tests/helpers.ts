/**
 * Shared test helpers. Kept out of `*.test.ts` so Vitest does not treat this
 * file as a suite.
 */
import { MemoryStore, type Store } from '../src/core/state_manager/store.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { Orchestrator } from '../src/core/orchestrator/orchestrator.js';
import { AIRuntime } from '../src/ai/runtime/runtime.js';
import { ScriptedProvider } from '../src/ai/providers/scripted.js';
import { ResearchRegistry } from '../src/research/evidence.js';
import { SettingsSchema } from '../src/ai/settings.js';
import { DEMO_MESSAGES, greenhouseResponder } from '../src/demo/greenhouse.js';
import { fixedClock } from '../src/core/ids.js';
import type { ChangeSetInput } from '../src/core/schemas/index.js';

export const SEED_IDEA = 'I want to build a small autonomous greenhouse.';

export interface ManagerOptions {
  store?: Store;
  start?: string;
  stepMs?: number;
  idea?: string;
}

/** A StateManager with a deterministic clock and in-memory storage. */
export function makeManager(options: ManagerOptions = {}): StateManager {
  const manager = new StateManager({
    store: options.store ?? new MemoryStore(),
    clock: fixedClock(options.start ?? '2026-01-01T00:00:00.000Z', options.stepMs ?? 1000),
    persist: true,
  });
  manager.startSession(options.idea ?? SEED_IDEA);
  return manager;
}

export function managerWithoutSession(store: Store = new MemoryStore()): StateManager {
  return new StateManager({ store, clock: fixedClock(), persist: false });
}

/** A representative first-turn change set: a mix of provenances and kinds. */
export function sampleChangeSet(): ChangeSetInput {
  return {
    title: 'Small autonomous greenhouse',
    current_intent:
      'Build a small self-managing greenhouse that keeps plants alive with minimal daily attention.',
    requirements_added: [
      {
        text: 'Water the plants automatically on a schedule.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'must',
        affects: { item_ids: [], areas: ['Watering subsystem'] },
      },
      {
        text: 'Maintain a usable temperature range for the plants.',
        provenance: 'model_inferred',
        kind: 'implied',
        priority: 'should',
      },
    ],
    assumptions_added: [
      {
        text: 'Mains electricity is available at the installation site.',
        provenance: 'model_inferred',
        confidence: 0.6,
        if_false_impact: 'high',
      },
    ],
    constraints_added: [
      {
        text: 'Must operate outdoors.',
        provenance: 'model_inferred',
        category: 'environmental',
        hard: false,
      },
    ],
    unknowns_added: [
      {
        text: 'How many plants must the system support?',
        provenance: 'unknown',
        impact: 'high',
        affected_areas: ['Watering subsystem', 'Structure size', 'Power budget'],
      },
    ],
    research_items_added: [
      {
        question: 'What water volume does the target plant set need per day?',
        priority: 'medium',
        rationale: 'Sizing the pump and reservoir depends on it.',
      },
    ],
  };
}

/** A user-grounded change set: everything the human literally said. */
export function userGroundedChangeSet(): ChangeSetInput {
  return {
    constraints_added: [
      {
        text: 'Must fit on a balcony.',
        provenance: 'user_stated',
        category: 'physical',
        hard: true,
        affects: { item_ids: [], areas: ['Structure size', 'Placement'] },
      },
    ],
  };
}

export function countPending(manager: StateManager): number {
  return manager.pendingChanges().length;
}

export function findItemText(manager: StateManager, collection: string, needle: string): boolean {
  const idea = manager.idea;
  if (!idea) return false;
  const items = (idea as unknown as Record<string, { text?: string; claim?: string; question?: string }[]>)[
    collection
  ];
  if (!Array.isArray(items)) return false;
  return items.some((item) =>
    [item.text, item.claim, item.question].some((field) => field?.toLowerCase().includes(needle.toLowerCase())),
  );
}

/**
 * Runs the five-step greenhouse acceptance scenario through the real orchestrator
 * and accepts everything Ideno proposes at each step — the behaviour of a user who
 * reads the review queue and agrees with it. Returns the resulting state manager.
 */
export async function runDemoScenario(): Promise<StateManager> {
  const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
  const provider = new ScriptedProvider({ responses: greenhouseResponder(state) });
  const orchestrator = new Orchestrator({
    runtime: new AIRuntime(provider, { timeout_ms: 2000 }),
    state,
    getSettings: () => SettingsSchema.parse({ provider_id: 'scripted' }),
    research: new ResearchRegistry(),
  });

  for (const message of DEMO_MESSAGES) {
    await orchestrator.processMessage(message);
    const pending = state.pendingChanges();
    if (pending.length > 0) state.acceptChanges(pending.map((record) => record.id));
  }
  return state;
}
