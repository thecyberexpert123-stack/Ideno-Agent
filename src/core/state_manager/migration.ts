/**
 * Forward migration of persisted ideas.
 *
 * Ideno reads workspaces written by older versions of itself. It never writes an
 * old format, and it never discards one: an idea a person spent an evening on is
 * not something an upgrade gets to delete.
 *
 * Two migrations live here:
 *
 *  1. **Format (v1 → v2).** v0.1 stored one workspace blob containing one session.
 *     v2 stores an index plus one record per idea. Reading the legacy blob yields a
 *     `Session`, which the caller stores in the new layout.
 *  2. **Shape (branchless → branched).** Version history gained branches. A
 *     pre-branching case has `branches: []` and versions with `branch_id: null`;
 *     migration puts the whole existing history on a new `main` branch, in order.
 *     Nothing is reordered and nothing is dropped.
 *
 * Both are idempotent: running either twice over the same data changes nothing the
 * second time. That is asserted in tests, because a migration that is not
 * idempotent turns every reload into a fresh opportunity to corrupt an idea.
 */
import { z } from 'zod';

import {
  BranchSchema,
  DEFAULT_BRANCH_NAME,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  LegacyWorkspaceSchema,
  SessionBaseSchema,
  WORKSPACE_SCHEMA_VERSION,
  parseSession,
  type Branch,
  type Session,
  type SessionLimits,
  type VersionRecord,
} from '../schemas/index.js';
import { newId } from '../ids.js';
import { bodyOf } from '../idea_state/create.js';
import { deriveCurrentState } from '../idea_state/selectors.js';

/**
 * The persisted envelope, with the session itself validated separately against the
 * configured limits (see `parseSession`).
 */
const CurrentFileSchema = z.object({
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  session: SessionBaseSchema,
  saved_at: z.string(),
});

export interface MigrationNote {
  /** Machine-readable kind, so callers can react rather than string-match. */
  kind: 'legacy_format' | 'branches_added' | 'snapshot_pruned';
  message: string;
}

export interface MigrationResult {
  session: Session;
  notes: MigrationNote[];
}

export type MigrationFailure =
  | { ok: false; status: 'unsupported_version'; found: number }
  | { ok: false; status: 'corrupt'; reason: string };

export type MigrationOutcome = { ok: true; result: MigrationResult } | MigrationFailure;

/**
 * Reads a persisted idea of any supported version and returns it in the current
 * shape, or explains why it could not be read.
 *
 * Accepts either a bare session record or a whole exported workspace file, since
 * both are `{ schema_version, session, saved_at }`.
 */
export function migrateStoredSession(json: unknown, limits: SessionLimits = {}): MigrationOutcome {
  const foundVersion = readSchemaVersion(json);

  if (foundVersion !== null && foundVersion > WORKSPACE_SCHEMA_VERSION) {
    // Written by a newer Ideno. Guessing at a format we do not know is how data
    // gets silently rewritten, so this is refused outright.
    return { ok: false, status: 'unsupported_version', found: foundVersion };
  }

  if (foundVersion === LEGACY_WORKSPACE_SCHEMA_VERSION) {
    const legacy = LegacyWorkspaceSchema.safeParse(json);
    if (!legacy.success) return { ok: false, status: 'corrupt', reason: describeIssues(legacy.error) };
    const bounded = parseSession(legacy.data.session, limits);
    if (!bounded.success) return { ok: false, status: 'corrupt', reason: describeIssues(bounded.error) };
    const migrated = migrateSessionShape(bounded.data);
    return {
      ok: true,
      result: {
        session: migrated.session,
        notes: [
          {
            kind: 'legacy_format',
            message:
              'This idea was saved by an earlier version of Ideno and has been moved into the new workspace format.',
          },
          ...migrated.notes,
        ],
      },
    };
  }

  const current = CurrentFileSchema.safeParse(json);
  if (!current.success) return { ok: false, status: 'corrupt', reason: describeIssues(current.error) };
  const bounded = parseSession(current.data.session, limits);
  if (!bounded.success) return { ok: false, status: 'corrupt', reason: describeIssues(bounded.error) };
  return { ok: true, result: migrateSessionShape(bounded.data) };
}

/** The schema version stored in a payload, if it carries a usable one. */
export function readSchemaVersion(json: unknown): number | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const value = (json as { schema_version?: unknown }).schema_version;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Brings a session's *contents* up to the current shape.
 *
 * Exported separately because the import path needs it too: a file exported by
 * v0.1 is a v1 workspace and a file exported before branching existed is a
 * branchless v2 one, and in both cases the session inside is what must be
 * upgraded.
 */
export function migrateSessionShape(session: Session): MigrationResult {
  const notes: MigrationNote[] = [];
  const idea = session.idea;

  for (const version of idea.version_history) {
    // A record whose snapshot is missing but which was not marked as pruned comes
    // from a build that could drop snapshots without saying so. Mark it, so the UI
    // reports "snapshot no longer available" instead of showing an empty diff and
    // implying nothing changed.
    if (version.snapshot === null && !version.snapshot_pruned) {
      version.snapshot_pruned = true;
      notes.push({
        kind: 'snapshot_pruned',
        message: `${describeVersion(version)} has no stored snapshot and was marked as pruned.`,
      });
    }
  }

  const needsBranches =
    idea.branches.length === 0 ||
    idea.active_branch_id === null ||
    idea.version_history.some((version) => version.branch_id === null);

  if (needsBranches) {
    const branch = adoptExistingHistory(idea.version_history, idea.created_at);
    idea.branches = [branch];
    idea.active_branch_id = branch.id;
    for (const version of idea.version_history) version.branch_id = branch.id;
    notes.push({
      kind: 'branches_added',
      message: `The existing history was placed on a branch named "${branch.name}". Nothing was changed or reordered.`,
    });
  }

  // The phase is derived from the contents, and re-deriving it here means a case
  // saved by an older build cannot carry a stale badge into the new one.
  idea.current_state = deriveCurrentState(bodyOf(idea));

  return { session, notes };
}

/**
 * Creates the `main` branch that an existing linear history belongs to.
 *
 * The head is the newest version, which for pre-branching data is the last one
 * recorded: history was append-only, so array order *is* the ancestry.
 */
function adoptExistingHistory(history: VersionRecord[], createdAt: string): Branch {
  const head = history.length > 0 ? history[history.length - 1] : null;
  return BranchSchema.parse({
    id: newId('br'),
    name: DEFAULT_BRANCH_NAME,
    parent_branch_id: null,
    fork_version_id: null,
    head_version_id: head ? head.id : newId('ver'),
    description: null,
    created_at: createdAt,
    archived: false,
  });
}

export function describeVersion(version: VersionRecord): string {
  return version.label ? `v${version.number} ("${version.label}")` : `v${version.number}`;
}

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'The stored idea failed validation.';
}
