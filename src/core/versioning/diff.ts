/**
 * Version diffing.
 *
 * "What changed between v2 and v3?" is answered by comparing two snapshots, not
 * by trusting a model's summary of itself. Snapshots are full state, so the diff
 * is exact and reproducible: the same two versions always produce the same
 * answer, which a summary string never guarantees.
 */
import type { Branch, IdeaCaseBody, VersionRecord } from '../schemas/index.js';
import {
  COLLECTIONS,
  COLLECTION_LABELS,
  itemDetail,
  itemLabel,
  itemProvenance,
  itemStatus,
  type AnyItem,
  type CollectionName,
} from '../idea_state/collections.js';
import { branchHead, commonAncestor } from './branch.js';

/** Fields that identify or timestamp an item; never interesting in a diff. */
const IGNORED_FIELDS = new Set(['id', 'created_at', 'updated_at']);

export interface DiffFieldChange {
  field: string;
  before: string;
  after: string;
}

export interface DiffEntry {
  /** `idea` for scalar case-level fields such as the goal. */
  collection: CollectionName | 'idea';
  kind: 'added' | 'removed' | 'modified';
  item_id: string | null;
  label: string;
  detail: string | null;
  provenance: string | null;
  status: string | null;
  fields: DiffFieldChange[];
}

export interface VersionDiff {
  from_version: number;
  to_version: number;
  entries: DiffEntry[];
  summary: string;
}

const SCALAR_FIELDS: { field: keyof IdeaCaseBody; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'current_intent', label: 'Goal' },
  { field: 'current_state', label: 'Phase' },
  { field: 'selected_alternative_id', label: 'Selected alternative' },
];

export function diffBodies(from: IdeaCaseBody, to: IdeaCaseBody): DiffEntry[] {
  const entries: DiffEntry[] = [];

  for (const { field, label } of SCALAR_FIELDS) {
    const before = scalarText(from[field]);
    const after = scalarText(to[field]);
    if (before === after) continue;
    entries.push({
      collection: 'idea',
      kind: 'modified',
      item_id: null,
      label,
      detail: null,
      provenance: null,
      status: null,
      fields: [{ field: label.toLowerCase(), before: before || '(empty)', after: after || '(empty)' }],
    });
  }

  for (const collection of COLLECTIONS) {
    const before = new Map((from[collection] as AnyItem[]).map((item) => [item.id, item]));
    const after = new Map((to[collection] as AnyItem[]).map((item) => [item.id, item]));

    for (const [id, item] of after) {
      const previous = before.get(id);
      if (!previous) {
        entries.push(describe(collection, 'added', item, []));
        continue;
      }
      const fields = changedFields(previous, item);
      if (fields.length > 0) entries.push(describe(collection, 'modified', item, fields));
    }

    for (const [id, item] of before) {
      if (!after.has(id)) entries.push(describe(collection, 'removed', item, []));
    }
  }

  return entries;
}

/**
 * Diff of two versions.
 *
 * A version's snapshot can be absent: storage pressure prunes the oldest
 * snapshots that are not a branch head, not labelled and not the original idea
 * (see `prunableVersions`). Comparing against one of those is not an empty diff —
 * an empty diff would say "nothing changed", which is a lie — so it is refused
 * with a message that names the version.
 */
export function diffVersions(from: VersionRecord, to: VersionRecord): VersionDiff {
  if (!from.snapshot) throw new MissingSnapshotError(from);
  if (!to.snapshot) throw new MissingSnapshotError(to);
  const entries = diffBodies(from.snapshot, to.snapshot);
  return {
    from_version: from.number,
    to_version: to.number,
    entries,
    summary: describeEntries(entries),
  };
}

export class MissingSnapshotError extends Error {
  readonly version_id: string;
  readonly version_number: number;

  constructor(version: VersionRecord) {
    super(
      `The snapshot for ${describeVersionForDiff(version)} is no longer stored, so it cannot be compared. ` +
        'It was dropped to keep the current idea savable when browser storage ran out.',
    );
    this.name = 'MissingSnapshotError';
    this.version_id = version.id;
    this.version_number = version.number;
  }
}

export function describeVersionForDiff(version: VersionRecord): string {
  return version.label ? `v${version.number} ("${version.label}")` : `v${version.number}`;
}

/** Diff of a version against its own parent, or null when it has none. */
export function diffAgainstParent(version: VersionRecord, history: VersionRecord[]): VersionDiff | null {
  const parent = version.parent_id ? history.find((entry) => entry.id === version.parent_id) : undefined;
  if (!parent) return null;
  return diffVersions(parent, version);
}

// ---------------------------------------------------------------------------
// Branch comparison
// ---------------------------------------------------------------------------

