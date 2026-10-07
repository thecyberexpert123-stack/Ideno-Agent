/**
 * The session, and the persisted shape of a workspace.
 *
 * Settings are deliberately not part of the session: they live in
 * `core/schemas/settings.ts` (behaviour) and `ai/settings.ts` (providers), so
 * changing provider never touches an idea and a corrupt workspace cannot take the
 * user's configuration with it.
 *
 * The transcript is kept for continuity of conversation, but it is deliberately
 * *not* the memory of the product — the IdeaCase is. A session can be replayed,
 * exported or thrown away and the idea state still stands on its own.
 *
 * ## Storage layout (schema version 2)
 *
 * v0.1 stored one workspace as a single `localStorage` blob. That did not
 * survive contact with reality: a blob holding every snapshot of every version
 * crosses the ~5 MB per-origin budget after roughly 170 user edits, and from that
 * moment on nothing could be saved at all. It also made "more than one idea"
 * impossible without rewriting everything.
 *
 * v2 stores:
 *
 *   ideno.workspace.index.v2      small: which ideas exist, which is open
 *   ideno.session.v2.<session_id> one idea each, loaded only when opened
 *   ideno.workspace.v1            legacy blob, read once and migrated forward
 *
 * Only the open session is ever serialised, so the cost of a save no longer grows
 * with the number of ideas in the workspace, and a corrupt or oversized idea
 * cannot take the others with it.
 */
import { z } from 'zod';

import {
  IdSchema,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  TextSchema,
  TimestampSchema,
  WORKSPACE_SCHEMA_VERSION,
} from './common.js';
import { ChangeRecordSchema, OperationSchema, QuestionSchema, TurnClassificationSchema } from './changes.js';
import { IdeaCaseSchema, IdeaPhaseSchema } from './idea_state.js';

export const TranscriptRoleSchema = z.enum(['user', 'ideno', 'system']);
export type TranscriptRole = z.infer<typeof TranscriptRoleSchema>;

