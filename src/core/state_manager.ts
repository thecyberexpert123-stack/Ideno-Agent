import { IdenoError } from './errors.js';
import { newCaseId, shortId } from './ids.js';
import { createIdeaCase, latestVersion } from './idea_state.js';
import { applyOperations, type ApplyEntry } from './patch.js';
import {
  ChangeSetSchema,
  type ChangeSet,
  type ChangeSetEntry,
  type ConversationTurn,
  type IdeaCase,
  type Origin,
  type StateOperation,
  type VersionRecord,
} from './schemas.js';
import type { CaseStore, CaseSummary } from './store/store.js';
import { commitVersion } from './versioning.js';

/**
 * Case and changeset lifecycle.
 *
 * Every state transition in Ideno goes through a changeset: propose, review,
 * apply, version. Nothing — not the orchestrator, not the research plugin,
 * not a direct API edit — writes to a collection without one. That uniformity
 * is what makes the version history complete and the UI's "inspect before it
 * changes" guarantee real rather than cosmetic.
 */

export interface DraftChangeSetEntry {
  readonly id: string;
  readonly operation: StateOperation;
  readonly label: string;
  readonly affected_areas: readonly string[];
  readonly affected_item_ids: readonly string[];
}

export interface DraftChangeSet {
  readonly source: ChangeSet['source'];
  readonly summary: string;
  readonly reasoning_summary: string;
  readonly entries: readonly DraftChangeSetEntry[];
  /** The user turn this changeset responds to. Used to verify quotes. */
  readonly turnId: string | null;
  readonly warnings?: readonly string[];
}

export interface ChangeSetDecision {
  /** Entry ids to apply. Everything else in the changeset is rejected. */
  readonly acceptedEntryIds?: readonly string[];
  readonly acceptAll?: boolean;
}

export interface DecisionResult {
  readonly ideaCase: IdeaCase;
  readonly changeset: ChangeSet;
  readonly version: VersionRecord | null;
}

const SOURCE_ORIGIN: Record<ChangeSet['source'], Origin> = {
  orchestrator: 'model',
  user: 'user',
  research: 'research',
};

export class StateManager {
  readonly #store: CaseStore;
  readonly #now: () => Date;

