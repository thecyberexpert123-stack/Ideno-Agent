/**
 * The Ideno orchestrator.
 *
 * One component drives the loop: understand → structure → evidence → constraint
 * analysis → critique → exploration → updated state → human feedback → iterate.
 *
 * It is deliberately *not* a fixed pipeline. Each turn the model returns a plan
 * that says which stages should run next, and those follow-ups execute against
 * the state the previous stage just produced — so a constraint added this turn is
 * visible to the critique that follows it, and an invalidated assumption sends the
 * loop back through structuring instead of forward.
 *
 * What the orchestrator owns, and never delegates to a model:
 *  - deciding whether a provider can be called at all,
 *  - validating every structured response before it touches the state,
 *  - enforcing the one-question rule,
 *  - stopping after a failure instead of compounding it, and
 *  - reporting exactly what happened.
 */
import type {
  ChangeRecord,
  EvidenceDraft,
  IdeaCaseBody,
  Operation,
  BehaviourSettings,
  Question,
  TranscriptEntry,
  VersionRecord,
} from '../schemas/index.js';
import { TurnPlanSchema, type TurnPlan } from '../schemas/index.js';
import { newId } from '../ids.js';
import { IdenoStateError, isIdenoStateError } from '../errors.js';
import { bodyOf } from '../idea_state/create.js';
import { decideQuestion } from '../idea_state/selectors.js';
import type { EnqueueResult, StateManager } from '../state_manager/state_manager.js';
import { AI_ERROR_HINTS, isAIError, toAIError, type AIErrorCode } from '../../ai/errors.js';
import type { AIRuntime } from '../../ai/runtime/runtime.js';
import { initialOperation, prepareOperation } from '../../reasoning/operations.js';
import { describePartialPlan } from '../../reasoning/preview.js';
import { parsePartialJson } from '../../ai/runtime/json_extract.js';
import { findingsToEvidenceDrafts, runResearch, type ResearchRegistry } from '../../research/evidence.js';

export type OrchestratorPhase =
  | 'preparing'
  | 'awaiting_provider'
  | 'calling_model'
  | 'applying'
  | 'complete';

export interface OrchestratorEvent {
  type: 'phase' | 'warning' | 'failure' | 'turn_complete' | 'preview';
  phase?: OrchestratorPhase;
  operation?: Operation;
  detail?: string;
  code?: string;
  message?: string;
  turn?: TurnResult;
  /**
   * Set on `preview` events: a description of the response that is still arriving.
   *
   * Decoration only. It is derived from a best-effort parse of a partial document,
   * it is replaced by the real reply as soon as the response validates, and nothing
   * in the state machine reads it.
   */
  preview?: string | null;
}

export interface TurnFailure {
  code: string;
  message: string;
  hint: string;
  /** Model text that could not be validated, when there was any. */
  raw_text: string | null;
}

export interface TurnResult {
  turn_id: string;
  /** Operations actually executed, in order. */
  operations: Operation[];
  /** Ideno's replies plus any system notices, in order. */
  entries: TranscriptEntry[];
  /** The single question put to the user this turn, if any. */
  question: Question | null;
  changes: ChangeRecord[];
  /** Changes still awaiting Accept / Reject after this turn. */
  pending: ChangeRecord[];
  applied: ChangeRecord[];
  versions: VersionRecord[];
  integrity_notes: string[];
  failures: TurnFailure[];
}

export interface OrchestratorOptions {
  runtime: AIRuntime;
  state: StateManager;
  /**
   * Read live, so a settings change takes effect on the next turn. Deliberately
   * the behaviour half of the settings only: the orchestrator has no business
   * knowing which provider is configured.
   */
  getSettings: () => BehaviourSettings;
  research?: ResearchRegistry;
  onEvent?: (event: OrchestratorEvent) => void;
  /** Cap on operations per turn: the initial one plus its follow-ups. */
  max_operations_per_turn?: number;
}

export interface ProcessOptions {
  /** Force an operation instead of deriving one from the state. */
  operation?: Operation;
  /** Extra direction for this turn, e.g. what a toolbar button asked for. */
  extra_instruction?: string;
  signal?: AbortSignal;
}

const DEFAULT_MAX_OPERATIONS = 3;
/** Bounds on a research turn: enough to be useful, small enough to review. */
const MAX_RESEARCH_QUESTIONS_PER_TURN = 3;
/** Must match `ChangeSetSchema.evidence_added.max()`. */
const MAX_EVIDENCE_PER_CHANGE_SET = 8;
/** Must match `ChangeSetSchema.items_updated.max()`. */
const MAX_ITEM_UPDATES_PER_CHANGE_SET = 16;