export const TranscriptEntrySchema = z.object({
  id: IdSchema,
  role: TranscriptRoleSchema,
  text: TextSchema,
  created_at: TimestampSchema,
  /** All entries produced by one orchestrator turn share a turn id. */
  turn_id: IdSchema.nullable().default(null),
  operation: OperationSchema.nullable().default(null),
  /**
   * How Ideno read the message: new information, a revision, a decision, and so
   * on. Recorded so the UI can show that a correction was understood as a
   * correction rather than as small talk.
   */
  classification: TurnClassificationSchema.nullable().default(null),
  /** Concise reasoning summary stored instead of any chain-of-thought. */
  reasoning_summary: z.string().trim().max(800).nullable().default(null),
  question: QuestionSchema.nullable().default(null),
  /** Set on `system` entries describing a handled failure. */
  error_code: z.string().min(1).max(64).nullable().default(null),
  /**
   * Model text Ideno could not use, kept separately from `text` so the failure
   * message stays readable and the raw response stays inspectable. Rendered in a
   * disclosure, never as markup.
   */
  raw_text: z.string().max(20000).nullable().default(null),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

/**
 * Bounds on the two append-only session collections.
 *
 * These are enforced *at append time* by the State Manager, which prunes the
 * oldest entries and says so. They are not merely schema limits: v0.1 had the
 * same caps in the schema and nothing enforcing them, so a long session grew past
 * 2000 transcript entries and every subsequent save silently produced an invalid
 * workspace that was never written. The user would have lost the idea on reload.
 */
export const MAX_TRANSCRIPT_ENTRIES = 2000;
export const MAX_CHANGE_LOG_ENTRIES = 4000;

/**
 * Limits a given session must respect.
 *
 * Passed in rather than baked into the schema so that (a) an operator can lower
 * them for a constrained store and (b) a test can exercise the bound without
 * running four thousand real mutations. The defaults are the schema constants, so
 * "no limits given" means exactly what v0.1 meant.
 */
export interface SessionLimits {
  transcript?: number;
  change_log?: number;
}

export function transcriptLimit(limits: SessionLimits = {}): number {
  return Math.max(1, limits.transcript ?? MAX_TRANSCRIPT_ENTRIES);
}

export function changeLogLimit(limits: SessionLimits = {}): number {
  return Math.max(1, limits.change_log ?? MAX_CHANGE_LOG_ENTRIES);
}

export const SessionBaseSchema = z.object({
  id: IdSchema,
  idea: IdeaCaseSchema,
  transcript: z.array(TranscriptEntrySchema).default([]),
  /** Every change ever proposed, pending or resolved. */
  change_log: z.array(ChangeRecordSchema).default([]),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

export const SessionSchema = SessionBaseSchema;
export type Session = z.infer<typeof SessionSchema>;

/**
 * `SessionSchema` plus the collection bounds, which zod cannot express on its own
 * because they are a property of the *deployment*, not of the shape.
 *
 * Used on every load and import path: a session that is too large to have been
 * written by this build is refused there rather than being read into memory and
 * then failing to save.
 */
export function parseSession(data: unknown, limits: SessionLimits = {}): {
  success: true;
  data: Session;
} | { success: false; error: z.ZodError } {
  const schema = SessionBaseSchema.refine(
    (session) => session.transcript.length <= transcriptLimit(limits),
    { message: `the transcript exceeds this workspace's limit of ${transcriptLimit(limits)} entries` },
  ).refine((session) => session.change_log.length <= changeLogLimit(limits), {
    message: `the change log exceeds this workspace's limit of ${changeLogLimit(limits)} entries`,
  });

  const parsed = schema.safeParse(data);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, error: parsed.error as unknown as z.ZodError };
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

/** Key of the small index record. */
export const WORKSPACE_INDEX_KEY = 'ideno.workspace.index.v2';
/** Key prefix of a per-session record; the full key is `prefix + session_id`. */
export const SESSION_KEY_PREFIX = 'ideno.session.v2.';
/** Key of the v0.1 single-blob workspace, kept only so it can be migrated. */
export const LEGACY_WORKSPACE_KEY = 'ideno.workspace.v1';

export function sessionStorageKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

/**
 * What the workspace switcher needs to render, without loading any idea. Kept
 * deliberately small: this record is rewritten on every mutation of the open
 * session, so its size is part of the hot path.
 */
export const WorkspaceIndexEntrySchema = z.object({
  session_id: IdSchema,
  idea_id: IdSchema,
  title: z.string().max(280),
  phase: IdeaPhaseSchema,
  /** Count of changes still awaiting Accept / Reject. */
  pending: z.number().int().min(0).max(MAX_CHANGE_LOG_ENTRIES).default(0),
  versions: z.number().int().min(0).default(0),
  archived: z.boolean().default(false),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type WorkspaceIndexEntry = z.infer<typeof WorkspaceIndexEntrySchema>;

/** A workspace holds at most this many ideas; `startSession` refuses past it. */
export const MAX_WORKSPACE_IDEAS = 100;

export const WorkspaceIndexSchema = z.object({
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  /** Session that was open when the index was last written. */
  active_session_id: IdSchema.nullable().default(null),
  entries: z.array(WorkspaceIndexEntrySchema).max(MAX_WORKSPACE_IDEAS).default([]),
  saved_at: TimestampSchema,
});
export type WorkspaceIndex = z.infer<typeof WorkspaceIndexSchema>;

/** One idea, as stored. Validated in full on load and on import. */
export const SessionRecordSchema = z.object({
  schema_version: z.literal(WORKSPACE_SCHEMA_VERSION),
  session: SessionSchema,
  saved_at: TimestampSchema,
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * The v0.1 format. Read-only: parsed during migration and never written again.
 * Exported so the migration and its tests can name it.
 */
export const LegacyWorkspaceSchema = z.object({
  schema_version: z.literal(LEGACY_WORKSPACE_SCHEMA_VERSION),
  session: SessionSchema,
  saved_at: TimestampSchema,
});
export type LegacyWorkspace = z.infer<typeof LegacyWorkspaceSchema>;

/**
 * What an exported file contains.
 *
 * An export carries one idea, not the whole workspace: the point of exporting is
 * to hand a single idea to someone else or to keep it somewhere safe, and a file
 * that silently bundled nine unrelated ideas would be a worse artefact. The name
 * `Workspace` is kept because that is what v0.1 called it and an import must
 * accept both.
 */
export const WorkspaceSchema = SessionRecordSchema;
export type Workspace = z.infer<typeof WorkspaceSchema>;