  constructor(store: CaseStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  get store(): CaseStore {
    return this.#store;
  }

  async listCases(): Promise<CaseSummary[]> {
    return this.#store.list();
  }

  async createCase(originalIdea: string, title?: string): Promise<IdeaCase> {
    const trimmed = originalIdea.trim();
    if (trimmed.length === 0) {
      throw new IdenoError('bad_request', 'An idea needs at least some text to work with.');
    }
    const ideaCase = createIdeaCase({
      id: newCaseId(),
      originalIdea: trimmed,
      ...(title === undefined ? {} : { title }),
      now: this.#now(),
    });
    return this.#store.create(ideaCase);
  }

  async getCase(id: string): Promise<IdeaCase> {
    const found = await this.#store.get(id);
    if (!found) throw new IdenoError('not_found', `Case ${id} was not found`);
    return found;
  }

  async deleteCase(id: string): Promise<boolean> {
    return this.#store.delete(id);
  }

  /** Appends a conversation turn and returns the turn plus the updated case. */
  async appendTurn(
    caseId: string,
    turn: {
      role: ConversationTurn['role'];
      text: string;
      changesetId?: string | null;
      degraded?: boolean;
    },
  ): Promise<{ ideaCase: IdeaCase; turn: ConversationTurn }> {
    const record: ConversationTurn = {
      id: shortId('trn'),
      role: turn.role,
      text: turn.text,
      created_at: this.#now().toISOString(),
      changeset_id: turn.changesetId ?? null,
      degraded: turn.degraded ?? false,
    };
    const ideaCase = await this.#store.update(caseId, (current) => {
      current.conversation.push(record);
      current.updated_at = record.created_at;
      return current;
    });
    return { ideaCase, turn: record };
  }

  /** Records a changeset in `pending` state for the user to review. */
  async addChangeSet(caseId: string, draft: DraftChangeSet): Promise<{ ideaCase: IdeaCase; changeset: ChangeSet }> {
    const changeset: ChangeSet = ChangeSetSchema.parse({
      id: shortId('cs'),
      case_id: caseId,
      turn_id: draft.turnId,
      source: draft.source,
      status: 'pending',
      summary: draft.summary,
      reasoning_summary: draft.reasoning_summary,
      entries: draft.entries.map(
        (entry): ChangeSetEntry => ({
          id: entry.id,
          operation: entry.operation,
          label: entry.label,
          affected_areas: [...entry.affected_areas],
          affected_item_ids: [...entry.affected_item_ids],
          status: 'pending',
          applier_note: null,
          created_item_id: null,
        }),
      ),
      created_at: this.#now().toISOString(),
      resolved_at: null,
      warnings: [...(draft.warnings ?? [])],
    } satisfies ChangeSet);

    const ideaCase = await this.#store.update(caseId, (current) => {
      current.changesets.push(changeset);
      current.updated_at = changeset.created_at;
      return current;
    });
    return { ideaCase, changeset };
  }

  /**
   * Applies the accepted part of a pending changeset and cuts a new version.
   *
   * Accepting an operation is not the same as it succeeding: the applier can
   * still skip a duplicate or refuse an unresolvable reference. Those entries
   * are marked `skipped` with the reason, so the review trail stays honest.
   */
  async decideChangeSet(
    caseId: string,
    changesetId: string,
    decision: ChangeSetDecision,
  ): Promise<DecisionResult> {
    let resolvedChangeSet: ChangeSet | null = null;
    let resolvedVersion: VersionRecord | null = null;

    const ideaCase = await this.#store.update(caseId, (current) => {
      const index = current.changesets.findIndex((entry) => entry.id === changesetId);
      if (index < 0) {
        throw new IdenoError('not_found', `Changeset ${changesetId} was not found in case ${caseId}`);
      }
      const changeset = current.changesets[index] as ChangeSet;
      if (changeset.status !== 'pending') {
        throw new IdenoError('conflict', `Changeset ${changesetId} was already ${changeset.status}`);
      }

      const acceptAll = decision.acceptAll === true;
      const acceptedIds = new Set(decision.acceptedEntryIds ?? []);
      const unknownIds = [...acceptedIds].filter(
        (id) => !changeset.entries.some((entry) => entry.id === id),
      );
      if (unknownIds.length > 0) {
        throw new IdenoError('bad_request', `Unknown changeset entries: ${unknownIds.join(', ')}`);
      }

      const accepted = changeset.entries.filter((entry) => acceptAll || acceptedIds.has(entry.id));
      const userMessage = findTurnText(current, changeset.turn_id);
      const versionIndex = latestVersion(current).index + 1;
      const now = this.#now();

      const applyInput: ApplyEntry[] = accepted.map((entry) => ({
        id: entry.id,
        operation: entry.operation,
      }));

      const applied = applyOperations(current, applyInput, {
        origin: SOURCE_ORIGIN[changeset.source],
        userMessage,
        versionIndex,
        now,
      });

      const next = applied.ideaCase;
      const nextChangeSet = next.changesets[index] as ChangeSet;

      let appliedCount = 0;
      let rejectedCount = 0;
      for (const entry of nextChangeSet.entries) {
        const isAccepted = acceptAll || acceptedIds.has(entry.id);
        if (!isAccepted) {
          entry.status = 'rejected';
          rejectedCount += 1;
          continue;
        }
        const outcome = applied.outcomes.get(entry.id);
        if (outcome?.applied) {
          entry.status = 'accepted';
          entry.applier_note = outcome.note;
          entry.created_item_id = outcome.createdItemId;
          appliedCount += 1;
        } else {
          entry.status = 'skipped';
          entry.applier_note = outcome?.note ?? 'The operation could not be applied.';
        }
      }

      nextChangeSet.status =
        rejectedCount === nextChangeSet.entries.length
          ? 'rejected'
          : rejectedCount > 0
            ? 'partially_accepted'
            : 'accepted';
      nextChangeSet.resolved_at = now.toISOString();

      if (applied.changed) {
        resolvedVersion = commitVersion(next, {
          label: `v${versionIndex} — ${nextChangeSet.summary}`,
          summary: nextChangeSet.reasoning_summary || nextChangeSet.summary,
          changesetId: nextChangeSet.id,
          operations: nextChangeSet.entries
            .filter((entry) => entry.status === 'accepted')
            .map((entry) => entry.operation),
          now,
        });
      }

      resolvedChangeSet = nextChangeSet;
      next.updated_at = now.toISOString();
      void appliedCount;
      return next;
    });

    /* c8 ignore next 3 -- the mutator always assigns or throws */
    if (!resolvedChangeSet) {
      throw new IdenoError('internal_error', 'Changeset decision produced no result');
    }
    return { ideaCase, changeset: resolvedChangeSet, version: resolvedVersion };
  }
}

function findTurnText(ideaCase: IdeaCase, turnId: string | null): string | null {
  if (!turnId) return null;
  const turn = ideaCase.conversation.find((entry) => entry.id === turnId);
  return turn && turn.role === 'user' ? turn.text : null;
}
