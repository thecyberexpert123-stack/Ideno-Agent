/**
 * The version tree: pure functions over branches and history.
 *
 * Nothing here mutates anything. `StateManager` uses these to decide what a
 * commit extends, what a branch switch loads, and which snapshots may be pruned;
 * the UI uses them to render the branch list and per-branch version numbers.
 *
 * The model is deliberately small:
 *
 *   - `version_history` is an append-only array of `VersionRecord`.
 *   - each record names its `parent_id` and its `branch_id`.
 *   - a `Branch` names its tip (`head_version_id`).
 *
 * So "the history of branch B" is a walk from B's head through `parent_id`, and a
 * branch costs one record rather than a copy of the idea. Two branches forked from
 * the same point share every snapshot below it, which is what keeps branching
 * affordable in `localStorage`.
 */
import type { Branch, IdeaCase, VersionRecord } from '../schemas/index.js';

export type History = readonly VersionRecord[];

export interface BranchLineage {
  /** Newest first: the head, then its parent, back to the root of the tree. */
  versions: VersionRecord[];
  /** True when a `parent_id` cycle was detected and the walk was stopped. */
  cycle_detected: boolean;
}

/** Safety bound on any walk over history. Corrupt data must not hang the app. */
const MAX_WALK = 5000;

export function activeBranch(idea: IdeaCase): Branch | null {
  if (!idea.active_branch_id) return idea.branches[0] ?? null;
  return idea.branches.find((branch) => branch.id === idea.active_branch_id) ?? null;
}

export function findBranch(idea: IdeaCase, branchId: string | null): Branch | null {
  if (!branchId) return null;
  return idea.branches.find((branch) => branch.id === branchId) ?? null;
}

export function findVersion(history: History, versionId: string | null): VersionRecord | null {
  if (!versionId) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const version = history[index];
    if (version && version.id === versionId) return version;
  }
  return null;
}

export function versionById(history: History): Map<string, VersionRecord> {
  const map = new Map<string, VersionRecord>();
  for (const version of history) map.set(version.id, version);
  return map;
}

/**
 * Walks a branch from its tip back to the root of the tree.
 *
 * The walk follows `parent_id` rather than filtering by `branch_id`, because a
 * branch inherits its parent branch's history: `feature` forked from `main` at v4
 * has the lineage v7 → v6 → v5 → v4 → v3 → v2 → v1 → v0 even though only v5..v7
 * carry `branch_id === feature`. Filtering would have shown a branch that appears
 * to start from nothing.
 */
export function branchLineage(branch: Branch | null, history: History): BranchLineage {
  const versions: VersionRecord[] = [];
  if (!branch) return { versions, cycle_detected: false };

  const byId = versionById(history);
  const seen = new Set<string>();
  let current = byId.get(branch.head_version_id) ?? null;
  let cycleDetected = false;

  while (current && versions.length < MAX_WALK) {
    if (seen.has(current.id)) {
      cycleDetected = true;
      break;
    }
    seen.add(current.id);
    versions.push(current);
    current = current.parent_id ? (byId.get(current.parent_id) ?? null) : null;
  }

  return { versions, cycle_detected: cycleDetected };
}

/** A branch's own history, oldest first — what the Versions panel lists. */
export function branchVersions(branch: Branch | null, history: History): VersionRecord[] {
  return branchLineage(branch, history).versions.slice().reverse();
}

/**
 * Human-readable position of each version within its branch, e.g. `main#3`.
 *
 * Derived rather than stored: the stored `number` is globally monotonic, so it
 * stays a reliable ordering key across branches, while the number a person reads
 * is the position along the branch they are looking at. Storing both would be two
 * sources of truth for the same fact.
 */
export function branchVersionNumbers(branch: Branch | null, history: History): Map<string, number> {
  const numbers = new Map<string, number>();
  branchVersions(branch, history).forEach((version, index) => numbers.set(version.id, index));
  return numbers;
}

export function branchHead(branch: Branch | null, history: History): VersionRecord | null {
  return findVersion(history, branch?.head_version_id ?? null);
}

/**
 * The nearest version two versions share, or null when they have no common
 * ancestor (which should be impossible: every branch descends from v0).
 *
 * This is the merge-base of two branches, and it is what makes "compare this
 * branch with that one" answer the question a person actually means: what changed
 * since they diverged, rather than what differs between two arbitrary snapshots.
 */
export function commonAncestor(
  from: VersionRecord | null,
  to: VersionRecord | null,
  history: History,
): VersionRecord | null {
  if (!from || !to) return null;
  const byId = versionById(history);

  const ancestorsOf = (start: VersionRecord): Set<string> => {
    const seen = new Set<string>();
    let current: VersionRecord | null = start;
    while (current && seen.size < MAX_WALK) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      current = current.parent_id ? (byId.get(current.parent_id) ?? null) : null;
    }
    return seen;
  };

  const fromAncestors = ancestorsOf(from);
  let current: VersionRecord | null = to;
  let steps = 0;
  while (current && steps < MAX_WALK) {
    if (fromAncestors.has(current.id)) return current;
    steps += 1;
    current = current.parent_id ? (byId.get(current.parent_id) ?? null) : null;
  }
  return null;
}

/**
 * Which snapshots may be dropped when storage runs out, oldest first.
 *
 * Pruning is a last resort and it is lossy, so the rules are conservative and
 * explicit. A snapshot is kept when it is:
 *
 *  - the original idea (`trigger: 'initial'`) — losing v0 loses the one thing the
 *    human said before Ideno started interpreting it;
 *  - a branch head — it is what a branch switch or fork would load;
 *  - labelled by the user — a label is an explicit statement that this point
 *    matters;
 *  - among the newest `keepRecent` versions of its branch — the recent past is
 *    what a person compares against and restores from.
 *
 * The *record* always survives; only `snapshot` is dropped and
 * `snapshot_pruned` is set, so history still reads as an account of what happened
 * and the UI can say "snapshot no longer available" instead of showing an empty
 * diff.
 */
export function prunableVersions(
  history: History,
  branches: readonly Branch[],
  options: { keepRecent?: number } = {},
): VersionRecord[] {
  const keepRecent = Math.max(0, options.keepRecent ?? 8);

  const protectedIds = new Set<string>();
  for (const branch of branches) {
    // Newest first, so `slice` keeps the recent past of every branch — including
    // the history it inherited from its parent branch, which is shared rather than
    // duplicated and therefore must not be dropped just because a fork is young.
    branchLineage(branch, history).versions.slice(0, keepRecent).forEach((version) => protectedIds.add(version.id));
    // A head can dangle (a restore that did not move it, corrupt data), so protect
    // the id directly as well.
    protectedIds.add(branch.head_version_id);
  }

  return history
    .filter((version) => {
      if (version.snapshot === null) return false; // already pruned
      if (protectedIds.has(version.id)) return false;
      if (version.label) return false;
      if (version.trigger === 'initial') return false;
      return true;
    })
    .sort((a, b) => a.number - b.number);
}

/** Live (non-archived) branches, oldest first. */
export function liveBranches(idea: IdeaCase): Branch[] {
  return idea.branches.filter((branch) => !branch.archived);
}

/** A name for `branchId` that is not already taken on this idea. */
export function suggestBranchName(idea: IdeaCase, desired: string): string {
  const base = desired.trim().slice(0, 60) || 'branch';
  const taken = new Set(idea.branches.map((branch) => branch.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 60);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable in practice: 998 suffixes cannot all be taken while the branch
  // count is capped at 40. Returning something unique regardless.
  return `${base}-${Date.now()}`.slice(0, 60);
}
