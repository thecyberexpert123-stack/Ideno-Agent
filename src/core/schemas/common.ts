/**
 * Shared primitives for every Ideno schema.
 *
 * These are the vocabulary of the Idea State. Keeping them in one place means
 * the persisted format, the model-output contract and the UI all agree on what
 * a "provenance" or an "impact" is.
 */
import { z } from 'zod';

/**
 * Bumped whenever the persisted workspace format changes in a way that older
 * clients cannot read. Persisted payloads carry the version they were written
 * with so a migration can detect stale data instead of guessing.
 *
 * Version 2 changed two things at once, so that only one migration ever has to
 * run: the workspace became a *set* of ideas (an index record plus one record per
 * session, instead of a single blob), and version history became a tree of
 * branches with snapshots that can be pruned under storage pressure.
 */
export const WORKSPACE_SCHEMA_VERSION = 2;

/**
 * The v0.1 single-blob format. Still readable: a workspace saved by v0.1 is
 * migrated forward on load rather than discarded, because throwing away somebody's
 * idea on upgrade is exactly the kind of irreversible action Ideno must not take
 * for its own convenience.
 */
export const LEGACY_WORKSPACE_SCHEMA_VERSION = 1;

/** Identifier minted by Ideno Core. Models never invent identifiers. */
export const IdSchema = z.string().min(2).max(64);

/** ISO-8601 timestamp, always produced by `new Date().toISOString()`. */
export const TimestampSchema = z.iso.datetime();

/**
 * The epistemic labels required of Ideno. Everything stored in the Idea State
 * carries one of these so the user can always tell a fact they stated from a
 * guess the model made.
 *
 * - `user_stated`       Known: the human said it.
 * - `model_inferred`    Assumed: derived by the model, not confirmed.
 * - `unknown`           Unknown: a named gap in understanding.
 * - `evidence_supported` Backed by at least one Evidence record with a source.
 * - `model_suggestion`  A proposal from the model, not adopted.
 * - `user_decision`     The human chose it. Only Core may assign this.
 */
export const ProvenanceSchema = z.enum([
  'user_stated',
  'model_inferred',
  'unknown',
  'evidence_supported',
  'model_suggestion',
  'user_decision',
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  user_stated: 'Known (you stated it)',
  model_inferred: 'Assumed (Ideno inferred it)',
  unknown: 'Unknown',
  evidence_supported: 'Supported by evidence',
  model_suggestion: 'Model suggestion',
  user_decision: 'Your decision',
};

/**
 * Provenance values a model is allowed to claim in its output.
 * `user_decision` is deliberately absent: only Core may mark something as the
 * human's decision, and it does so from an actual user action.
 */
export const ModelClaimableProvenanceSchema = z.enum([
  'user_stated',
  'model_inferred',
  'unknown',
  'evidence_supported',
  'model_suggestion',
]);
export type ModelClaimableProvenance = z.infer<typeof ModelClaimableProvenanceSchema>;

/** Which reasoning operation introduced an item. Used for audit and UI hints. */
export const OriginOperationSchema = z.enum([
  'user',
  'understand',
  'update',
  'critique',
  'explore',
  'research',
  'decision',
  'import',
]);
export type OriginOperation = z.infer<typeof OriginOperationSchema>;

/** Free-form note, bounded so a runaway model cannot inflate the state. */
export const TextSchema = z.string().trim().min(1).max(4000);
export const ShortTextSchema = z.string().trim().min(1).max(280);

/** Confidence in [0, 1]. */
export const ConfidenceSchema = z.number().min(0).max(1);

/** Coarse impact ranking used to decide what is worth asking about. */
export const ImpactSchema = z.enum(['high', 'medium', 'low']);
export type Impact = z.infer<typeof ImpactSchema>;

export const IMPACT_RANK: Record<Impact, number> = { high: 3, medium: 2, low: 1 };

/**
 * What a change touches. Rendered in the review card as the "Affected:" list so
 * the human can judge a change by its blast radius, not just its wording.
 */
export const AffectedSchema = z.object({
  /** Existing Idea State item ids this change interacts with. */
  item_ids: z.array(IdSchema).max(20).default([]),
  /** Human-readable areas, e.g. "Power architecture", "Component selection". */
  areas: z.array(ShortTextSchema).max(8).default([]),
});
export type Affected = z.infer<typeof AffectedSchema>;
