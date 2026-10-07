/**
 * Branches of an idea's version history.
 *
 * v0.1 stored history as a linked list (`VersionRecord.parent_id`) precisely so
 * that it could become a tree without a data migration. This is that tree.
 *
 * A branch is a *named pointer into existing history*, not a copy of the idea:
 *
 *   branches[i].head_version_id → a VersionRecord → parent_id → ... → v0
 *
 * Forking therefore costs one record. Two branches that share an ancestor share
 * every snapshot below it, which is what keeps a branched idea affordable in
 * `localStorage` — the expensive part of Ideno's history is snapshots, and
 * branching never duplicates one.
 *
 * What a branch means for the product: an alternative can be developed as its own
 * timeline ("what if we go with the passive design?") without destroying the
 * timeline it forked from, and the two can be diffed against each other at any
 * point. Nothing is merged automatically; choosing between branches is a human
 * decision recorded as a decision.
 */
import { z } from 'zod';

import { IdSchema, TimestampSchema } from './common.js';

export const BRANCH_NAME_MAX = 60;

export const BranchSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(BRANCH_NAME_MAX),
  /** Branch this one forked from, null for the root branch. */
  parent_branch_id: IdSchema.nullable().default(null),
  /** Version the branch forked from, when it forked from another branch. */
  fork_version_id: IdSchema.nullable().default(null),
  /** The branch tip. Always the id of a version carrying `branch_id === id`. */
  head_version_id: IdSchema,
  /** Why this branch exists. Shown in the branch list, never sent to a model as fact. */
  description: z.string().trim().max(280).nullable().default(null),
  created_at: TimestampSchema,
  /**
   * Archiving is how a branch is retired. Branches are never deleted: a branch
   * someone spent an afternoon on is part of the record of how the idea
   * developed, and deleting it would be an irreversible action taken for
   * convenience.
   */
  archived: z.boolean().default(false),
});
export type Branch = z.infer<typeof BranchSchema>;

/** Name given to the branch every idea starts on. */
export const DEFAULT_BRANCH_NAME = 'main';

export const MAX_BRANCHES = 40;
