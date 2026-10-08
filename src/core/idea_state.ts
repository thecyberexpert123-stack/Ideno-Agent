import { shortId } from './ids.js';
import {
  ALL_COLLECTIONS,
  SCHEMA_VERSION,
  type AnyIdeaItem,
  type CollectionName,
  type IdeaCase,
  type VersionRecord,
} from './schemas.js';

/** Default title used until the orchestrator proposes a better one. */
export function deriveProvisionalTitle(originalIdea: string): string {
  const firstSentence = originalIdea.trim().split(/(?<=[.!?])\s+/u)[0] ?? originalIdea.trim();
  const condensed = firstSentence.replace(/\s+/gu, ' ').trim();
  if (condensed.length <= 80) return condensed || 'Untitled idea';
  return `${condensed.slice(0, 77).trimEnd()}…`;
}

export interface CreateIdeaCaseInput {
  readonly id: string;
  readonly originalIdea: string;
  readonly title?: string;
  readonly now?: Date;
}

/**
 * Builds a brand-new case at version 0.
 *
 * v0 contains no operations by design: it is the unprocessed idea exactly as
 * the user wrote it. Every later version is a batch of operations applied on
 * top, which makes "what did Ideno add?" answerable at a glance.
 */
export function createIdeaCase(input: CreateIdeaCaseInput): IdeaCase {
  const timestamp = (input.now ?? new Date()).toISOString();
  const originalIdea = input.originalIdea.trim();
  const rootVersion: VersionRecord = {
    id: shortId('ver'),
    index: 0,
    parent_id: null,
    label: 'v0 — original idea',
    summary: 'The idea exactly as it was first described, before any processing.',
    changeset_id: null,
    operations: [],
    created_at: timestamp,
  };

  return {
    schema_version: SCHEMA_VERSION,
    id: input.id,
    title: input.title?.trim() || deriveProvisionalTitle(originalIdea),
    original_idea: originalIdea,
    current_intent: '',
    requirements: [],
    assumptions: [],
    constraints: [],
    unknowns: [],
    evidence: [],
    research_items: [],
    alternatives: [],
    decisions: [],
    rejected_approaches: [],
    open_questions: [],
    relations: [],
    current_state: { phase: 'capturing', summary: '' },
    version_history: [rootVersion],
    changesets: [],
    conversation: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Every item id currently present in the case, across all collections. */
export function collectItemIds(ideaCase: IdeaCase): Set<string> {
  const ids = new Set<string>();
  for (const collection of ALL_COLLECTIONS) {
    for (const item of ideaCase[collection]) ids.add(item.id);
  }
  for (const relation of ideaCase.relations) ids.add(relation.id);
  return ids;
}

export interface LocatedItem {
  readonly collection: CollectionName;
  readonly index: number;
  readonly item: AnyIdeaItem;
}

/** Finds an item by id without the caller needing to know its collection. */
export function locateItem(ideaCase: IdeaCase, id: string): LocatedItem | null {
  for (const collection of ALL_COLLECTIONS) {
    const items: readonly AnyIdeaItem[] = ideaCase[collection];
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) {
      return { collection, index, item: items[index] as AnyIdeaItem };
    }
  }
  return null;
}

export function itemExists(ideaCase: IdeaCase, id: string): boolean {
  return locateItem(ideaCase, id) !== null;
}

/** Items that still count towards the current design. */
export function activeItems<K extends CollectionName>(
  ideaCase: IdeaCase,
  collection: K,
): IdeaCase[K] {
  return ideaCase[collection].filter((item) => item.status === 'active') as IdeaCase[K];
}

export function latestVersion(ideaCase: IdeaCase): VersionRecord {
  const last = ideaCase.version_history[ideaCase.version_history.length - 1];
  /* c8 ignore next -- a case always has v0 */
  if (!last) throw new Error(`Case ${ideaCase.id} has no version history`);
  return last;
}

export function nextVersionIndex(ideaCase: IdeaCase): number {
  return latestVersion(ideaCase).index + 1;
}

export function pendingChangeSets(ideaCase: IdeaCase) {
  return ideaCase.changesets.filter((changeset) => changeset.status === 'pending');
}

/** Counts that the UI and the context builder both need. */
export interface StateSummary {
  readonly requirements: number;
  readonly assumptions: number;
  readonly constraints: number;
  readonly unknowns: number;
  readonly evidence: number;
  readonly alternatives: number;
  readonly decisions: number;
  readonly openQuestions: number;
  readonly invalidated: number;
  readonly version: number;
  readonly pendingChangeSets: number;
}

export function summarizeState(ideaCase: IdeaCase): StateSummary {
  let invalidated = 0;
  for (const collection of ALL_COLLECTIONS) {
    for (const item of ideaCase[collection]) {
      if (item.status === 'invalidated') invalidated += 1;
    }
  }
  return {
    requirements: activeItems(ideaCase, 'requirements').length,
    assumptions: activeItems(ideaCase, 'assumptions').length,
    constraints: activeItems(ideaCase, 'constraints').length,
    unknowns: activeItems(ideaCase, 'unknowns').length,
    evidence: activeItems(ideaCase, 'evidence').length,
    alternatives: activeItems(ideaCase, 'alternatives').length,
    decisions: activeItems(ideaCase, 'decisions').length,
    openQuestions: activeItems(ideaCase, 'open_questions').length,
    invalidated,
    version: latestVersion(ideaCase).index,
    pendingChangeSets: pendingChangeSets(ideaCase).length,
  };
}
