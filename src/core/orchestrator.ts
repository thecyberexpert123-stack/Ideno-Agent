import type { AIRuntime } from '../ai/runtime.js';
import { runCritique } from '../reasoning/critique.js';
import { runExplore } from '../reasoning/explore.js';
import { selectQuestion, type QuestionCandidate } from '../reasoning/questions.js';
import type { CritiqueResult, ExploreResult, ImpactResult, UnderstandResult } from '../reasoning/schemas.js';
import {
  translateCritique,
  translateExplore,
  translateImpact,
  translateUnderstand,
  type DraftEntry,
} from '../reasoning/translate.js';
import { runUnderstand } from '../reasoning/understand.js';
import { runImpactAnalysis } from '../reasoning/update.js';
import { toIdenoError, type IdenoError } from './errors.js';
import { activeItems, summarizeState } from './idea_state.js';
import { silentLogger, type Logger } from './logger.js';
import type { ChangeSet, CollectionName, IdeaCase, IdeaPhase } from './schemas.js';
import { shortId } from './ids.js';
import type { StateManager } from './state_manager.js';

/**
 * The Ideno orchestrator.
 *
 * Implements the core loop
 *
 *   understand → structure → constraint/impact analysis → critique →
 *   exploration → updated Idea State → human review
 *
 * as a *planner*, not a pipeline. Which stages run is decided per turn from
 * the current state and what the message actually does, and the loop can go
 * backwards: when impact analysis invalidates something load-bearing, Ideno
 * re-enters exploration in the same turn because the design space moved.
 *
 * The orchestrator never writes to a collection. It produces a changeset and
 * hands it to the state manager, which is the only component that applies
 * operations.
 */

export type StageName = 'understand' | 'impact' | 'critique' | 'explore' | 'explore_revisit';

export interface TurnPlan {
  readonly stages: StageName[];
  readonly reasons: string[];
}

export interface StageFailure {
  readonly stage: StageName;
  readonly code: IdenoError['code'];
  readonly message: string;
}

export interface RunTurnInput {
  readonly caseId: string;
  readonly message: string;
  readonly providerId?: string;
  /** Apply the proposal immediately instead of leaving it for review. */
  readonly autoAccept?: boolean;
  readonly signal?: AbortSignal;
}

export interface TurnOutcome {
  readonly ideaCase: IdeaCase;
  readonly changeset: ChangeSet | null;
  readonly reply: string;
  readonly plan: TurnPlan;
  /** True when at least one planned stage failed but the turn still produced value. */
  readonly degraded: boolean;
  readonly failures: StageFailure[];
  readonly question: { id: string; text: string } | null;
}

export interface OrchestratorDeps {
  readonly runtime: AIRuntime;
  readonly stateManager: StateManager;
  readonly logger?: Logger;
}

const COLLECTION_LABELS: Record<CollectionName, [singular: string, plural: string]> = {
  requirements: ['requirement', 'requirements'],
  assumptions: ['assumption', 'assumptions'],
  constraints: ['constraint', 'constraints'],
  unknowns: ['unknown', 'unknowns'],
  evidence: ['evidence record', 'evidence records'],
  research_items: ['research question', 'research questions'],
  alternatives: ['alternative', 'alternatives'],
  decisions: ['decision', 'decisions'],
  rejected_approaches: ['rejected approach', 'rejected approaches'],
  open_questions: ['open question', 'open questions'],
};

export class Orchestrator {
  readonly #runtime: AIRuntime;
  readonly #state: StateManager;
  readonly #logger: Logger;

  constructor(deps: OrchestratorDeps) {
    this.#runtime = deps.runtime;
    this.#state = deps.stateManager;
    this.#logger = deps.logger ?? silentLogger;
  }

