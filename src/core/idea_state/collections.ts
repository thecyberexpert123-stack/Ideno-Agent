/**
 * The collection registry: the one place that knows how to walk an IdeaCase.
 *
 * Diffing, applying changes, building model context, projecting the canonical
 * representation and rendering the UI all need the same three things — the list
 * of collections, how to display an item, and how to validate one. Centralising
 * it means adding a collection is a one-file change instead of a scavenger hunt.
 */
import { z } from 'zod';

import type {
  Alternative,
  Assumption,
  Constraint,
  Decision,
  Evidence,
  Finding,
  IdeaCaseBody,
  OpenQuestion,
  RejectedApproach,
  Requirement,
  ResearchItem,
  Unknown,
} from '../schemas/index.js';
import {
  AlternativeSchema,
  AssumptionSchema,
  ConstraintSchema,
  DecisionSchema,
  EvidenceSchema,
  FindingSchema,
  OpenQuestionSchema,
  RejectedApproachSchema,
  RequirementSchema,
  ResearchItemSchema,
  UnknownSchema,
  formatZodIssues,
} from '../schemas/index.js';

export const COLLECTIONS = [
  'requirements',
  'assumptions',
  'constraints',
  'unknowns',
  'evidence',
  'research_items',
  'alternatives',
  'decisions',
  'rejected_approaches',
  'open_questions',
  'findings',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

export const COLLECTION_LABELS: Record<CollectionName, string> = {
  requirements: 'Requirements',
  assumptions: 'Assumptions',
  constraints: 'Constraints',
  unknowns: 'Unknowns',
  evidence: 'Evidence',
  research_items: 'Research questions',
  alternatives: 'Alternatives',
  decisions: 'Decisions',
  rejected_approaches: 'Rejected approaches',
  open_questions: 'Open questions',
  findings: 'Critique findings',
};

/** Schema used to validate an item before it is written into the state. */
export const COLLECTION_ITEM_SCHEMAS: Record<CollectionName, z.ZodType<unknown>> = {
  requirements: RequirementSchema,
  assumptions: AssumptionSchema,
  constraints: ConstraintSchema,
  unknowns: UnknownSchema,
  evidence: EvidenceSchema,
  research_items: ResearchItemSchema,
  alternatives: AlternativeSchema,
  decisions: DecisionSchema,
  rejected_approaches: RejectedApproachSchema,
  open_questions: OpenQuestionSchema,
  findings: FindingSchema,
};

/** Status each collection uses when an item is invalidated or dropped. */
export const TERMINAL_STATUS: Record<CollectionName, string> = {
  requirements: 'dropped',
  assumptions: 'invalidated',
  constraints: 'dropped',
  unknowns: 'resolved',
  evidence: 'retracted',
  research_items: 'abandoned',
  alternatives: 'rejected',
  decisions: 'superseded',
  rejected_approaches: 'rejected',
  open_questions: 'withdrawn',
  findings: 'dismissed',
};

/** Statuses that mean "this is no longer live" — used for counting and UI. */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'dropped',
  'invalidated',
  'resolved',
  'retracted',
  'abandoned',
  'rejected',
  'superseded',
  'reversed',
  'withdrawn',
  'dismissed',
  'answered',
  'satisfied',
]);

export type AnyItem =
  | Requirement
  | Assumption
  | Constraint
  | Unknown
  | Evidence
  | ResearchItem
  | Alternative
  | Decision
  | RejectedApproach
  | OpenQuestion
  | Finding;

export interface ItemLocation {
  collection: CollectionName;
  item: AnyItem;
  index: number;
}

/** The id field every item has. */
export function itemId(item: AnyItem): string {
  return item.id;
}

/**
 * One-line display text for any item. Collections disagree about which field
 * holds the substance (Evidence has `claim`, a ResearchItem has `question`, an
 * Alternative has `name` + `summary`), so this is the single mapping.
 */
export function itemLabel(collection: CollectionName, item: AnyItem): string {
  switch (collection) {
    case 'evidence':
      return (item as Evidence).claim;
    case 'research_items':
      return (item as ResearchItem).question;
    case 'open_questions':
      return (item as OpenQuestion).question;
    case 'alternatives':
      return (item as Alternative).name;
    case 'rejected_approaches':
      return (item as RejectedApproach).name;
    default:
      return (item as { text: string }).text;
  }
}

/** Secondary detail line, when the collection has one worth showing. */
export function itemDetail(collection: CollectionName, item: AnyItem): string | null {
  switch (collection) {
    case 'evidence': {
      const evidence = item as Evidence;
      return `${evidence.source.title} — ${evidence.source.locator}`;
    }
    case 'alternatives':
      return (item as Alternative).summary;
    case 'rejected_approaches':
      return (item as RejectedApproach).reason;
    case 'research_items':
      return (item as ResearchItem).rationale;
    case 'findings':
      return (item as Finding).recommendation;
    case 'decisions':
      return (item as Decision).rationale;
    case 'unknowns': {
      const areas = (item as Unknown).affected_areas;
      return areas.length > 0 ? `Blocks: ${areas.join(', ')}` : null;
    }
    default:
      return (item as { notes?: string | null }).notes ?? null;
  }
}

/**
 * Status readers accept any item object. `RejectedApproach` has no status at
 * all, so the parameter is typed structurally and read defensively rather than
 * pretending every collection agrees.
 */
export function itemStatus(item: object): string {
  const status = (item as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'n/a';
}

export function itemProvenance(item: AnyItem): string {
  return (item as { provenance?: string }).provenance ?? 'model_suggestion';
}

export function isClosed(item: object): boolean {
  return CLOSED_STATUSES.has(itemStatus(item));
}

/** Every item in the case, tagged with its collection, in display order. */
export function allItems(body: IdeaCaseBody): ItemLocation[] {
  const out: ItemLocation[] = [];
  for (const collection of COLLECTIONS) {
    const items = body[collection] as AnyItem[];
    items.forEach((item, index) => out.push({ collection, item, index }));
  }
  return out;
}

/** Looks an item up by id across every collection. */
export function findItem(body: IdeaCaseBody, id: string): ItemLocation | null {
  for (const collection of COLLECTIONS) {
    const items = body[collection] as AnyItem[];
    const index = items.findIndex((item) => item.id === id);
    if (index !== -1) {
      return { collection, item: items[index] as AnyItem, index };
    }
  }
  return null;
}

export function itemIds(body: IdeaCaseBody): Set<string> {
  return new Set(allItems(body).map((located) => located.item.id));
}

/**
 * Re-validates a candidate item against its collection schema. Every mutation
 * of the Idea State goes through this, which is what makes "the state is always
 * schema-valid" a structural guarantee rather than a convention.
 */
export function parseItem(
  collection: CollectionName,
  candidate: unknown,
): { ok: true; item: AnyItem } | { ok: false; issues: string[] } {
  const schema = COLLECTION_ITEM_SCHEMAS[collection];
  const result = schema.safeParse(candidate);
  if (result.success) return { ok: true, item: result.data as AnyItem };
  return { ok: false, issues: formatZodIssues(result.error, 6) };
}
