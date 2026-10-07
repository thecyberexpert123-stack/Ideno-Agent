/**
 * The State Manager: the only component allowed to mutate an Idea State.
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Integrity.** Every mutation is applied to a clone, re-validated against
 *     `IdeaCaseBodySchema`, and only then committed. A change that cannot be
 *     applied is skipped and reported; a batch that cannot be validated is
 *     discarded whole.
 *  2. **Human authority.** Changes are split into those grounded in the user's
 *     own words (applied) and those the model inferred (queued for Accept /
 *     Reject). Nothing the model invented enters the state silently.
 *  3. **History.** Every commit produces a version with a full snapshot, a
 *     `parent_id` and a `branch_id`, so "what changed" is a diff of two snapshots
 *     and alternative timelines are branches of one tree.
 *  4. **Durability.** The open session is persisted after every mutation, one idea
 *     per storage record. When the browser runs out of room the oldest dispensable
 *     snapshots are pruned and the write is retried; only if that still fails does
 *     persistence degrade to a warning. Losing the idea is the failure this file
 *     exists to prevent.
 *  5. **Bounded memory.** The transcript and the change log are pruned at append
 *     time, so a long session cannot grow into a workspace that no longer
 *     validates and therefore cannot be saved at all.
 */
import {
  BranchSchema,
  IdeaCaseSchema,
  MAX_BRANCHES,
  MAX_WORKSPACE_IDEAS,
  changeLogLimit,
  parseSession,
  transcriptLimit,
  SessionRecordSchema,
  TranscriptEntrySchema,
  WORKSPACE_INDEX_KEY,
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceIndexSchema,
  sessionStorageKey,
  LEGACY_WORKSPACE_KEY,
  type Branch,
  type ChangeRecord,
  type ChangeSetInput,
  type IdeaCase,
  type IdeaCaseBody,
  type IdeaPhase,
  type Question,
  type ReviewMode,
  type Session,
  type SessionLimits,
  type TranscriptEntry,
  type TranscriptRole,
  type VersionRecord,
  type VersionTrigger,
  type Workspace,
  WorkspaceIndexEntrySchema,
  type WorkspaceIndex,
  type WorkspaceIndexEntry,
} from '../schemas/index.js';
import { newId, systemClock, type Clock } from '../ids.js';
import { IdenoStateError } from '../errors.js';
import {
  bodyOf,
  createHistoryRoot,
  createIdeaCase,
  createSession,
  snapshotOf,
} from '../idea_state/create.js';
import { deriveCurrentState } from '../idea_state/selectors.js';
import { diffBodies, describeEntries } from '../versioning/diff.js';
import {
  activeBranch,
  branchVersions,
  findBranch,
  findVersion,
  prunableVersions,
  suggestBranchName,
} from '../versioning/branch.js';
import {
  applyRecords,
  buildChangeRecords,
  normalizeQuestion,
  validateBody,
  validateBranchIntegrity,
} from './apply.js';
import { MemoryStore, isQuotaError, messageOf, type Store } from './store.js';
import { migrateStoredSession, type MigrationNote } from './migration.js';

/** Key of the v0.1 single-blob workspace. Read for migration; never written. */
export const WORKSPACE_STORAGE_KEY = LEGACY_WORKSPACE_KEY;

/**
 * Versions kept per idea. Past this, the oldest *snapshots* that are not a branch
 * head, not labelled and not the original idea are dropped so that the current
 * state stays savable. The version records themselves are always kept.
 *
 * v0.1 capped this at 1000 and threw when the cap was reached — after the state
 * had already been written, so a successful change surfaced as a failure and no
 * version recorded it. 400 is the point at which a full-snapshot history
 * realistically stops fitting in browser storage; the pruning rules in
 * `prunableVersions` decide what goes.
 */
export const MAX_VERSIONS = 400;

/** Snapshots of the most recent versions per branch that pruning never touches. */
const KEEP_RECENT_SNAPSHOTS = 8;
/**
 * How many prune-and-retry rounds a quota failure gets before giving up.
 *
 * One snapshot is dropped per round, so this bounds the work a single failing save
 * can do. A history is capped at `MAX_VERSIONS`, so 64 rounds cover the realistic
 * worst case (a store that only accepts the bare current state) without ever
 * turning one save into an unbounded loop.
 */
const MAX_QUOTA_RETRIES = 64;

export type StateEvent =
  | { type: 'session_started'; session_id: string; idea_id: string }
  | { type: 'session_opened'; session_id: string; idea_id: string }
  | { type: 'session_archived'; session_id: string }
  | { type: 'index_updated'; index: WorkspaceIndex }
  | { type: 'version_committed'; version: VersionRecord; trigger: VersionTrigger }
  | { type: 'branch_created'; branch: Branch }
  | { type: 'branch_switched'; branch: Branch }
  | { type: 'changes_queued'; changes: ChangeRecord[] }
  | { type: 'change_resolved'; change: ChangeRecord }
  | { type: 'transcript_appended'; entry: TranscriptEntry }
  | { type: 'integrity'; message: string }
  | { type: 'persistence'; persistent: boolean; reason: string | null }
  | { type: 'session_cleared' };

export type StateListener = (event: StateEvent) => void;

export interface StateManagerOptions {
  store?: Store;
  clock?: Clock;
  /** Persist after every mutation. Disabled in tests that do not care. */
  persist?: boolean;
  /** Overrides `MAX_VERSIONS`. Tests use a small value to exercise pruning. */
  maxVersions?: number;
  /** Overrides `KEEP_RECENT_SNAPSHOTS`. */
  keepRecentSnapshots?: number;
  /**
   * Bounds on the transcript and change log. Defaults to the schema constants;
   * lowered for a constrained store (or in tests, so the bound can be exercised
   * without running two thousand real mutations).
   */
  limits?: SessionLimits;
  /**
   * Coalesce writes: mark the session dirty and write it once, `coalesceMs` after
   * the last mutation, instead of once per mutation.
   *
   * Off by default, because synchronous saving is what every test asserts and what
   * a caller expects from "the session is persisted after every mutation". The UI
   * turns it on, where the alternative is measurable: a save serialises the whole
   * record including every version snapshot, so a 400-change session costs 5.5 s of
   * repeated serialisation against ~0.6 s when the writes are coalesced.
   *
   * The trade is explicit and small: a crash inside the coalescing window loses the
   * mutations made in that window, and nothing else. `flush()` writes immediately
   * and is called on `pagehide`, when another idea is opened, and before anything
   * that reads the stored copy back.
   */
  coalesceMs?: number;
}

export interface EnqueueMeta {
  origin: ChangeRecord['origin_operation'];
  message_id: string | null;
  /** Shown on every review card produced by this batch. */
  rationale?: string;
  review_mode?: ReviewMode;
  trigger?: VersionTrigger;
  /** Overrides the diff-derived summary. */
  summary?: string;
  /** Session guard from `StateManager.guard`; see `assertGuard`. */
  guard?: string;
}

export interface EnqueueResult {
  records: ChangeRecord[];
  /** Records waiting for the human. */
  pending: ChangeRecord[];
  /** Records written to the state in this call. */
  applied: ChangeRecord[];
  version: VersionRecord | null;
  /** Downgrades, dropped references and skipped records. Always surfaced. */
  integrity_notes: string[];
}

export type LoadOutcome =
  | { status: 'loaded'; session: Session; notes: MigrationNote[] }
  | { status: 'empty' }
  | { status: 'corrupt'; reason: string }
  | { status: 'unsupported_version'; found: number }
  | { status: 'storage_error'; reason: string };

export type OpenOutcome =
  | { status: 'opened'; session: Session; notes: MigrationNote[] }
  | { status: 'missing'; session_id: string }
  | { status: 'corrupt'; session_id: string; reason: string }
  | { status: 'unsupported_version'; session_id: string; found: number }
  | { status: 'storage_error'; reason: string };

