import { shortId } from './ids.js';
import { latestVersion } from './idea_state.js';
import type { ChangeSet, IdeaCase, StateOperation, VersionRecord } from './schemas.js';

/**
 * Versioning.
 *
 * A version is an applied batch of operations, stored as the operations
 * themselves rather than as a state snapshot. That keeps case files linear in
 * the number of changes and makes "what changed between v2 and v3" a direct
 * read instead of a computed diff.
 *
 * `parent_id` is written on every version so that branching can be introduced
 * later without migrating existing cases; v0.1 only ever produces a linear
 * chain.
 *
 * Deliberately *not* in v0.1: reconstructing the full state as of an arbitrary
 * past version. Doing that faithfully requires replaying operations with the
 * exact ids that were minted at the time, which needs id bookkeeping this
 * prototype does not need yet. The operation log stored here is sufficient to
 * add it later without a schema change.
 */

export interface CommitVersionInput {
  readonly label: string;
  readonly summary: string;
  readonly changesetId: string | null;
  readonly operations: readonly StateOperation[];
  readonly now: Date;
}

/**
 * Appends a version to `draft`. The draft is mutated in place — callers pass
 * the clone produced by `applyOperations`, never a persisted case.
 */
export function commitVersion(draft: IdeaCase, input: CommitVersionInput): VersionRecord {
  const parent = latestVersion(draft);
  const record: VersionRecord = {
    id: shortId('ver'),
    index: parent.index + 1,
    parent_id: parent.id,
    label: input.label,
    summary: input.summary,
    changeset_id: input.changesetId,
    operations: [...input.operations],
    created_at: input.now.toISOString(),
  };
  draft.version_history.push(record);
  return record;
}

export function getVersion(ideaCase: IdeaCase, index: number): VersionRecord | null {
  return ideaCase.version_history.find((version) => version.index === index) ?? null;
}

/** A single, display-ready line describing one change. */
export interface VersionChange {
  readonly kind: StateOperation['op'];
  readonly label: string;
  readonly detail: string;
  readonly itemId: string | null;
}

/** Fallback description for an operation with no changeset entry label. */
export function describeOperation(operation: StateOperation): string {
  switch (operation.op) {
    case 'add':
      return `Added ${singular(operation.collection)}: ${operation.item.text}`;
    case 'update':
      return `Updated ${operation.target_id}: ${Object.keys(operation.changes).join(', ')}`;
    case 'invalidate':
      return `Invalidated ${operation.target_id}: ${operation.reason}`;
    case 'relate':
      return `Linked ${operation.from} → ${operation.to} (${operation.type})`;
    case 'set_field':
      return operation.field === 'current_state'
        ? `Set phase to ${operation.value.phase}`
        : `Set ${operation.field.replace(/_/gu, ' ')}`;
    /* c8 ignore next 2 -- exhaustive */
    default:
      return 'Unknown change';
  }
}

function singular(collection: string): string {
  return collection.replace(/_/gu, ' ').replace(/s$/u, '');
}

/**
 * Renders the changes a version introduced, preferring the reviewed changeset
 * entry labels (which carry the user-facing wording and the applier's notes)
 * and falling back to a description derived from the operation itself.
 */
export function describeVersion(ideaCase: IdeaCase, version: VersionRecord): VersionChange[] {
  const changeset: ChangeSet | undefined = version.changeset_id
    ? ideaCase.changesets.find((entry) => entry.id === version.changeset_id)
    : undefined;

  if (changeset) {
    return changeset.entries
      .filter((entry) => entry.status === 'accepted')
      .map((entry) => ({
        kind: entry.operation.op,
        label: entry.label,
        detail: entry.applier_note ?? describeOperation(entry.operation),
        itemId: entry.created_item_id,
      }));
  }

  return version.operations.map((operation) => ({
    kind: operation.op,
    label: describeOperation(operation),
    detail: '',
    itemId: null,
  }));
}

/** All changes introduced strictly after `fromIndex` and up to `toIndex`. */
export function changesBetween(
  ideaCase: IdeaCase,
  fromIndex: number,
  toIndex: number,
): { version: VersionRecord; changes: VersionChange[] }[] {
  const [low, high] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  return ideaCase.version_history
    .filter((version) => version.index > low && version.index <= high)
    .map((version) => ({ version, changes: describeVersion(ideaCase, version) }));
}