export interface BranchComparison {
  from_branch: string;
  to_branch: string;
  /**
   * The version both branches diverged from. Null when one branch has no snapshot
   * to compare or the two have no common ancestor (which cannot happen for
   * branches of the same idea unless the history is corrupt).
   */
  base: VersionRecord | null;
  from_head: VersionRecord | null;
  to_head: VersionRecord | null;
  /** Present instead of `diff` when the comparison could not be made. */
  reason: string | null;
  diff: VersionDiff | null;
  /** Versions on the target branch since divergence — the branch's own work. */
  unique_to_target: VersionRecord[];
}

/**
 * Compares two branches from the point they diverged.
 *
 * Diffing the two heads directly would include everything that happened on the
 * *other* branch since the fork as "removed", which reads as nonsense. Comparing
 * against the common ancestor answers the question actually being asked: what did
 * this branch do differently?
 */
export function compareBranches(
  from: Branch,
  to: Branch,
  history: readonly VersionRecord[],
): BranchComparison {
  const fromHead = branchHead(from, history);
  const toHead = branchHead(to, history);
  const base: BranchComparison = {
    from_branch: from.name,
    to_branch: to.name,
    base: null,
    from_head: fromHead,
    to_head: toHead,
    reason: null,
    diff: null,
    unique_to_target: [],
  };

  if (!fromHead || !toHead) {
    return { ...base, reason: 'One of these branches has no version to compare yet.' };
  }
  if (!fromHead.snapshot || !toHead.snapshot) {
    return {
      ...base,
      reason: 'The snapshot at the tip of one of these branches is no longer stored, so they cannot be compared.',
    };
  }

  const ancestor = commonAncestor(fromHead, toHead, history);
  if (!ancestor) {
    return { ...base, reason: 'These branches have no common ancestor in the stored history.' };
  }
  if (!ancestor.snapshot) {
    return {
      ...base,
      base: ancestor,
      reason: `The snapshot the two branches diverged from (${describeVersionForDiff(ancestor)}) is no longer stored, so they cannot be compared from that point.`,
    };
  }

  return {
    ...base,
    base: ancestor,
    diff: diffVersions(ancestor, toHead),
    unique_to_target: lineageSince(ancestor, toHead, history),
  };
}

/** Versions from `base` (exclusive) to `target` (inclusive), oldest first. */
export function lineageSince(
  base: VersionRecord,
  target: VersionRecord,
  history: readonly VersionRecord[],
): VersionRecord[] {
  const byId = new Map(history.map((version) => [version.id, version]));
  const out: VersionRecord[] = [];
  const seen = new Set<string>();
  let current: VersionRecord | null = target;
  while (current && current.id !== base.id && out.length < history.length && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current);
    current = current.parent_id ? (byId.get(current.parent_id) ?? null) : null;
  }
  return out.reverse();
}

function describe(
  collection: CollectionName,
  kind: DiffEntry['kind'],
  item: AnyItem,
  fields: DiffFieldChange[],
): DiffEntry {
  return {
    collection,
    kind,
    item_id: item.id,
    label: itemLabel(collection, item),
    detail: itemDetail(collection, item),
    provenance: itemProvenance(item),
    status: itemStatus(item),
    fields,
  };
}

/** Compares two versions of the same item, rendering every field as text. */
export function changedFields(before: AnyItem, after: AnyItem): DiffFieldChange[] {
  const beforeFlat = flatten(before);
  const afterFlat = flatten(after);
  const keys = new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]);
  const changes: DiffFieldChange[] = [];

  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const left = beforeFlat[key] ?? '';
    const right = afterFlat[key] ?? '';
    if (left !== right) changes.push({ field: key, before: left, after: right });
  }

  return changes.sort((a, b) => a.field.localeCompare(b.field));
}

function flatten(item: AnyItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    out[key] = scalarText(value);
  }
  return out;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Human-readable one-liner for a diff, e.g.
 * "2 constraints added · 1 assumption updated · goal restated".
 */
export function describeEntries(entries: DiffEntry[]): string {
  if (entries.length === 0) return 'No state change';

  const buckets = new Map<string, number>();
  for (const entry of entries) {
    const label =
      entry.collection === 'idea'
        ? `${entry.label} ${kindWord(entry.kind)}`.toLowerCase()
        : `${COLLECTION_LABELS[entry.collection]} ${kindWord(entry.kind)}`;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }

  return Array.from(buckets.entries())
    .map(([label, count]) => `${count} ${label}`)
    .join(' · ');
}

function kindWord(kind: DiffEntry['kind']): string {
  return kind === 'added' ? 'added' : kind === 'removed' ? 'removed' : 'updated';
}