  async runTurn(input: RunTurnInput): Promise<TurnOutcome> {
    const message = input.message.trim();
    if (message.length === 0) {
      throw toIdenoError(new Error('An empty message cannot advance the idea.'));
    }

    // The user's words are recorded before any reasoning runs, so a provider
    // failure can never lose what they said.
    const { ideaCase: caseWithTurn, turn: userTurn } = await this.#state.appendTurn(input.caseId, {
      role: 'user',
      text: message,
    });

    const stageOptions = {
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };

    const failures: StageFailure[] = [];
    const plan: TurnPlan = { stages: ['understand'], reasons: [] };

    let understanding: UnderstandResult;
    try {
      understanding = await runUnderstand(this.#runtime, caseWithTurn, message, stageOptions);
    } catch (error) {
      const failure = toIdenoError(error);
      this.#logger.log('error', 'understand stage failed', {
        caseId: input.caseId,
        code: failure.code,
      });
      await this.#state.appendTurn(input.caseId, {
        role: 'system',
        text: `Ideno could not process that message: ${failure.message}`,
        degraded: true,
      });
      throw failure;
    }

    const { entries: understandEntries, pendingAdditions } = translateUnderstand(
      understanding,
      caseWithTurn,
    );
    const entries: DraftEntry[] = [...understandEntries];

    /* ---------------- plan the rest of the turn ---------------- */

    const before = summarizeState(caseWithTurn);
    const hasExistingState =
      before.requirements + before.constraints + before.assumptions + before.alternatives > 0;
    const addsBoundaries = understanding.constraints.length + understanding.requirements.length > 0;

    const wantsImpact =
      hasExistingState &&
      (addsBoundaries ||
        understanding.rejections.length > 0 ||
        understanding.decision !== null ||
        ['add_constraint', 'add_requirement', 'refine_idea', 'reject_approach'].includes(
          understanding.turn_intent,
        ));
    if (wantsImpact) {
      plan.stages.push('impact');
      plan.reasons.push('New boundaries arrived, so existing items are re-checked against them.');
    }

    const wantsCritique =
      understanding.needs_critique ||
      understanding.turn_intent === 'new_idea' ||
      understanding.assumptions.length > 0;
    if (wantsCritique) {
      plan.stages.push('critique');
      plan.reasons.push('There is new or unverified content worth stress-testing.');
    }

    let wantsExplore =
      understanding.needs_exploration || understanding.turn_intent === 'request_alternatives';
    if (wantsExplore) {
      plan.stages.push('explore');
      plan.reasons.push('The user asked for options, or the current ones may no longer fit.');
    }

    /* ---------------- impact analysis ---------------- */

    let impact: ImpactResult | null = null;
    if (wantsImpact) {
      try {
        impact = await runImpactAnalysis(
          this.#runtime,
          caseWithTurn,
          message,
          pendingAdditions,
          stageOptions,
        );
        entries.push(...translateImpact(impact, caseWithTurn, pendingAdditions));
      } catch (error) {
        failures.push(describeFailure('impact', error));
      }
    }

    // Loop back: if something load-bearing was invalidated and alternatives
    // already exist, the design space changed and exploration must re-run even
    // though the user did not ask for it.
    const invalidations = impact?.impacts.filter((entry) => entry.effect === 'invalidates') ?? [];
    const revisitExploration =
      !wantsExplore && invalidations.length > 0 && activeItems(caseWithTurn, 'alternatives').length > 0;
    if (revisitExploration) {
      wantsExplore = true;
      plan.stages.push('explore_revisit');
      plan.reasons.push(
        `${invalidations.length} existing item(s) were invalidated, so the alternatives are re-examined.`,
      );
    }

    /* ---------------- critique and exploration (independent) ---------------- */

    const exploreFocus = revisitExploration
      ? 'The design space just changed. Re-examine the alternatives against the new constraints, ' +
        'and replace any that no longer work.'
      : 'Produce genuinely distinct approaches that respect the active constraints.';

    const [critiqueSettled, exploreSettled] = await Promise.allSettled([
      wantsCritique
        ? runCritique(this.#runtime, caseWithTurn, message, pendingAdditions, stageOptions)
        : Promise.resolve(null),
      wantsExplore
        ? runExplore(this.#runtime, caseWithTurn, message, pendingAdditions, exploreFocus, stageOptions)
        : Promise.resolve(null),
    ]);

    let critique: CritiqueResult | null = null;
    if (critiqueSettled.status === 'fulfilled') {
      critique = critiqueSettled.value;
      if (critique) entries.push(...translateCritique(critique, caseWithTurn));
    } else {
      failures.push(describeFailure('critique', critiqueSettled.reason));
    }

    let exploration: ExploreResult | null = null;
    if (exploreSettled.status === 'fulfilled') {
      exploration = exploreSettled.value;
      if (exploration) entries.push(...translateExplore(exploration, caseWithTurn));
    } else {
      failures.push(describeFailure(revisitExploration ? 'explore_revisit' : 'explore', exploreSettled.reason));
    }

    /* ---------------- consolidate ---------------- */

    const phase = resolvePhase(caseWithTurn, understanding);
    const stateSummary = composeStateSummary(understanding, impact, critique, exploration);
    if (
      phase !== caseWithTurn.current_state.phase ||
      stateSummary !== caseWithTurn.current_state.summary
    ) {
      entries.push({
        id: shortId('op'),
        operation: {
          op: 'set_field',
          field: 'current_state',
          value: { phase, summary: stateSummary },
        },
        label: `Phase ${phase} — ${stateSummary}`.slice(0, 300),
        affected_areas: [],
        affected_item_ids: [],
      });
    }

    const warnings = failures.map(
      (failure) => `The ${failure.stage} step did not complete: ${failure.message}`,
    );

    let changeset: ChangeSet | null = null;
    let ideaCase = caseWithTurn;

    if (entries.length > 0) {
      const created = await this.#state.addChangeSet(input.caseId, {
        source: 'orchestrator',
        summary: summarizeEntries(entries),
        reasoning_summary: [
          understanding.intent_summary,
          impact?.summary,
          critique?.summary,
          exploration?.summary,
        ]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join('\n\n')
          .slice(0, 4000),
        entries,
        turnId: userTurn.id,
        warnings,
      });
      changeset = created.changeset;
      ideaCase = created.ideaCase;

      if (input.autoAccept) {
        const decided = await this.#state.decideChangeSet(input.caseId, created.changeset.id, {
          acceptAll: true,
        });
        changeset = decided.changeset;
        ideaCase = decided.ideaCase;
      }
    }

    // Question selection runs against the state the user will actually see:
    // the applied state when auto-accepting, otherwise the state plus what is
    // on the table for review.
    const question = selectQuestion(
      input.autoAccept ? ideaCase : projectPendingQuestions(ideaCase, entries),
    );

    const reply = composeReply({
      understanding,
      impact,
      critique,
      exploration,
      entries,
      question,
      failures,
      autoAccepted: input.autoAccept === true,
    });

    const replyTurn = await this.#state.appendTurn(input.caseId, {
      role: 'ideno',
      text: reply,
      changesetId: changeset?.id ?? null,
      degraded: failures.length > 0,
    });

    this.#logger.log('info', 'turn completed', {
      caseId: input.caseId,
      stages: plan.stages,
      entries: entries.length,
      failures: failures.length,
    });

    return {
      ideaCase: replyTurn.ideaCase,
      changeset,
      reply,
      plan,
      degraded: failures.length > 0,
      failures,
      question: question ? { id: question.item.id, text: question.item.text } : null,
    };
  }
}