export class Orchestrator {
  #runtime: AIRuntime;
  #state: StateManager;
  #getSettings: () => BehaviourSettings;
  #research: ResearchRegistry | null;
  #onEvent: ((event: OrchestratorEvent) => void) | null;
  #maxOperations: number;
  #busy = false;

  constructor(options: OrchestratorOptions) {
    this.#runtime = options.runtime;
    this.#state = options.state;
    this.#getSettings = options.getSettings;
    this.#research = options.research ?? null;
    this.#onEvent = options.onEvent ?? null;
    this.#maxOperations = Math.max(1, options.max_operations_per_turn ?? DEFAULT_MAX_OPERATIONS);
  }

  get busy(): boolean {
    return this.#busy;
  }

  get runtime(): AIRuntime {
    return this.#runtime;
  }

  setRuntime(runtime: AIRuntime): void {
    this.#runtime = runtime;
  }

  /**
   * Handles one message from the human. This is the main entry point and the one
   * the MVP scenario exercises end to end.
   */
  async processMessage(text: string, options: ProcessOptions = {}): Promise<TurnResult> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new IdenoStateError('invalid_state', 'Cannot process an empty message.');
    }
    return this.#runTurn({ userText: trimmed, options });
  }

  /**
   * Runs an operation with no new message — the toolbar's Critique / Explore /
   * Research actions. Recorded as a system notice so the conversation still reads
   * as a continuous account of how the idea developed.
   */
  async runOperation(operation: Operation, extraInstruction?: string): Promise<TurnResult> {
    return this.#runTurn({
      userText: null,
      options: { operation, extra_instruction: extraInstruction },
      systemNotice: `${labelFor(operation)} requested from the toolbar.`,
    });
  }

  async #runTurn(input: {
    userText: string | null;
    options: ProcessOptions;
    systemNotice?: string;
  }): Promise<TurnResult> {
    if (this.#busy) {
      throw new IdenoStateError('invalid_state', 'Ideno is already working on a turn.');
    }
    this.#busy = true;

    const turnId = newId('turn');
    const result: TurnResult = {
      turn_id: turnId,
      operations: [],
      entries: [],
      question: null,
      changes: [],
      pending: [],
      applied: [],
      versions: [],
      integrity_notes: [],
      failures: [],
    };

    try {
      const settings = this.#getSettings();

      // A brand new idea becomes the session and version 0 before anything else.
      if (input.userText && !this.#state.hasSession) {
        this.#state.startSession(input.userText);
      }
      /**
       * Captured before the first await and after any session this turn created.
       * Every mutation the turn makes carries it, so if the human opens another
       * idea while the model is thinking, this turn fails instead of writing its
       * changes into that other idea.
       */
      const turnGuard = this.#state.guard;
      if (!this.#state.hasSession || !this.#state.idea) {
        throw new IdenoStateError('no_session', 'Give Ideno an idea before running an operation.');
      }

      let userEntry: TranscriptEntry | null = null;
      if (input.userText) {
        userEntry = this.#state.appendTranscript({
          role: 'user',
          text: input.userText,
          turn_id: turnId,
          guard: turnGuard,
        });
        result.entries.push(userEntry);
      } else if (input.systemNotice) {
        const notice = this.#state.appendTranscript({
          role: 'system',
          text: input.systemNotice,
          turn_id: turnId,
          guard: turnGuard,
        });
        result.entries.push(notice);
      }

      this.#emit({ type: 'phase', phase: 'preparing', detail: 'Reading the current idea state.' });

      const availability = await this.#ensureProvider();
      if (!availability.ok) {
        this.#fail(result, turnId, availability.code, availability.message, availability.hint, null, undefined, turnGuard);
        return result;
      }

      const queue: Operation[] = [
        input.options.operation ?? initialOperation(bodyOf(this.#state.idea)),
      ];
      // The human's message belongs to the first operation only; follow-ups work
      // from the state, not from a re-read of the same sentence.
      let firstOperation = true;

      while (queue.length > 0 && result.operations.length < this.#maxOperations) {
        const operation = queue.shift() as Operation;
        const outcome = await this.#executeOperation({
          operation,
          turnId,
          settings,
          guard: turnGuard,
          userText: firstOperation ? input.userText : null,
          extraInstruction: firstOperation ? input.options.extra_instruction : undefined,
          signal: input.options.signal,
          result,
        });
        firstOperation = false;
        if (!outcome.ok) break;
        queue.push(...outcome.followups);
      }

      result.pending = this.#state.pendingChanges();
      this.#emit({ type: 'phase', phase: 'complete' });
      this.#emit({ type: 'turn_complete', turn: result });
      return result;
    } finally {
      this.#busy = false;
    }
  }

  async #executeOperation(input: {
    operation: Operation;
    turnId: string;
    settings: BehaviourSettings;
    guard: string;
    userText: string | null;
    extraInstruction?: string;
    signal?: AbortSignal;
    result: TurnResult;
  }): Promise<{ ok: boolean; followups: Operation[] }> {
    const { operation, turnId, settings, result } = input;
    const idea = this.#state.idea;
    if (!idea) return { ok: false, followups: [] };

    this.#emit({ type: 'phase', phase: 'calling_model', operation });

    const prepared = prepareOperation({
      operation,
      body: bodyOf(idea),
      history: this.#historyBeforeTurn(turnId),
      pending: this.#state.pendingChanges(),
      user_message: input.userText,
      transcript_turns: settings.context_transcript_turns,
      extra_instruction: this.#extraInstruction(operation, input.extraInstruction),
    });

    let plan: TurnPlan;
    try {
      const call = await this.#runtime.structured({
        task: operation,
        system: prepared.system,
        turns: prepared.turns,
        schema: TurnPlanSchema,
        contract_notes: prepared.contract_notes,
        signal: input.signal,
        on_progress: (accumulated) => this.#reportProgress(operation, accumulated),
      });
      plan = call.value;
      if (call.repaired) {
        result.integrity_notes.push(
          'The first response from the model was not valid; a corrected one was accepted.',
        );
      }
      // A provider without cancellation support (Puter has no abort signal) can
      // still return after the human gave up. Applying that response would mutate
      // state nobody is watching, so it is dropped here instead.
      if (input.signal?.aborted) {
        this.#fail(result, turnId, 'aborted', 'The turn was cancelled.', 'The request was cancelled.', null, operation, input.guard);
        return { ok: false, followups: [] };
      }
    } catch (error) {
      const failure = this.#describeFailure(error);
      this.#fail(result, turnId, failure.code, failure.message, failure.hint, failure.raw_text, operation, input.guard);
      return { ok: false, followups: [] };
    }

    this.#emit({ type: 'phase', phase: 'applying', operation });

    // A research turn with at least one registered source actually goes and looks
    // things up, and what comes back is merged into the same validated batch as the
    // model's own proposal. With no source registered this is a no-op, and the
    // instruction the model received already told it not to invent evidence.
    const research = await this.#gatherResearch({
      operation,
      // Re-read: the model call and the research scan both have to see the state as
      // it is now, not as it was before this operation's own proposal was applied.
      body: bodyOf(this.#state.idea ?? idea),
      signal: input.signal,
      plan,
      result,
      turnId,
      guard: input.guard,
    });
    if (research.aborted) return { ok: false, followups: [] };

    let enqueued: EnqueueResult;
    try {
      enqueued = this.#state.enqueueChanges(plan.changes, {
        origin: operation,
        message_id: this.#latestUserMessageId(turnId),
        rationale: plan.reasoning_summary,
        review_mode: settings.review_mode,
        trigger: operation === 'decision' ? 'decision' : 'turn',
        guard: input.guard,
      });
    } catch (error) {
      const failure = this.#describeFailure(error);
      this.#fail(result, turnId, failure.code, failure.message, failure.hint, failure.raw_text, operation, input.guard);
      return { ok: false, followups: [] };
    }

    result.operations.push(operation);
    result.changes.push(...enqueued.records);
    result.applied.push(...enqueued.applied);
    result.integrity_notes.push(...enqueued.integrity_notes, ...research.notes);
    for (const note of research.notes) this.#emit({ type: 'warning', message: note });
    if (enqueued.version) result.versions.push(enqueued.version);
    for (const note of enqueued.integrity_notes) this.#emit({ type: 'warning', message: note });

    // The one-question rule is enforced here, in code, not in the prompt alone.
    // Against the *post-apply* body: an unknown this very change set resolved must
    // not still generate a question about itself.
    const decision = decideQuestion(bodyOf(this.#state.idea ?? idea), plan.question);
    if (decision.question) {
      result.question = result.question ?? decision.question;
    } else if (plan.question && 'suppressed_reason' in decision) {
      result.integrity_notes.push(decision.suppressed_reason);
      this.#emit({ type: 'warning', message: decision.suppressed_reason });
    }

    const reply = this.#state.appendTranscript({
      role: 'ideno',
      text: plan.user_message,
      turn_id: turnId,
      operation,
      classification: plan.classification,
      reasoning_summary: plan.reasoning_summary,
      question: decision.question,
      guard: input.guard,
    });
    result.entries.push(reply);

    if (decision.question) this.#state.markQuestionAsked(decision.question, null);

    const followups = plan.followups.filter((next) => next !== operation);
    return { ok: true, followups };
  }

  /**
   * Runs registered research sources over the highest-priority open questions and
   * merges what they retrieved into the plan's change set.
   *
   * Retrieved evidence is proposed like any other change, so it still goes through
   * provenance derivation and the review policy: a source returning something
   * irrelevant is a judgement for the human, not for this code.
   */
  async #gatherResearch(input: {
    operation: Operation;
    body: IdeaCaseBody;
    signal: AbortSignal | undefined;
    plan: TurnPlan;
    result: TurnResult;
    turnId: string;
    guard: string;
  }): Promise<{ notes: string[]; aborted: boolean }> {
    const { operation, body, signal, plan, result, turnId, guard } = input;
    if (operation !== 'research' || !this.#research || this.#research.empty) {
      return { notes: [], aborted: false };
    }

    const notes: string[] = [];
    const priorityRank = { high: 3, medium: 2, low: 1 } as const;
    const questions = body.research_items
      .filter((item) => item.status === 'open')
      .slice()
      .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority])
      .slice(0, MAX_RESEARCH_QUESTIONS_PER_TURN);

    if (questions.length === 0) {
      notes.push('No open research questions to look up.');
      return { notes, aborted: false };
    }

    const drafts: EvidenceDraft[] = [];
    const sourcesUsed = new Set<string>();
    /** Questions that actually came back with findings, so they can be closed. */
    const answered: string[] = [];

    for (const item of questions) {
      if (signal?.aborted) break;
      const outcome = await runResearch(this.#research, item, { limit: 3, signal });
      for (const failure of outcome.failures) {
        notes.push(`Research source "${failure.source_id}" failed on "${item.question}": ${failure.message}`);
      }
      const converted = findingsToEvidenceDrafts(outcome.findings);
      notes.push(...converted.dropped);
      if (converted.drafts.length === 0 && outcome.failures.length === 0) {
        notes.push(`No findings were returned for "${item.question}".`);
      } else {
        sourcesUsed.add(item.id);
      }
      if (converted.drafts.length > 0) answered.push(item.id);
      drafts.push(...converted.drafts);
    }

    if (signal?.aborted) {
      this.#fail(result, turnId, 'aborted', 'Research was cancelled.', 'The request was cancelled.', null, operation, guard);
      return { notes, aborted: true };
    }

    if (drafts.length > 0) {
      const existing = plan.changes.evidence_added ?? [];
      const room = MAX_EVIDENCE_PER_CHANGE_SET - existing.length;
      const accepted = drafts.slice(0, Math.max(0, room));
      if (accepted.length < drafts.length) {
        notes.push(
          `${drafts.length - accepted.length} retrieved finding(s) exceeded the per-turn evidence limit and were discarded.`,
        );
      }
      plan.changes.evidence_added = [...existing, ...accepted];
      notes.push(
        `Research retrieved ${accepted.length} finding(s) for ${sourcesUsed.size} question(s); they are proposed as evidence for your review.`,
      );
    }

    // Close the loop. Without this a question that was answered stays `open` and is
    // re-queried on every research turn — spending the user's model budget to
    // retrieve the same thing again. Marking it `answered` is a claim about what
    // Ideno did, not about whether the finding is good: the evidence itself still
    // goes to the human for review, and rejecting it does not reopen the question
    // automatically, which would silently undo this record.
    if (answered.length > 0) {
      plan.changes.items_updated = [
        ...(plan.changes.items_updated ?? []),
        ...answered.slice(0, MAX_ITEM_UPDATES_PER_CHANGE_SET).map((id) => ({ id, status: 'answered' as const })),
      ];
    }

    return { notes, aborted: false };
  }

  /**
   * Turns the text arriving so far into a preview event.
   *
   * The parse is best-effort and its result is labelled as a proposal: at this point
   * nothing has been validated, nothing has been applied, and the human has reviewed
   * nothing. A preview that read "added 3 constraints" would be a false statement
   * about the state, which is the exact confusion the review queue exists to prevent.
   */
  #reportProgress(operation: Operation, accumulated: string): void {
    const partial = parsePartialJson(accumulated);
    const description = describePartialPlan(partial.value, partial.complete);
    if (!description) return;
    this.#emit({ type: 'preview', operation, preview: description });
  }

  /**
   * Extra direction the orchestrator adds on its own authority — facts about the
   * environment the model cannot know and must not guess at.
   */
  #extraInstruction(operation: Operation, extra?: string): string | undefined {
    const parts: string[] = [];
    if (extra) parts.push(extra);

    if (operation === 'research' && (this.#research?.empty ?? true)) {
      parts.push(
        'No automated research source is registered in this build, and the human has not supplied one. ' +
          'Do not emit evidence with origin "research_source". Record research questions instead, and mark ' +
          'anything you believe from your own knowledge as origin "model_recall".',
      );
    }
    if (this.#state.pendingChanges().length > 0) {
      parts.push(
        `${this.#state.pendingChanges().length} change(s) are still awaiting the human's review; ` +
          'build on the accepted state and do not re-propose them.',
      );
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /**
   * Conversation history excluding this turn's own entries. The message being
   * processed is delivered inside the structured task block, so including it here
   * as well would send it twice.
   */
  #historyBeforeTurn(turnId: string): TranscriptEntry[] {
    return this.#state.transcript().filter((entry) => entry.turn_id !== turnId);
  }

  #latestUserMessageId(turnId: string): string | null {
    const transcript = this.#state.transcript();
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry && entry.turn_id === turnId && entry.role === 'user') return entry.id;
    }
    return null;
  }

  /**
   * Confirms a provider can be used, attempting an interactive sign-in when that
   * is the only thing standing in the way (Puter's model: the user authenticates
   * with the provider and pays them directly).
   */
  async #ensureProvider(): Promise<
    { ok: true } | { ok: false; code: AIErrorCode; message: string; hint: string }
  > {
    this.#emit({ type: 'phase', phase: 'awaiting_provider' });
    let availability = await this.#runtime.availability();

    if (!availability.available && availability.action === 'sign_in') {
      availability = await this.#runtime.signIn();
    }
    if (availability.available) return { ok: true };

    const code: AIErrorCode = availability.action === 'sign_in' ? 'auth_required' : 'provider_unavailable';
    return {
      ok: false,
      code,
      message: availability.reason ?? `${this.#runtime.provider.label} is not available.`,
      hint: AI_ERROR_HINTS[code],
    };
  }

  #describeFailure(error: unknown): TurnFailure {
    if (isAIError(error)) {
      const issues = error.details.issues ?? [];
      return {
        code: error.code,
        // The validation issues are part of the message a human needs: "it was
        // invalid" without saying what was invalid is not actionable.
        message: issues.length > 0 ? `${error.message} Validation: ${issues.slice(0, 4).join('; ')}` : error.message,
        hint: error.hint,
        raw_text: error.details.raw_text ?? null,
      };
    }
    if (isIdenoStateError(error)) {
      return { code: `state_${error.code}`, message: error.message, hint: 'The idea state was not modified.', raw_text: null };
    }
    const mapped = toAIError(error);
    return { code: mapped.code, message: mapped.message, hint: mapped.hint, raw_text: mapped.details.raw_text ?? null };
  }

  #fail(
    result: TurnResult,
    turnId: string,
    code: string,
    message: string,
    hint: string,
    rawText: string | null,
    operation?: Operation,
    guard?: string,
  ): void {
    const failure: TurnFailure = { code, message, hint, raw_text: rawText };
    result.failures.push(failure);

    const text = rawText
      ? `${message} ${hint} The model did return text, but Ideno could not validate it as a state change, so nothing was modified.`
      : `${message} ${hint}`;

    try {
      const entry = this.#state.appendTranscript({
        role: 'system',
        text: text.slice(0, 4000),
        turn_id: turnId,
        operation: operation ?? null,
        error_code: code,
        raw_text: rawText ? rawText.slice(0, 20000) : null,
        // Guarded like every other write in a turn: if the human opened another
        // idea, this notice is refused and the catch below swallows it, which is
        // the right outcome — the failure belongs to the idea it happened in.
        guard,
      });
      result.entries.push(entry);
    } catch {
      // If even the transcript cannot be written there is nothing left to record.
    }
    this.#emit({ type: 'failure', code, message, detail: hint });
  }

  #emit(event: OrchestratorEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // A broken UI listener must not abort a turn.
    }
  }
}

function labelFor(operation: Operation): string {
  switch (operation) {
    case 'critique':
      return 'Critique';
    case 'explore':
      return 'Exploration of alternatives';
    case 'research':
      return 'Research review';
    case 'understand':
      return 'Understanding pass';
    case 'decision':
      return 'Decision recording';
    default:
      return 'Update';
  }
}
