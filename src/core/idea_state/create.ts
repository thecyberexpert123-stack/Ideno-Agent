/**
 * Factories for the Idea State.
 *
 * Everything here mints ids and timestamps through the injected `Clock`, so
 * tests can produce byte-identical workspaces and version histories.
 */
import {
  BranchSchema,
  IdeaCaseSchema,
  SessionSchema,
  VersionRecordSchema,
  DEFAULT_BRANCH_NAME,
  type Branch,
  type IdeaCase,
  type IdeaCaseBody,
  type IdeaCaseSnapshot,
  type Session,
  type VersionRecord,
} from '../schemas/index.js';
import { newId, systemClock, type Clock } from '../ids.js';

const TITLE_MAX_LENGTH = 72;

export interface CreateIdeaCaseInput {
  original_idea: string;
  title?: string;
  id?: string;
  clock?: Clock;
  /**
   * Root branch and version 0 to attach, from `createHistoryRoot`. When omitted a
   * root is created — which is what keeps this function usable on its own (tests,
   * the canonical projection fixtures) — but then the case has no version history
   * yet, so `branches[0].head_version_id` dangles until a version is pushed.
   * `StateManager.startSession` always passes a root.
   */
  root?: HistoryRoot;
}

/**
 * A branch tip and the version it points at, minted together.
 *
 * They have to be created as a pair because they reference each other: a branch
 * records its head version, and a version records the branch it extends. Minting
 * both in one call is what makes "a branch whose head does not exist"
 * unrepresentable rather than merely unlikely.
 */
export interface HistoryRoot {
  branch: Branch;
  version: VersionRecord;
}

/** Creates the root branch and version 0 for a new idea. */
export function createHistoryRoot(clock: Clock = systemClock): HistoryRoot {
  const now = clock();
  const branch: Branch = BranchSchema.parse({
    id: newId('br'),
    name: DEFAULT_BRANCH_NAME,
    parent_branch_id: null,
    fork_version_id: null,
    head_version_id: newId('ver'),
    description: null,
    created_at: now,
    archived: false,
  });
  const version: VersionRecord = VersionRecordSchema.parse({
    id: branch.head_version_id,
    number: 0,
    parent_id: null,
    branch_id: branch.id,
    created_at: now,
    summary: 'Original idea',
    trigger: 'initial',
    message_id: null,
    applied_change_ids: [],
    label: null,
    snapshot: null,
    snapshot_pruned: false,
  });
  return { branch, version };
}

/**
 * Creates the initial case for a raw idea.
 *
 * `original_idea` is stored verbatim and is never rewritten by any later operation.
 */
export function createIdeaCase(input: CreateIdeaCaseInput): IdeaCase {
  const clock = input.clock ?? systemClock;
  const now = clock();
  const original = input.original_idea.trim();
  if (original.length === 0) {
    throw new Error('createIdeaCase: original_idea must not be empty.');
  }

  const root = input.root ?? createHistoryRoot(clock);

  const candidate = {
    id: input.id ?? newId('idea'),
    title: (input.title?.trim() || deriveTitle(original)).slice(0, TITLE_MAX_LENGTH),
    original_idea: original,
    current_intent: original,
    current_state: 'seed' as const,
    branches: [root.branch],
    active_branch_id: root.branch.id,
    created_at: now,
    updated_at: now,
  };

  const parsed = IdeaCaseSchema.safeParse(candidate);
  if (!parsed.success) {
    // Guards against an over-long title or idea text being stored unvalidated.
    throw new Error(
      `createIdeaCase produced an invalid IdeaCase: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * First sentence (or line) of the idea, truncated — a readable default title.
 *
 * Deliberately avoids lookbehind regex syntax: a lookbehind in a regex literal
 * is a parse-time SyntaxError on older Safari, which would take the whole bundle
 * down for a cosmetic feature.
 */
export function deriveTitle(originalIdea: string): string {
  const firstLine = originalIdea.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  const sentence = firstLine.match(/^[^.!?]*[.!?]?/)?.[0]?.trim() ?? '';
  const base = (sentence.length > 0 ? sentence : firstLine).replace(/[.!?]$/, '');
  if (base.length <= TITLE_MAX_LENGTH) return base;
  return `${base.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function createSession(idea: IdeaCase, clock: Clock = systemClock): Session {
  const now = clock();
  const parsed = SessionSchema.safeParse({
    id: newId('session'),
    idea,
    transcript: [],
    change_log: [],
    created_at: idea.created_at,
    updated_at: now,
  });
  if (!parsed.success) {
    throw new Error(`createSession produced an invalid Session: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** An IdeaCase without its history — what a version snapshots and diffs use. */
export function bodyOf(idea: IdeaCase): IdeaCaseBody {
  const { version_history: _omitted, ...body } = idea;
  return body;
}

export function snapshotOf(idea: IdeaCase): IdeaCaseSnapshot {
  return structuredClone(bodyOf(idea));
}