export class StateManager {
  #session: Session | null = null;
  #store: Store;
  #clock: Clock;
  #persistEnabled: boolean;
  #listeners = new Set<StateListener>();
  #persistenceWarning: string | null = null;
  #pruningNotice: string | null = null;
  #maxVersions: number;
  #keepRecentSnapshots: number;
  #limits: SessionLimits;
  #coalesceMs: number;
  #dirty = false;
  #scheduled: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped whenever the active session changes. A turn in flight holds the value
   * it started with, so opening another idea mid-turn makes the old turn fail
   * cleanly instead of writing its changes into the newly opened one.
   */
  #generation = 0;

  constructor(options: StateManagerOptions = {}) {
    this.#store = options.store ?? new MemoryStore();
    this.#clock = options.clock ?? systemClock;
    this.#persistEnabled = options.persist ?? true;
    this.#maxVersions = Math.max(1, options.maxVersions ?? MAX_VERSIONS);
    this.#keepRecentSnapshots = Math.max(0, options.keepRecentSnapshots ?? KEEP_RECENT_SNAPSHOTS);
    this.#limits = options.limits ?? {};
    this.#coalesceMs = Math.max(0, options.coalesceMs ?? 0);
  }

  /**
   * Writes any coalesced-but-unwritten state now.
   *
   * Returns whether the stored copy is believed to be current. Callers use it
   * before reading storage back, before opening another idea, and on the way out
   * of the page.
   */
  flush(): boolean {
    if (this.#scheduled !== null) {
      clearTimeout(this.#scheduled);
      this.#scheduled = null;
    }
    if (!this.#dirty) return this.#persistenceWarning === null;
    this.#dirty = false;
    this.#writeNow();
    return this.#persistenceWarning === null;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get session(): Session | null {
    return this.#session;
  }

  get idea(): IdeaCase | null {
    return this.#session?.idea ?? null;
  }

  get body(): IdeaCaseBody | null {
    return this.#session ? bodyOf(this.#session.idea) : null;
  }

  get hasSession(): boolean {
    return this.#session !== null;
  }

  get activeSessionId(): string | null {
    return this.#session?.id ?? null;
  }

  get persistenceWarning(): string | null {
    return this.#persistenceWarning;
  }

  /**
   * Token identifying the currently open session.
   *
   * A long-running operation (an orchestrator turn) captures this before its first
   * await and passes it back with each mutation. If the user opened a different
   * idea in the meantime the token no longer matches and the mutation is refused —
   * which is the difference between "that turn failed, your other idea is intact"
   * and two ideas silently sharing one conversation.
   */
  get guard(): string {
    return `${this.#session?.id ?? 'none'}@${this.#generation}`;
  }

  /** Throws unless `guard` still refers to the open session. */
  assertGuard(guard: string | undefined, context: string): void {
    if (guard === undefined) return;
    if (guard !== this.guard) {
      throw new IdenoStateError(
        'session_changed',
        `${context} was abandoned because a different idea was opened while it was running. Nothing was written to either idea.`,
      );
    }
  }

  pendingChanges(): ChangeRecord[] {
    return this.#session?.change_log.filter((record) => record.status === 'pending') ?? [];
  }

  changeLog(): ChangeRecord[] {
    return this.#session?.change_log ?? [];
  }

  /** Every version ever recorded, in the order they were committed. */
  versions(): VersionRecord[] {
    return this.#session?.idea.version_history ?? [];
  }

  /** Versions on the active branch, oldest first. */
  branchVersions(branchId?: string | null): VersionRecord[] {
    const idea = this.#session?.idea;
    if (!idea) return [];
    const branch = branchId === undefined ? activeBranch(idea) : findBranch(idea, branchId);
    return branchVersions(branch, idea.version_history);
  }

  branches(): Branch[] {
    return this.#session?.idea.branches ?? [];
  }

  activeBranch(): Branch | null {
    return this.#session ? activeBranch(this.#session.idea) : null;
  }

  latestVersion(): VersionRecord | null {
    const history = this.versions();
    return history.length > 0 ? (history[history.length - 1] as VersionRecord) : null;
  }

  transcript(): TranscriptEntry[] {
    return this.#session?.transcript ?? [];
  }

  /**
   * Moves persistence to a different store, keeping the open session.
   *
   * Used once, at boot, when the desktop host turns out to be available: the app
   * starts with whatever the browser offers and then upgrades to real files. The
   * pending write is flushed to the *old* store first so nothing is lost by the
   * switch, and the session is written to the new one immediately, so a crash right
   * after the switch still leaves the idea on disk.
   */
  setStore(store: Store): void {
    this.flush();
    this.#store = store;
    if (this.#persistEnabled && this.#session) this.#writeNow();
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Workspace: several ideas, one open at a time
  // -------------------------------------------------------------------------

  /**
   * The list of ideas in this workspace, most recently updated first.
   *
   * Reads the index record only. Loading every idea to render a switcher would
   * reintroduce exactly the cost the split storage layout removed.
   */
  listIdeas(): WorkspaceIndexEntry[] {
    return this.#mergedIndex()
      .entries.slice()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  archivedIdeas(): WorkspaceIndexEntry[] {
    return this.listIdeas().filter((entry) => entry.archived);
  }

  /**
   * Starts a brand new idea and opens it, replacing any in-memory session.
   *
   * The previous idea is *not* discarded: it stays in the workspace and can be
   * reopened from the switcher. That is the whole point of a multi-idea workspace,
   * and it is also why this is safe to expose as a button.
   */
  startSession(originalIdea: string, title?: string): Session {
    const index = this.#readIndex();
    if (index.entries.length >= MAX_WORKSPACE_IDEAS) {
      throw new IdenoStateError(
        'capacity',
        `This workspace already holds ${MAX_WORKSPACE_IDEAS} ideas. Archive or export one before starting another.`,
      );
    }

    const root = createHistoryRoot(this.#clock);
    const idea = createIdeaCase({ original_idea: originalIdea, title, clock: this.#clock, root });
    const session = createSession(idea, this.#clock);

    // v0 is the raw idea, exactly as the user gave it. Its snapshot can only be
    // taken once the case exists, which is why the root pair is minted first and
    // the snapshot filled in here.
    root.version.snapshot = snapshotOf(idea);
    session.idea.version_history.push(root.version);

    this.#adopt(session);
    this.#emit({ type: 'session_started', session_id: session.id, idea_id: idea.id });
    this.#persist();
    return session;
  }

  /**
   * Opens an idea already in the workspace. Returns why it could not be opened
   * rather than throwing, because "that idea is corrupt" is a state the UI has to
   * be able to render while the rest of the workspace keeps working.
   */
  openSession(sessionId: string): OpenOutcome {
    let raw: string | null;
    try {
      raw = this.#store.read(sessionStorageKey(sessionId));
    } catch (error) {
      return { status: 'storage_error', reason: messageOf(error) };
    }
    if (raw === null) return { status: 'missing', session_id: sessionId };

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', session_id: sessionId, reason: 'The stored idea is not valid JSON.' };
    }

    const migrated = migrateStoredSession(json, this.#limits);
    if (!migrated.ok) {
      return migrated.status === 'unsupported_version'
        ? { status: 'unsupported_version', session_id: sessionId, found: migrated.found }
        : { status: 'corrupt', session_id: sessionId, reason: migrated.reason };
    }

    this.#adopt(migrated.result.session);
    this.#emit({
      type: 'session_opened',
      session_id: migrated.result.session.id,
      idea_id: migrated.result.session.idea.id,
    });
    for (const note of migrated.result.notes) this.#emit({ type: 'integrity', message: note.message });
    this.#persist();
    return { status: 'opened', session: migrated.result.session, notes: migrated.result.notes };
  }

  /**
   * Retires an idea from the switcher without deleting it.
   *
   * Archiving is reversible and keeps the data; deletion is neither, so it is not
   * offered here. `clearPersisted()` remains the explicit "wipe this browser"
   * action, behind a confirmation in the UI.
   */
  archiveSession(sessionId: string, options: { archived?: boolean } = {}): void {
    const archived = options.archived ?? true;
    const index = this.#readIndex();
    const entry = index.entries.find((candidate) => candidate.session_id === sessionId);
    if (!entry) {
      throw new IdenoStateError('unknown_change', `No idea with session id "${sessionId}" in this workspace.`);
    }
    if (archived && this.#session?.id === sessionId) {
      // Archiving the idea you are looking at leaves you staring at a session that
      // is no longer listed. Close it: the state stays in memory until another
      // idea is opened, but the switcher and the index agree.
      this.#session = null;
      this.#generation += 1;
      this.#emit({ type: 'session_cleared' });
    }
    entry.archived = archived;
    this.#writeIndex(index);
    this.#emit({ type: 'session_archived', session_id: sessionId });
  }

  /** Drops one idea's stored record. Used by tests and by an explicit user reset. */
  removeStoredSession(sessionId: string): void {
    try {
      this.#store.remove(sessionStorageKey(sessionId));
    } catch (error) {
      this.#emit({ type: 'integrity', message: `Could not remove the stored idea: ${messageOf(error)}` });
      return;
    }
    const index = this.#readIndex();
    index.entries = index.entries.filter((entry) => entry.session_id !== sessionId);
    if (index.active_session_id === sessionId) index.active_session_id = this.#session?.id ?? null;
    this.#writeIndex(index);
  }

  /** Reads whatever is persisted: the v2 index, or the v0.1 blob to migrate. */
  loadPersisted(): LoadOutcome {
    let raw: string | null;
    try {
      raw = this.#store.read(WORKSPACE_INDEX_KEY);
    } catch (error) {
      return { status: 'storage_error', reason: messageOf(error) };
    }

    if (raw !== null) return this.#loadFromIndex(raw);

    // No index: either a fresh browser or a v0.1 workspace.
    try {
      raw = this.#store.read(WORKSPACE_STORAGE_KEY);
    } catch (error) {
      return { status: 'storage_error', reason: messageOf(error) };
    }
    if (raw === null) return { status: 'empty' };
    return this.#loadLegacy(raw);
  }

  #loadFromIndex(raw: string): LoadOutcome {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', reason: 'The stored workspace index is not valid JSON.' };
    }

    const version = versionOf(json);
    if (version !== null && version > WORKSPACE_SCHEMA_VERSION) {
      return { status: 'unsupported_version', found: version };
    }

    const parsed = WorkspaceIndexSchema.safeParse(json);
    if (!parsed.success) {
      return { status: 'corrupt', reason: firstIssue(parsed.error) };
    }

    // The index is metadata; the ideas are the data. A corrupt index entry must
    // not stop the readable ideas from being listed, and a missing active session
    // must not stop the others from being opened.
    const activeId = parsed.data.active_session_id ?? parsed.data.entries[0]?.session_id ?? null;
    if (!activeId) return { status: 'empty' };

    const opened = this.openSession(activeId);
    if (opened.status === 'opened') return { status: 'loaded', session: opened.session, notes: opened.notes };
    if (opened.status === 'unsupported_version') {
      return { status: 'unsupported_version', found: opened.found };
    }
    if (opened.status === 'storage_error') return { status: 'storage_error', reason: opened.reason };

    // The active idea is unusable. Try the others before giving up, and report
    // what was wrong with the first one so the user is not left guessing.
    const reason =
      opened.status === 'corrupt' ? opened.reason : `No stored idea was found for session "${opened.session_id}".`;
    for (const entry of parsed.data.entries) {
      if (entry.session_id === activeId || entry.archived) continue;
      const fallback = this.openSession(entry.session_id);
      if (fallback.status === 'opened') {
        this.#emit({
          type: 'integrity',
          message: `The idea that was open could not be read (${reason}). "${entry.title}" was opened instead.`,
        });
        return { status: 'loaded', session: fallback.session, notes: fallback.notes };
      }
    }
    return { status: 'corrupt', reason };
  }

  #loadLegacy(raw: string): LoadOutcome {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { status: 'corrupt', reason: 'Stored workspace is not valid JSON.' };
    }

    const migrated = migrateStoredSession(json, this.#limits);
    if (!migrated.ok) {
      return migrated.status === 'unsupported_version'
        ? { status: 'unsupported_version', found: migrated.found }
        : { status: 'corrupt', reason: migrated.reason };
    }

    this.#adopt(migrated.result.session);
    for (const note of migrated.result.notes) this.#emit({ type: 'integrity', message: note.message });
    this.#emit({ type: 'session_started', session_id: this.#session!.id, idea_id: this.#session!.idea.id });

    // Rewrite into the new layout now, so the migration happens once and the
    // legacy blob stops being the only copy of the idea.
    this.#persist();
    try {
      this.#store.remove(WORKSPACE_STORAGE_KEY);
    } catch (error) {
      this.#emit({
        type: 'integrity',
        message: `The old workspace copy could not be removed (${messageOf(error)}); it is no longer used.`,
      });
    }
    return { status: 'loaded', session: this.#session!, notes: migrated.result.notes };
  }

  /** Makes `session` the open one and invalidates any in-flight turn's guard. */
  #adopt(session: Session): void {
    // Whatever was open must reach storage before it stops being open, or a
    // coalesced write would land after the switch and overwrite the new idea's
    // record with the old one's contents.
    this.flush();
    this.#session = session;
    this.#generation += 1;
    this.#pruningNotice = null;
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  /**
   * The current session as a storable record, or null when nothing is open.
   *
   * Deliberately *not* re-validated. The in-memory session is valid by
   * construction: every mutation is applied to a clone, checked with
   * `validateBody` and `validateBranchIntegrity`, and only then committed, and the
   * append-only collections are bounded at append time. Re-parsing it here would
   * cost a full schema walk of every version snapshot on every keystroke-scale
   * mutation — measured, that single mistake made a 400-change session take 28 s
   * instead of well under one.
   *
   * Validation runs where it can actually catch something: on load, on import, and
   * on export (`exportJson`).
   */
  toWorkspace(): Workspace | null {
    if (!this.#session) return null;
    return {
      schema_version: WORKSPACE_SCHEMA_VERSION,
      session: this.#session,
      saved_at: this.#clock(),
    };
  }

  /**
   * Serialises the open idea for download.
   *
   * This path *does* validate in full and returns null rather than writing a file
   * that a future Ideno would refuse to read: an export is a long-lived artefact,
   * and it is written once, so the cost belongs here rather than on every save.
   */
  exportJson(): string | null {
    if (!this.#session) return null;
    const bounded = parseSession(this.#session, this.#limits);
    if (!bounded.success) {
      this.#warnOnce(`The idea could not be exported because it failed validation (${firstIssue(bounded.error)}).`);
      return null;
    }
    const record = SessionRecordSchema.safeParse({
      schema_version: WORKSPACE_SCHEMA_VERSION,
      session: bounded.data,
      saved_at: this.#clock(),
    });
    if (!record.success) {
      this.#warnOnce(`The idea could not be exported (${firstIssue(record.error)}).`);
      return null;
    }
    return JSON.stringify(record.data, null, 2);
  }

  /**
   * Imports an idea from a file exported by any supported version of Ideno,
   * validating and migrating it fully.
   *
   * The imported idea becomes a *new* session in this workspace rather than
   * replacing the open one, so importing a file can never destroy the idea the
   * user is currently working on.
   */
  importJson(json: string): { ok: true; session: Session } | { ok: false; reason: string } {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json);
    } catch {
      return { ok: false, reason: 'That file is not valid JSON.' };
    }

    const migrated = migrateStoredSession(parsedJson, this.#limits);
    if (!migrated.ok) {
      return migrated.status === 'unsupported_version'
        ? { ok: false, reason: `That file was written by a newer version of Ideno (format v${migrated.found}).` }
        : { ok: false, reason: migrated.reason };
    }

    const index = this.#readIndex();
    if (index.entries.length >= MAX_WORKSPACE_IDEAS) {
      return {
        ok: false,
        reason: `This workspace already holds ${MAX_WORKSPACE_IDEAS} ideas. Archive one before importing another.`,
      };
    }

    const session = migrated.result.session;
    if (index.entries.some((entry) => entry.session_id === session.id)) {
      // Same id as an idea already here: give the import its own identity rather
      // than overwriting the existing one.
      session.id = newId('session');
    }
    session.updated_at = this.#clock();

    this.#adopt(session);
    this.#emit({ type: 'session_started', session_id: session.id, idea_id: session.idea.id });
    for (const note of migrated.result.notes) this.#emit({ type: 'integrity', message: note.message });
    this.#persist();
    return { ok: true, session };
  }

  /**
   * Closes the open idea without touching storage.
   *
   * This is what "New idea" does now that a workspace holds many ideas: the open
   * session is flushed and then let go, and everything already stored stays
   * exactly where it is. Compare `resetSession`, which wipes the workspace and is
   * only reached from an explicit, confirmed "clear this browser's data".
   */
  closeSession(): void {
    this.flush();
    this.#session = null;
    this.#generation += 1;
    this.#pruningNotice = null;
    // The index keeps its entry for the idea that was just closed, and stops
    // claiming a session is open.
    const index = this.#readIndex();
    index.active_session_id = null;
    this.#writeIndex(index);
    this.#emit({ type: 'session_cleared' });
  }

  /**
   * Ends the session and clears stored data, so a new idea can start from nothing.
   * Everything in this browser's workspace is gone unless it was exported first —
   * which is why the UI confirms before calling this.
   */
  resetSession(): void {
    if (this.#scheduled !== null) {
      clearTimeout(this.#scheduled);
      this.#scheduled = null;
    }
    this.#dirty = false;
    this.#session = null;
    this.#generation += 1;
    this.clearPersisted();
    this.#emit({ type: 'session_cleared' });
  }

  clearPersisted(): void {
    const index = this.#readIndex();
    for (const entry of index.entries) {
      try {
        this.#store.remove(sessionStorageKey(entry.session_id));
      } catch (error) {
        this.#emit({ type: 'integrity', message: `Could not clear a stored idea: ${messageOf(error)}` });
      }
    }
    for (const key of [WORKSPACE_INDEX_KEY, WORKSPACE_STORAGE_KEY]) {
      try {
        this.#store.remove(key);
      } catch (error) {
        this.#emit({ type: 'integrity', message: `Could not clear stored workspace: ${messageOf(error)}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Index record
  // -------------------------------------------------------------------------

  #readIndex(): WorkspaceIndex {
    let raw: string | null = null;
    try {
      raw = this.#store.read(WORKSPACE_INDEX_KEY);
    } catch {
      // An unreadable index is treated as an empty one: the ideas themselves are
      // still in their own records, and a broken index must not make the whole
      // workspace look empty.
    }
    if (raw === null) {
      return {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        active_session_id: null,
        entries: [],
        saved_at: this.#clock(),
      };
    }
    try {
      const parsed = WorkspaceIndexSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      this.#emit({ type: 'integrity', message: `The workspace index was unreadable (${firstIssue(parsed.error)}) and was rebuilt.` });
    } catch {
      this.#emit({ type: 'integrity', message: 'The workspace index was not valid JSON and was rebuilt.' });
    }
    return {
      schema_version: WORKSPACE_SCHEMA_VERSION,
      active_session_id: null,
      entries: [],
      saved_at: this.#clock(),
    };
  }

  /** The index entry for the open session, derived from live state. */
  #entryFor(session: Session): WorkspaceIndexEntry {
    const idea = session.idea;
    const pending = session.change_log.filter((record) => record.status === 'pending').length;
    const entry: WorkspaceIndexEntry = {
      session_id: session.id,
      idea_id: idea.id,
      title: idea.title,
      phase: idea.current_state as IdeaPhase,
      pending,
      versions: idea.version_history.length,
      archived: false,
      created_at: session.created_at,
      updated_at: session.updated_at,
    };
    return WorkspaceIndexEntrySchema.parse(entry);
  }

  #writeIndex(index: WorkspaceIndex): void {
    index.schema_version = WORKSPACE_SCHEMA_VERSION;
    index.saved_at = this.#clock();
    const parsed = WorkspaceIndexSchema.safeParse(index);
    if (!parsed.success) {
      this.#warnOnce(`The workspace index failed validation and was not saved (${firstIssue(parsed.error)}).`);
      return;
    }
    try {
      this.#store.write(WORKSPACE_INDEX_KEY, JSON.stringify(parsed.data));
      this.#emit({ type: 'index_updated', index: parsed.data });
    } catch (error) {
      const message = `The workspace list could not be saved (${messageOf(error)}).`;
      if (isQuotaError(error) && this.#persistenceWarning) {
        // The idea itself already failed to save, and that warning is the one with
        // an action attached to it ("export now"). Report the index failure as an
        // integrity note rather than replacing the more urgent message.
        this.#emit({ type: 'integrity', message });
        return;
      }
      this.#warnOnce(message);
    }
  }

  /**
   * The stored index with the open session's entry brought up to date.
   *
   * This is not a cosmetic merge. Writes are coalesced, so the stored index can lag
   * behind the session in memory by a few hundred milliseconds — and a workspace
   * switcher built from the stored copy alone would show a stale title, phase,
   * version count and review count for *the very idea the user is looking at*.
   * Deriving that one entry from live state makes the list correct at every moment,
   * while every other idea is still read from storage, which is the only place it
   * exists.
   */
  #mergedIndex(): WorkspaceIndex {
    const index = this.#readIndex();
    if (!this.#session) return index;

    const entry = this.#entryFor(this.#session);
    const existing = index.entries.find((candidate) => candidate.session_id === entry.session_id);
    if (existing) {
      entry.archived = existing.archived;
      // An idea stored before it appeared in the index keeps its own creation time.
      entry.created_at = existing.created_at;
      Object.assign(existing, entry);
    } else {
      index.entries.push(entry);
    }
    return index;
  }

  /** The index as it should be written: merged, with this session marked active. */
  #updateIndexEntry(): WorkspaceIndex {
    const index = this.#mergedIndex();
    if (this.#session) index.active_session_id = this.#session.id;
    return index;
  }

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------

  appendTranscript(input: {
    role: TranscriptRole;
    text: string;
    turn_id?: string | null;
    operation?: TranscriptEntry['operation'];
    classification?: TranscriptEntry['classification'];
    reasoning_summary?: string | null;
    question?: Question | null;
    error_code?: string | null;
    raw_text?: string | null;
    guard?: string;
  }): TranscriptEntry {
    const session = this.#requireSession('appendTranscript');
    this.assertGuard(input.guard, 'This turn');
    const parsed = TranscriptEntrySchema.safeParse({
      id: newId('msg'),
      role: input.role,
      text: input.text.trim(),
      created_at: this.#clock(),
      turn_id: input.turn_id ?? null,
      operation: input.operation ?? null,
      classification: input.classification ?? null,
      reasoning_summary: input.reasoning_summary ?? null,
      question: input.question ?? null,
      error_code: input.error_code ?? null,
      raw_text: input.raw_text ?? null,
    });
    if (!parsed.success) {
      throw new IdenoStateError('invalid_state', `Transcript entry rejected: ${parsed.error.message}`);
    }

    session.transcript.push(parsed.data);
    this.#pruneTranscript(session);
    this.#touch();
    this.#persist();
    this.#emit({ type: 'transcript_appended', entry: parsed.data });
    return parsed.data;
  }

  /**
   * Keeps the transcript inside its schema bound.
   *
   * Without this the array grows past `MAX_TRANSCRIPT_ENTRIES`, the session stops
   * validating, and every subsequent save writes nothing — a silent total loss on
   * reload. The oldest entries go first; the idea state itself is never affected,
   * because the state does not depend on the transcript to be complete.
   */
  #pruneTranscript(session: Session): void {
    const limit = transcriptLimit(this.#limits);
    const excess = session.transcript.length - limit;
    if (excess <= 0) return;
    session.transcript.splice(0, excess);
    this.#notePruning(
      `The conversation reached its limit of ${limit} messages; the ${excess} oldest were dropped from this idea's stored transcript. The idea state is unaffected.`,
    );
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  /**
   * The main entry point: takes a validated change set, splits it into what the
   * human already said and what the model inferred, applies the former, queues
   * the latter, and commits one version for whatever was applied.
   */
  enqueueChanges(changeset: ChangeSetInput, meta: EnqueueMeta): EnqueueResult {
    const session = this.#requireSession('enqueueChanges');
    this.assertGuard(meta.guard, 'This turn');
    const integrityNotes: string[] = [];

    const built = buildChangeRecords({
      changeset,
      body: bodyOf(session.idea),
      origin: meta.origin,
      message_id: meta.message_id,
      rationale: meta.rationale,
      clock: this.#clock,
    });
    integrityNotes.push(...built.notes);

    if (built.records.length === 0) {
      return { records: [], pending: [], applied: [], version: null, integrity_notes: integrityNotes };
    }

    const reviewMode = meta.review_mode ?? 'assisted';
    const applied: ChangeRecord[] = [];
    const pending: ChangeRecord[] = [];
    for (const record of built.records) {
      if (shouldAutoApply(record, reviewMode)) applied.push(record);
      else pending.push(record);
    }

    session.change_log.push(...built.records);
    this.#pruneChangeLog(session);

    let version: VersionRecord | null = null;
    if (applied.length > 0) {
      const commit = this.#commit(applied, {
        trigger: meta.trigger ?? 'turn',
        message_id: meta.message_id,
        summary: meta.summary,
        // Changes the user authored are recorded as accepted; changes applied
        // without a separate click are recorded as auto_accepted, so the audit
        // trail can tell "you did this" from "this went in unreviewed".
        status: 'auto_accepted',
      });
      version = commit.version;
      integrityNotes.push(...commit.notes);
    }

    if (pending.length > 0) this.#emit({ type: 'changes_queued', changes: pending });

    this.#touch();
    this.#persist();

    return {
      records: built.records,
      pending,
      applied: applied.filter((record) => record.status !== 'rejected'),
      version,
      integrity_notes: integrityNotes,
    };
  }

  /**
   * Keeps the change log inside its schema bound.
   *
   * Resolved records go first, oldest first, because they are the audit trail
   * behind versions that have long since been read; `pending` records are the live
   * review queue and are pruned last, so a rejection is never silently dropped
   * while the user still has it in front of them.
   */
  #pruneChangeLog(session: Session): void {
    const limit = changeLogLimit(this.#limits);
    const excess = session.change_log.length - limit;
    if (excess <= 0) return;

    const resolved = session.change_log.filter((record) => record.status !== 'pending');
    const drop = new Set(resolved.slice(0, excess).map((record) => record.id));
    if (drop.size < excess) {
      for (const record of session.change_log) {
        if (drop.size >= excess) break;
        if (record.status === 'pending') drop.add(record.id);
      }
    }
    session.change_log = session.change_log.filter((record) => !drop.has(record.id));
    this.#notePruning(
      `The change log reached its limit of ${limit} entries; ${drop.size} of the oldest were dropped. Pending reviews are kept until there is nothing else left to drop.`,
    );
  }

  /** Accepts one queued change and commits the resulting version. */
  acceptChange(changeId: string, options: { summary?: string; guard?: string } = {}): VersionRecord | null {
    return this.acceptChanges([changeId], options);
  }

  /**
   * Accepts several queued changes as one version. Accepting a batch is the
   * normal case after a turn proposes several related inferences; committing them
   * together keeps the history readable instead of producing ten one-line
   * versions.
   */
  acceptChanges(
    changeIds: string[],
    options: { summary?: string; guard?: string } = {},
  ): VersionRecord | null {
    const session = this.#requireSession('acceptChanges');
    this.assertGuard(options.guard, 'This review');
    const records: ChangeRecord[] = [];
    for (const id of changeIds) {
      const record = session.change_log.find((entry) => entry.id === id);
      if (!record) throw new IdenoStateError('unknown_change', `No change record with id "${id}".`);
      if (record.status !== 'pending') continue; // already resolved: not an error
      records.push(record);
    }
    if (records.length === 0) return null;

    const commit = this.#commit(records, {
      trigger: 'accept',
      message_id: records[0]?.message_id ?? null,
      summary: options.summary,
      status: 'accepted',
    });
    this.#touch();
    this.#persist();
    return commit.version;
  }

  /**
   * Rejecting a change does not alter the idea, so it produces no version. The
   * rejection itself is kept in the change log: "we considered this and said no"
   * is part of the record of how the idea developed.
   */
  rejectChange(changeId: string, reason?: string, options: { guard?: string } = {}): ChangeRecord {
    const session = this.#requireSession('rejectChange');
    this.assertGuard(options.guard, 'This review');
    const record = session.change_log.find((entry) => entry.id === changeId);
    if (!record) throw new IdenoStateError('unknown_change', `No change record with id "${changeId}".`);
    if (record.status !== 'pending') {
      throw new IdenoStateError('unknown_change', `Change ${changeId} was already ${record.status}.`);
    }

    this.#markRejected(record, reason);
    this.#touch();
    this.#persist();
    return record;
  }

  /**
   * Rejects everything in the review queue as one action.
   *
   * One persist, not one per record: rejecting twelve proposals used to
   * serialise and re-validate the whole workspace twelve times.
   */
  rejectAllPending(reason?: string, options: { guard?: string } = {}): number {
    this.#requireSession('rejectAllPending');
    this.assertGuard(options.guard, 'This review');
    const pending = this.pendingChanges();
    if (pending.length === 0) return 0;

    for (const record of pending) {
      this.#markRejected(record, reason);
    }
    this.#touch();
    this.#persist();
    return pending.length;
  }

  #markRejected(record: ChangeRecord, reason?: string): void {
    record.status = 'rejected';
    record.resolved_at = this.#clock();
    record.rejection_reason = reason?.trim() ? reason.trim().slice(0, 400) : 'Rejected by the user.';
    this.#emit({ type: 'change_resolved', change: record });
  }

  // -------------------------------------------------------------------------
  // User-initiated state changes
  // -------------------------------------------------------------------------

  /**
   * Records evidence supplied by the human. This is the one way `evidence`
   * provenance enters the state without a registered research source, and it is
   * applied immediately because the user is its author.
   */
  addUserEvidence(input: {
    claim: string;
    source_title: string;
    source_locator: string;
    relevance: string;
    confidence: number;
    publisher?: string | null;
    notes?: string | null;
    guard?: string;
  }): EnqueueResult {
    return this.enqueueChanges(
      {
        evidence_added: [
          {
            claim: input.claim,
            source: {
              title: input.source_title,
              locator: input.source_locator,
              publisher: input.publisher ?? null,
            },
            relevance: input.relevance,
            confidence: input.confidence,
            origin: 'user_supplied',
            notes: input.notes ?? null,
          },
        ],
      },
      {
        origin: 'user',
        message_id: null,
        rationale: 'Evidence supplied by you.',
        trigger: 'user_edit',
        guard: input.guard,
      },
    );
  }

  /** Records a decision the human made, optionally selecting an alternative. */
  recordUserDecision(input: {
    decision: string;
    rationale?: string | null;
    alternative_id?: string | null;
    rejected_alternative_ids?: string[];
    guard?: string;
  }): EnqueueResult {
    const changeset: ChangeSetInput = {
      decisions_added: [
        {
          text: input.decision,
          rationale: input.rationale ?? null,
          decided_by: 'user',
          alternatives_considered: input.alternative_id
            ? [input.alternative_id, ...(input.rejected_alternative_ids ?? [])]
            : (input.rejected_alternative_ids ?? []),
        },
      ],
    };
    if (input.alternative_id) changeset.selected_alternative_id = input.alternative_id;

    return this.enqueueChanges(changeset, {
      origin: 'user',
      message_id: null,
      rationale: 'Decision made by you.',
      trigger: 'decision',
      guard: input.guard,
    });
  }

  /** Selects an alternative without recording a decision. */
  selectAlternative(alternativeId: string | null, options: { guard?: string } = {}): EnqueueResult {
    return this.enqueueChanges(
      { selected_alternative_id: alternativeId },
      {
        origin: 'user',
        message_id: null,
        rationale: 'Selected by you.',
        trigger: 'decision',
        guard: options.guard,
      },
    );
  }

  /** Marks an unknown resolved, with what the user said settled it. */
  resolveUnknown(unknownId: string, resolution: string, options: { guard?: string } = {}): EnqueueResult {
    return this.enqueueChanges(
      { items_updated: [{ id: unknownId, status: 'resolved', resolution }] },
      {
        origin: 'user',
        message_id: null,
        rationale: 'Resolved by you.',
        trigger: 'user_edit',
        guard: options.guard,
      },
    );
  }

  /**
   * Marks an open question as asked, so the same question is not put to the user
   * again next turn. The question is located by id, or by text when the model
   * asked something it never recorded as an open question.
   *
   * This is bookkeeping about the conversation, not a change to the idea, so it
   * deliberately produces no version.
   */
  markQuestionAsked(question: Question, openQuestionId: string | null): void {
    const session = this.#requireSession('markQuestionAsked');
    const wanted = question.text.trim().toLowerCase();
    const item = openQuestionId
      ? session.idea.open_questions.find((entry) => entry.id === openQuestionId)
      : session.idea.open_questions.find(
          (entry) => entry.status === 'unasked' && entry.question.trim().toLowerCase() === wanted,
        );
    if (!item) return;
    item.status = 'asked';
    item.asked_at = this.#clock();
    this.#touch();
    this.#persist();
  }

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  /**
   * Restores a previous snapshot as a *new* version on the active branch. History
   * is never rewritten, which is also what makes branching possible: a restore is
   * just another commit whose parent is the current head.
   *
   * Restoring an older point is how a person says "let's go back and try it this
   * way" without losing the timeline they were on; `createBranch` is the version
   * of that which keeps both timelines explicitly.
   */
  restoreVersion(versionId: string, options: { guard?: string } = {}): VersionRecord {
    const session = this.#requireSession('restoreVersion');
    this.assertGuard(options.guard, 'The restore');
    const target = session.idea.version_history.find((entry) => entry.id === versionId);
    if (!target) throw new IdenoStateError('unknown_version', `No version with id "${versionId}".`);
    if (!target.snapshot) {
      throw new IdenoStateError(
        'unknown_version',
        `The snapshot for v${target.number} is no longer stored, so it cannot be restored. It was dropped to keep the current idea savable when browser storage ran out.`,
      );
    }

    const restored = IdeaCaseSchema.safeParse({
      ...structuredClone(target.snapshot),
      // The restored body carries the branches and history of the point in time it
      // came from; the live ones are what the idea actually has now.
      branches: session.idea.branches,
      active_branch_id: session.idea.active_branch_id,
      version_history: session.idea.version_history,
      updated_at: this.#clock(),
    });
    if (!restored.success) {
      throw new IdenoStateError('invalid_state', `Stored snapshot v${target.number} failed validation.`);
    }

    assignIdeaFields(session.idea, restored.data);
    session.idea.current_state = deriveCurrentState(bodyOf(session.idea));

    const version = this.#pushVersion({
      trigger: 'restore',
      message_id: null,
      applied_change_ids: [],
      summary: `Restored v${target.number}: ${target.summary}`,
    });
    this.#touch();
    this.#persist();
    return version;
  }

  /** Attaches a human-readable name to a point in history. */
  labelVersion(versionId: string, label: string | null): VersionRecord {
    const session = this.#requireSession('labelVersion');
    const version = session.idea.version_history.find((entry) => entry.id === versionId);
    if (!version) throw new IdenoStateError('unknown_version', `No version with id "${versionId}".`);
    version.label = label?.trim() ? label.trim().slice(0, 120) : null;
    this.#touch();
    this.#persist();
    return version;
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  /**
   * Forks a new branch at a version of the current idea.
   *
   * The new branch points at an *existing* version: no snapshot is copied, so
   * forking costs one small record and both branches share the history below the
   * fork. The idea itself is not modified — a fork is a statement about history,
   * not a change to the idea — so it produces no version of its own.
   */
  createBranch(input: {
    name?: string;
    from_version_id?: string | null;
    description?: string | null;
    switch_to?: boolean;
    guard?: string;
  } = {}): Branch {
    const session = this.#requireSession('createBranch');
    this.assertGuard(input.guard, 'The fork');
    const idea = session.idea;

    if (idea.branches.length >= MAX_BRANCHES) {
      throw new IdenoStateError(
        'capacity',
        `This idea already has ${MAX_BRANCHES} branches. Archive one before creating another.`,
      );
    }

    const fromVersion = input.from_version_id
      ? findVersion(idea.version_history, input.from_version_id)
      : branchHeadOf(idea);
    if (!fromVersion) {
      throw new IdenoStateError('unknown_version', 'There is no version to fork from yet.');
    }

    const parentBranch = findBranch(idea, fromVersion.branch_id ?? idea.active_branch_id);
    const name = suggestBranchName(idea, input.name?.trim() || `${parentBranch?.name ?? 'main'}-fork`);

    const branch = BranchSchema.parse({
      id: newId('br'),
      name,
      parent_branch_id: parentBranch?.id ?? null,
      fork_version_id: fromVersion.id,
      head_version_id: fromVersion.id,
      description: input.description?.trim() ? input.description.trim().slice(0, 280) : null,
      created_at: this.#clock(),
      archived: false,
    });

    idea.branches.push(branch);
    this.#emit({ type: 'branch_created', branch });
    if (input.switch_to !== false) this.#switchTo(branch, { persist: true });
    else this.#persist();
    return branch;
  }

  /**
   * Opens a different timeline of the same idea.
   *
   * The branch head's snapshot becomes the live state. No version is created:
   * nothing about the idea changed, only which point in its history is being
   * looked at. The branch you came from keeps its own head, so switching back
   * returns you to exactly where you were.
   */
  switchBranch(branchId: string, options: { guard?: string } = {}): VersionRecord {
    const session = this.#requireSession('switchBranch');
    this.assertGuard(options.guard, 'The branch switch');
    const branch = findBranch(session.idea, branchId);
    if (!branch) throw new IdenoStateError('unknown_version', `No branch with id "${branchId}".`);
    if (branch.archived) {
      throw new IdenoStateError('invalid_state', `The branch "${branch.name}" is archived. Unarchive it before switching to it.`);
    }
    return this.#switchTo(branch, { persist: true });
  }

  #switchTo(branch: Branch, options: { persist: boolean }): VersionRecord {
    const session = this.#requireSession('#switchTo');
    const head = findVersion(session.idea.version_history, branch.head_version_id);
    if (!head) {
      throw new IdenoStateError(
        'unknown_version',
        `The branch "${branch.name}" points at a version that is not in the history.`,
      );
    }
    if (!head.snapshot) {
      throw new IdenoStateError(
        'unknown_version',
        `The snapshot at the tip of "${branch.name}" (v${head.number}) is no longer stored, so that branch cannot be opened.`,
      );
    }

    const restored = IdeaCaseSchema.safeParse({
      ...structuredClone(head.snapshot),
      branches: session.idea.branches,
      active_branch_id: branch.id,
      version_history: session.idea.version_history,
      updated_at: this.#clock(),
    });
    if (!restored.success) {
      throw new IdenoStateError('invalid_state', `The snapshot at the tip of "${branch.name}" failed validation.`);
    }

    // Written field by field rather than by replacing `session.idea`, so a
    // `Branch` object this method handed out stays live and a caller holding a
    // reference to the case does not silently end up looking at a stale object.
    assignIdeaFields(session.idea, restored.data);
    session.idea.current_state = deriveCurrentState(bodyOf(session.idea));
    this.#emit({ type: 'branch_switched', branch });
    this.#touch();
    if (options.persist) this.#persist();
    return head;
  }

  renameBranch(branchId: string, name: string): Branch {
    const session = this.#requireSession('renameBranch');
    const branch = findBranch(session.idea, branchId);
    if (!branch) throw new IdenoStateError('unknown_version', `No branch with id "${branchId}".`);
    const trimmed = name.trim().slice(0, 60);
    if (trimmed.length === 0) throw new IdenoStateError('invalid_state', 'A branch name must not be empty.');
    branch.name = suggestBranchName(
      { ...session.idea, branches: session.idea.branches.filter((candidate) => candidate.id !== branchId) },
      trimmed,
    );
    this.#touch();
    this.#persist();
    return branch;
  }

  setBranchDescription(branchId: string, description: string | null): Branch {
    const session = this.#requireSession('setBranchDescription');
    const branch = findBranch(session.idea, branchId);
    if (!branch) throw new IdenoStateError('unknown_version', `No branch with id "${branchId}".`);
    branch.description = description?.trim() ? description.trim().slice(0, 280) : null;
    this.#touch();
    this.#persist();
    return branch;
  }

  /**
   * Retires a branch. Its versions stay in the history — a branch someone
   * developed is part of the account of how the idea got where it is — and it can
   * be unarchived. Deleting history is not offered.
   */
  archiveBranch(branchId: string, options: { archived?: boolean; guard?: string } = {}): Branch {
    const session = this.#requireSession('archiveBranch');
    this.assertGuard(options.guard, 'The archive');
    const branch = findBranch(session.idea, branchId);
    if (!branch) throw new IdenoStateError('unknown_version', `No branch with id "${branchId}".`);
    const archived = options.archived ?? true;

    if (archived) {
      const live = session.idea.branches.filter((candidate) => !candidate.archived);
      if (live.length <= 1) {
        throw new IdenoStateError(
          'invalid_state',
          'This idea has only one open branch. An idea always needs somewhere to continue from.',
        );
      }
      // The flag is set *before* the switch, not after. Switching branches rebuilds
      // the case body through the schema, which replaces the `branches` array with
      // fresh objects — so a reference taken before the switch would be left
      // pointing at a detached copy and the archive would silently not happen.
      branch.archived = true;
      if (session.idea.active_branch_id === branchId) {
        const fallback = live.find((candidate) => candidate.id !== branchId);
        if (!fallback) throw new IdenoStateError('invalid_state', 'There is no other open branch to switch to.');
        this.#switchTo(fallback, { persist: false });
      }
    } else {
      branch.archived = false;
    }
    this.#touch();
    this.#persist();
    return branch;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #commit(
    records: ChangeRecord[],
    options: {
      trigger: VersionTrigger;
      message_id: string | null;
      summary?: string;
      status: 'accepted' | 'auto_accepted';
    },
  ): { version: VersionRecord | null; notes: string[] } {
    const session = this.#requireSession('#commit');
    const notes: string[] = [];
    const before = snapshotOf(session.idea);
    const working: IdeaCaseBody = structuredClone(before);

    const outcome = applyRecords(working, records, this.#clock(), {
      asked_questions: this.#askedQuestions(),
    });
    const validation = validateBody(working);
    // The branch pointers live on the body but the versions they point at live in
    // the history, so neither check alone covers them.
    const branchCheck = validateBranchIntegrity(working, session.idea.version_history);
    const issues = [
      ...(validation.ok ? [] : validation.issues),
      ...(branchCheck.ok ? [] : branchCheck.issues),
    ];

    if (issues.length > 0) {
      // The batch as a whole would produce an invalid state: discard all of it.
      const message = `Refused to apply ${records.length} change(s); the resulting state failed validation: ${issues.join('; ')}`;
      for (const record of records) {
        record.status = 'rejected';
        record.resolved_at = this.#clock();
        record.rejection_reason = message.slice(0, 400);
        this.#emit({ type: 'change_resolved', change: record });
      }
      this.#emit({ type: 'integrity', message });
      return { version: null, notes: [message] };
    }

    // Warnings and skips are surfaced three ways: returned to the caller,
    // emitted as events for the UI, and (for skips) stored on the record itself.
    for (const warning of outcome.warnings) {
      notes.push(warning.note);
      this.#emit({ type: 'integrity', message: warning.note });
    }

    for (const skipped of outcome.skipped) {
      const record = records.find((entry) => entry.id === skipped.record_id);
      if (record) {
        record.status = 'rejected';
        record.resolved_at = this.#clock();
        record.rejection_reason = skipped.note.slice(0, 400);
        this.#emit({ type: 'change_resolved', change: record });
      }
      notes.push(skipped.note);
      this.#emit({ type: 'integrity', message: skipped.note });
    }

    if (outcome.applied.length === 0) {
      return { version: null, notes };
    }

    Object.assign(session.idea, working);
    session.idea.current_state = deriveCurrentState(bodyOf(session.idea));

    const appliedIds = new Set(outcome.applied.map((record) => record.id));
    const summary =
      options.summary ?? describeEntries(diffBodies(before, bodyOf(session.idea)));
    const version = this.#pushVersion({
      trigger: options.trigger,
      message_id: options.message_id,
      applied_change_ids: [...appliedIds],
      summary,
    });

    const now = version.created_at;
    for (const record of outcome.applied) {
      record.status =
        record.origin_operation === 'user' || record.provenance === 'user_decision'
          ? 'accepted'
          : options.status;
      record.resolved_at = now;
      record.version_id = version.id;
      this.#emit({ type: 'change_resolved', change: record });
    }

    return { version, notes };
  }

  /**
   * Records a new version on the active branch and moves that branch's head.
   *
   * The parent is the active branch's head, not the last element of the history
   * array: on a forked branch those are different, and using the array end would
   * silently splice the fork back onto the branch it forked from.
   */
  #pushVersion(input: {
    trigger: VersionTrigger;
    message_id: string | null;
    applied_change_ids: string[];
    summary: string;
  }): VersionRecord {
    const idea = this.#requireSession('#pushVersion').idea;
    const branch = activeBranch(idea);

    this.#enforceVersionCapacity(idea);

    const parent = branch ? findVersion(idea.version_history, branch.head_version_id) : this.latestVersion();
    const now = this.#clock();
    idea.current_state = deriveCurrentState(bodyOf(idea));

    const version: VersionRecord = {
      id: newId('ver'),
      // Globally monotonic across branches, so ordering never depends on which
      // branch is being looked at. The per-branch number is derived on read.
      number: highestVersionNumber(idea.version_history) + 1,
      parent_id: parent?.id ?? null,
      branch_id: branch?.id ?? null,
      created_at: now,
      summary: input.summary.slice(0, 280),
      trigger: input.trigger,
      message_id: input.message_id,
      applied_change_ids: input.applied_change_ids,
      label: null,
      snapshot: snapshotOf(idea),
      snapshot_pruned: false,
    };

    idea.version_history.push(version);
    idea.updated_at = now;
    if (branch) branch.head_version_id = version.id;
    this.#emit({ type: 'version_committed', version, trigger: version.trigger });
    return version;
  }

  /**
   * Keeps history inside its bound by dropping the oldest dispensable *snapshots*.
   *
   * v0.1 threw here instead, after the new state had already been written: a
   * change that succeeded was reported as a failure and never recorded. Pruning is
   * lossy and it says so — every pruned version is marked, and the user is told
   * what was dropped and why.
   */
  #enforceVersionCapacity(idea: IdeaCase): void {
    if (idea.version_history.length < this.#maxVersions) return;

    const prunable = prunableVersions(idea.version_history, idea.branches, {
      keepRecent: this.#keepRecentSnapshots,
    });
    if (prunable.length === 0) {
      // Everything left is protected: branch heads, labels, the original idea and
      // the recent past. The state still gets written and versioned; what cannot
      // grow is the number of *stored snapshots*.
      this.#emit({
        type: 'integrity',
        message:
          `This idea has ${idea.version_history.length} versions and every remaining snapshot is protected ` +
          '(branch tips, labelled, the original idea, or recent). Export it if you need a copy outside this browser.',
      });
      return;
    }

    const target = prunable[0];
    if (!target) return;
    target.snapshot = null;
    target.snapshot_pruned = true;
    this.#emit({
      type: 'integrity',
      message:
        `Version history reached its limit of ${this.#maxVersions}. The snapshot of v${target.number} ` +
        `("${target.summary}") was dropped to make room; the record of what happened is kept.`,
    });
  }

  /**
   * Questions Ideno has already asked, derived from the transcript rather than
   * stored twice. Used so an open-question item created after the question was
   * asked still records that it was asked.
   */
  #askedQuestions(): Set<string> {
    const asked = new Set<string>();
    for (const entry of this.#session?.transcript ?? []) {
      if (entry.question) asked.add(normalizeQuestion(entry.question.text));
    }
    return asked;
  }

  #requireSession(context: string): Session {
    if (!this.#session) {
      throw new IdenoStateError(
        'no_session',
        `${context} was called before an idea existed. Start a session first.`,
      );
    }
    return this.#session;
  }

  #touch(): void {
    if (this.#session) this.#session.updated_at = this.#clock();
  }

  /**
   * Writes the open idea, then the index.
   *
   * Order matters: if the idea write fails on quota the index is still updated so
   * the switcher keeps showing the truth about what exists. If the idea record
   * cannot be written at all, the recovery path below has already tried to make it
   * small enough.
   */
  #persist(): void {
    if (!this.#persistEnabled || !this.#session) return;
    if (this.#coalesceMs > 0) {
      this.#dirty = true;
      if (this.#scheduled === null) {
        this.#scheduled = setTimeout(() => {
          this.#scheduled = null;
          if (this.#dirty) {
            this.#dirty = false;
            this.#writeNow();
          }
        }, this.#coalesceMs);
      }
      return;
    }
    this.#writeNow();
  }

  #writeNow(): void {
    if (!this.#session) return;

    const outcome = this.#writeSessionWithRecovery(this.#session);
    if (!outcome.ok) {
      this.#warnOnce(outcome.reason);
    } else if (this.#persistenceWarning) {
      // A save succeeded after failures: clear the warning rather than leave a
      // stale "your work is not being saved" banner on a working app.
      this.#persistenceWarning = null;
      this.#emit({ type: 'persistence', persistent: this.#store.kind === 'local_storage', reason: null });
    }

    this.#writeIndex(this.#updateIndexEntry());
  }

  /**
   * Serialises and writes one session, retrying with fewer snapshots if the store
   * is full.
   *
   * This is the difference between "your idea could not be saved" and "the oldest
   * snapshot of this idea was dropped so that the current state could be saved".
   * The second is a real loss and is reported as one, but it is a fraction of the
   * first.
   */
  #writeSessionWithRecovery(session: Session): { ok: true } | { ok: false; reason: string } {
    for (let attempt = 0; attempt <= MAX_QUOTA_RETRIES; attempt += 1) {
      // Bounds are checked directly instead of by re-parsing: the check is O(1)
      // where a full parse is O(every snapshot ever taken). See `toWorkspace`.
      const bounds = withinLimits(session, this.#limits);
      if (!bounds.ok) {
        return { ok: false, reason: `The idea was not saved: ${bounds.reason}.` };
      }

      let payload: string;
      try {
        payload = JSON.stringify({
          schema_version: WORKSPACE_SCHEMA_VERSION,
          session,
          saved_at: this.#clock(),
        });
      } catch (error) {
        return { ok: false, reason: `The idea could not be serialised (${messageOf(error)}).` };
      }

      try {
        this.#store.write(sessionStorageKey(session.id), payload);
        return { ok: true };
      } catch (error) {
        if (!isQuotaError(error)) {
          return { ok: false, reason: `Changes could not be saved to this browser (${messageOf(error)}).` };
        }
        if (!this.#pruneOneSnapshot(session.idea)) {
          return {
            ok: false,
            reason:
              `This browser is out of storage space and there is nothing left to prune (${messageOf(error)}). ` +
              'Export the idea now — it is still complete in memory — and archive ideas you are not working on.',
          };
        }
      }
    }
    return {
      ok: false,
      reason: 'This browser is out of storage space; pruning old snapshots did not free enough of it.',
    };
  }

  /** Drops the single oldest prunable snapshot. False when nothing is left to drop. */
  #pruneOneSnapshot(idea: IdeaCase): boolean {
    const prunable = prunableVersions(idea.version_history, idea.branches, {
      keepRecent: this.#keepRecentSnapshots,
    });
    const target = prunable[0];
    if (!target) return false;
    target.snapshot = null;
    target.snapshot_pruned = true;
    this.#notePruning(
      `Browser storage ran out, so the snapshot of v${target.number} ("${target.summary}") was dropped to keep this idea savable. ` +
        'The version list is intact; that version can no longer be compared or restored.',
    );
    return true;
  }

  /** Reports a lossy pruning once per session, then keeps quiet about repeats. */
  #notePruning(message: string): void {
    if (this.#pruningNotice === message) return;
    this.#pruningNotice = message;
    this.#emit({ type: 'integrity', message });
  }

  #warnOnce(message: string): void {
    if (this.#persistenceWarning === message) return;
    this.#persistenceWarning = message;
    this.#emit({ type: 'persistence', persistent: false, reason: message });
    this.#emit({ type: 'integrity', message });
  }

  #emit(event: StateEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break the state machine.
      }
    }
  }
}