function describeFailure(stage: StageName, error: unknown): StageFailure {
  const normalized = toIdenoError(error);
  return { stage, code: normalized.code, message: normalized.message };
}

/**
 * Builds a throwaway view of the case with the proposed open questions folded
 * in, so Ideno can ask about a gap it has only just identified.
 */
function projectPendingQuestions(ideaCase: IdeaCase, entries: readonly DraftEntry[]): IdeaCase {
  const projection = structuredClone(ideaCase);
  const timestamp = projection.updated_at;
  for (const entry of entries) {
    const operation = entry.operation;
    if (operation.op !== 'add') continue;
    if (operation.collection !== 'unknowns' && operation.collection !== 'open_questions') continue;
    projection[operation.collection].push({
      id: `pending-${entry.id}`,
      text: operation.item.text,
      epistemic_status: operation.item.epistemic_status,
      origin: 'model',
      status: 'active',
      confidence: operation.item.confidence ?? null,
      tags: operation.item.tags ?? [],
      supported_by: [],
      source_quote: null,
      created_at: timestamp,
      updated_at: timestamp,
      created_in_version: projection.version_history.length,
      impact: operation.item.impact ?? 0.5,
      blocks: operation.item.blocks ?? [],
    });
  }
  return projection;
}

function resolvePhase(ideaCase: IdeaCase, understanding: UnderstandResult): IdeaPhase {
  if (understanding.phase) return understanding.phase;
  if (understanding.decision) return 'converging';
  if (ideaCase.current_state.phase === 'capturing' && ideaCase.requirements.length > 0) {
    return 'exploring';
  }
  return ideaCase.current_state.phase;
}