/**
 * Review policy.
 *
 * `assisted` applies what the human actually said and queues what the model
 * inferred — the idea keeps moving without the user re-approving their own
 * sentences. `strict` queues everything the model touched, which is the mode to
 * use when auditing Ideno's judgement.
 *
 * A change the user made directly (manual evidence, an explicit decision) is
 * never queued: asking someone to approve their own click is not governance.
 */
export function shouldAutoApply(record: ChangeRecord, reviewMode: ReviewMode): boolean {
  if (record.origin_operation === 'user') return true;
  if (record.provenance === 'user_decision') return true;
  if (reviewMode === 'strict') return false;
  return record.provenance === 'user_stated';
}

/**
 * Copies a validated body onto a live case, leaving `version_history` alone.
 *
 * `restoreVersion` and `switchBranch` both build a whole new case in order to get
 * it validated by `IdeaCaseSchema`, then need its *contents* on the object the
 * rest of the app is holding. Assigning field by field is what keeps that object
 * identity — and therefore every `Branch` reference a caller already has.
 */
function assignIdeaFields(target: IdeaCase, source: IdeaCaseBody): void {
  for (const [key, value] of Object.entries(source)) {
    (target as unknown as Record<string, unknown>)[key] = value;
  }
}

/**
 * O(1) check that a session is inside its collection bounds.
 *
 * This is the cheap half of `parseSession`, for the save path: a session that grew
 * past its bounds must not be written (the stored copy would be unreadable next
 * boot), but discovering that does not require validating every snapshot in it.
 */
function withinLimits(
  session: Session,
  limits: SessionLimits,
): { ok: true } | { ok: false; reason: string } {
  if (session.transcript.length > transcriptLimit(limits)) {
    return { ok: false, reason: `the transcript exceeds its limit of ${transcriptLimit(limits)} entries` };
  }
  if (session.change_log.length > changeLogLimit(limits)) {
    return { ok: false, reason: `the change log exceeds its limit of ${changeLogLimit(limits)} entries` };
  }
  return { ok: true };
}

function branchHeadOf(idea: IdeaCase): VersionRecord | null {
  const branch = activeBranch(idea);
  return branch ? findVersion(idea.version_history, branch.head_version_id) : null;
}

function highestVersionNumber(history: readonly VersionRecord[]): number {
  let highest = -1;
  for (const version of history) if (version.number > highest) highest = version.number;
  return highest;
}

function versionOf(json: unknown): number | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const value = (json as { schema_version?: unknown }).schema_version;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'validation failed';
}