function composeStateSummary(
  understanding: UnderstandResult,
  impact: ImpactResult | null,
  critique: CritiqueResult | null,
  exploration: ExploreResult | null,
): string {
  return [understanding.goal?.trim(), impact?.summary, critique?.summary, exploration?.summary]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .slice(0, 4000);
}

/** "2 constraints, 1 assumption, 3 alternatives" — used as the version label. */
export function summarizeEntries(entries: readonly DraftEntry[]): string {
  const added = new Map<CollectionName, number>();
  let invalidated = 0;
  let updated = 0;
  let linked = 0;
  let fields = 0;

  for (const { operation } of entries) {
    switch (operation.op) {
      case 'add':
        added.set(operation.collection, (added.get(operation.collection) ?? 0) + 1);
        break;
      case 'invalidate':
        invalidated += 1;
        break;
      case 'update':
        updated += 1;
        break;
      case 'relate':
        linked += 1;
        break;
      case 'set_field':
        fields += 1;
        break;
    }
  }

  const parts: string[] = [];
  for (const [collection, count] of added) {
    const [singular, plural] = COLLECTION_LABELS[collection];
    parts.push(`${count} ${count === 1 ? singular : plural}`);
  }
  if (invalidated > 0) parts.push(`${invalidated} invalidated`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (linked > 0) parts.push(`${linked} link${linked === 1 ? '' : 's'}`);
  if (parts.length === 0 && fields > 0) parts.push('framing updated');

  return parts.length > 0 ? parts.join(', ') : 'no structural change';
}

interface ReplyInput {
  readonly understanding: UnderstandResult;
  readonly impact: ImpactResult | null;
  readonly critique: CritiqueResult | null;
  readonly exploration: ExploreResult | null;
  readonly entries: readonly DraftEntry[];
  readonly question: QuestionCandidate | null;
  readonly failures: readonly StageFailure[];
  readonly autoAccepted: boolean;
}

/**
 * Composes Ideno's reply from the stage results.
 *
 * Deliberately not another model call. The reply is a report on what happened
 * to the Idea State, so deriving it from the state changes guarantees the two
 * cannot drift apart — and saves a round trip on every turn. The prose in it
 * is the models' own summaries, not a template pretending to be prose.
 */
export function composeReply(input: ReplyInput): string {
  const blocks: string[] = [input.understanding.intent_summary.trim()];

  if (input.impact?.summary?.trim()) {
    blocks.push(`**Impact on what we already had.** ${input.impact.summary.trim()}`);
  }

  const invalidated = input.entries.filter((entry) => entry.operation.op === 'invalidate');
  if (invalidated.length > 0) {
    const lines = invalidated.slice(0, 4).map((entry) => `- ${entry.label}`);
    blocks.push(`**No longer holds.**\n${lines.join('\n')}`);
  }

  if (input.critique?.summary?.trim()) {
    blocks.push(`**Where this is weak.** ${input.critique.summary.trim()}`);
  }

  if (input.exploration) {
    const alternatives = input.exploration.alternatives;
    if (alternatives.length > 0) {
      const lines = alternatives.map((alternative, index) => `${index + 1}. **${alternative.summary}** — ${alternative.approach}`);
      blocks.push(`**Approaches worth considering.**\n${lines.join('\n')}`);
    } else if (input.exploration.summary.trim()) {
      blocks.push(input.exploration.summary.trim());
    }
  }

  if (input.entries.length > 0) {
    const summary = summarizeEntries(input.entries);
    blocks.push(
      input.autoAccepted
        ? `_Idea State updated: ${summary}._`
        : `_Proposed for the Idea State: ${summary}. Review it in the panel on the right._`,
    );
  } else {
    blocks.push('_Nothing in the Idea State needed to change for that._');
  }

  if (input.question) {
    blocks.push(`**The thing that would help most right now:** ${input.question.item.text}`);
  }

  if (input.failures.length > 0) {
    const lines = input.failures.map((failure) => `- ${failure.stage}: ${failure.message}`);
    blocks.push(`_Part of this turn did not complete, so the update is partial:_\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}
