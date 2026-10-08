import { uniqueShortId, ID_PREFIXES, type IdPrefix } from './ids.js';
import { collectItemIds, locateItem } from './idea_state.js';
import {
  COLLECTION_ITEM_SCHEMAS,
  type AddOperation,
  type AnyIdeaItem,
  type CollectionName,
  type EpistemicStatus,
  type IdeaCase,
  type Origin,
  type Relation,
  type StateOperation,
} from './schemas.js';

/**
 * The patch applier: the only code in Ideno allowed to mutate an Idea State.
 *
 * It assumes its input is *syntactically* valid (it has already been through
 * the Zod operation schemas) but **semantically untrusted**. Its job is to
 * enforce the invariants that keep the state honest:
 *
 *  1. A claim may only be `evidence_supported` if real evidence backs it.
 *  2. A model-proposed item may only be `known` / `user_decision` if it quotes
 *     text that actually appears in the user's message.
 *  3. References to items that do not exist are dropped, never invented.
 *  4. Duplicates do not accumulate.
 *  5. Collections are bounded.
 *
 * A violation never aborts the batch and never corrupts state: the offending
 * operation is skipped or downgraded, and the reason is recorded so the user
 * can see exactly what Ideno refused to do.
 */

const DEFAULT_MAX_ITEMS_PER_COLLECTION = 150;
const MIN_VERIFIABLE_QUOTE_LENGTH = 4;

const COLLECTION_ID_PREFIX: Record<CollectionName, IdPrefix> = {
  requirements: ID_PREFIXES.requirement,
  assumptions: ID_PREFIXES.assumption,
  constraints: ID_PREFIXES.constraint,
  unknowns: ID_PREFIXES.unknown,
  evidence: ID_PREFIXES.evidence,
  research_items: ID_PREFIXES.research_item,
  alternatives: ID_PREFIXES.alternative,
  decisions: ID_PREFIXES.decision,
  rejected_approaches: ID_PREFIXES.rejected_approach,
  open_questions: ID_PREFIXES.open_question,
};

export interface ApplyEntry {
  /** Changeset entry id, used to report the outcome back. */
  readonly id: string;
  readonly operation: StateOperation;
}

export interface OperationOutcome {
  readonly applied: boolean;
  /** Human-readable explanation when an operation was altered or skipped. */
  readonly note: string | null;
  readonly createdItemId: string | null;
}

export interface ApplyOptions {
  /** Who is proposing these operations. Controls trust, not correctness. */
  readonly origin: Origin;
  /**
   * The user message this batch reacts to. Used to verify `source_quote`
   * claims. Pass null when there is no user turn to verify against.
   */
  readonly userMessage?: string | null;
  readonly versionIndex: number;
  readonly now: Date;
  readonly maxItemsPerCollection?: number;
}

export interface ApplyResult {
  readonly ideaCase: IdeaCase;
  readonly outcomes: Map<string, OperationOutcome>;
  /** True when at least one operation actually changed the state. */
  readonly changed: boolean;
}

/** Collapses whitespace and case so two phrasings of the same text match. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Verifies that a quoted span really occurs in the user's message.
 *
 * Whitespace and case are normalised (models reflow quotes), but nothing else:
 * a paraphrase will not pass, which is the entire point.
 */
export function quoteOccursIn(quote: string | null | undefined, message: string | null | undefined): boolean {
  if (!quote || !message) return false;
  const normalizedQuote = normalizeText(quote);
  if (normalizedQuote.length < MIN_VERIFIABLE_QUOTE_LENGTH) return false;
  return normalizeText(message).includes(normalizedQuote);
}

interface StatusDecision {
  readonly status: EpistemicStatus;
  readonly note: string | null;
}

/**
 * Decides the epistemic status an item is actually entitled to.
 *
 * This is the enforcement point for "never present a model guess as a fact".
 */
export function reconcileEpistemicStatus(params: {
  requested: EpistemicStatus;
  collection: CollectionName;
  origin: Origin;
  quoteVerified: boolean;
  resolvedEvidenceCount: number;
}): StatusDecision {
  const { requested, collection, origin, quoteVerified, resolvedEvidenceCount } = params;

  // Evidence records are the source of support; they carry the status directly.
  if (collection === 'evidence') {
    return requested === 'evidence_supported'
      ? { status: 'evidence_supported', note: null }
      : {
          status: 'evidence_supported',
          note: `Evidence records are always recorded as "evidence_supported" (proposed "${requested}").`,
        };
  }

  if (requested === 'evidence_supported' && resolvedEvidenceCount === 0) {
    const fallback: EpistemicStatus = origin === 'user' ? 'assumed' : 'model_suggestion';
    return {
      status: fallback,
      note: `Downgraded from "evidence_supported" to "${fallback}": no existing evidence record supports it.`,
    };
  }

  if ((requested === 'known' || requested === 'user_decision') && origin !== 'user' && !quoteVerified) {
    return {
      status: 'model_suggestion',
      note: `Downgraded from "${requested}" to "model_suggestion": not traceable to anything you said.`,
    };
  }

  return { status: requested, note: null };
}

function joinNotes(notes: readonly (string | null)[]): string | null {
  const present = notes.filter((note): note is string => Boolean(note));
  return present.length > 0 ? present.join(' ') : null;
}

/**
 * Resolves an item reference: either a `@localRef` minted earlier in this
 * batch, or an id that already exists in the case. Returns null when neither.
 */
function resolveReference(
  reference: string | null | undefined,
  refMap: ReadonlyMap<string, string>,
  ideaCase: IdeaCase,
): string | null {
  if (!reference) return null;
  if (reference.startsWith('@')) {
    return refMap.get(reference.slice(1)) ?? null;
  }
  return locateItem(ideaCase, reference) ? reference : null;
}

function resolveEvidenceIds(
  references: readonly string[] | undefined,
  refMap: ReadonlyMap<string, string>,
  ideaCase: IdeaCase,
): { ids: string[]; dropped: number } {
  const ids: string[] = [];
  let dropped = 0;
  for (const reference of references ?? []) {
    const resolved = resolveReference(reference, refMap, ideaCase);
    const isEvidence = resolved !== null && ideaCase.evidence.some((item) => item.id === resolved);
    if (isEvidence) {
      if (!ids.includes(resolved)) ids.push(resolved);
    } else {
      dropped += 1;
    }
  }
  return { ids, dropped };
}

/** Text used for duplicate detection within a collection. */
function identityText(collection: CollectionName, item: AnyIdeaItem): string {
  if (collection === 'evidence' && 'claim' in item) {
    const source = item.source;
    const sourceKey = source.type === 'url' ? source.url : source.type === 'user' ? source.description : source.name;
    return normalizeText(`${item.claim}|${sourceKey}`);
  }
  if (collection === 'research_items' && 'question' in item) return normalizeText(item.question);
  if (collection === 'alternatives' && 'approach' in item) return normalizeText(item.approach);
  return normalizeText(item.text);
}

function findDuplicate(
  ideaCase: IdeaCase,
  collection: CollectionName,
  candidateKey: string,
): AnyIdeaItem | null {
  for (const existing of ideaCase[collection] as readonly AnyIdeaItem[]) {
    if (existing.status === 'rejected') continue;
    if (identityText(collection, existing) === candidateKey) return existing;
  }
  return null;
}

interface BuildItemResult {
  readonly item: AnyIdeaItem;
  readonly note: string | null;
}

function buildItem(
  operation: AddOperation,
  ideaCase: IdeaCase,
  refMap: ReadonlyMap<string, string>,
  options: ApplyOptions,
  takenIds: ReadonlySet<string>,
): BuildItemResult {
  const { collection } = operation;
  const proposal = operation.item;
  const timestamp = options.now.toISOString();
  const id = uniqueShortId(COLLECTION_ID_PREFIX[collection], takenIds);

  const quoteVerified = quoteOccursIn(proposal.source_quote, options.userMessage);
  const quoteNote =
    proposal.source_quote && !quoteVerified
      ? 'The quoted source text was not found in your message, so it was dropped.'
      : null;

  const evidence = resolveEvidenceIds(proposal.supported_by, refMap, ideaCase);
  const evidenceNote =
    evidence.dropped > 0
      ? `${evidence.dropped} unresolvable evidence reference(s) were dropped.`
      : null;

  const statusDecision = reconcileEpistemicStatus({
    requested: proposal.epistemic_status,
    collection,
    origin: options.origin,
    quoteVerified,
    resolvedEvidenceCount: evidence.ids.length,
  });

  const base = {
    id,
    text: proposal.text,
    epistemic_status: statusDecision.status,
    origin: options.origin,
    status: 'active' as const,
    confidence: proposal.confidence ?? null,
    ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
    tags: proposal.tags ?? [],
    supported_by: evidence.ids,
    source_quote: quoteVerified ? (proposal.source_quote ?? null) : null,
    created_at: timestamp,
    updated_at: timestamp,
    created_in_version: options.versionIndex,
  };

  const notes: (string | null)[] = [quoteNote, evidenceNote, statusDecision.note];
  let raw: Record<string, unknown>;

  switch (operation.collection) {
    case 'unknowns':
    case 'open_questions':
      raw = {
        ...base,
        impact: operation.item.impact ?? 0.5,
        blocks: operation.item.blocks ?? [],
      };
      break;
    case 'evidence':
      raw = {
        ...base,
        claim: operation.item.claim,
        source: operation.item.source,
        relevance: operation.item.relevance,
        excerpt: operation.item.excerpt ?? null,
        research_item_id: resolveReference(operation.item.research_item_id, refMap, ideaCase),
        timestamp,
      };
      break;
    case 'research_items':
      raw = {
        ...base,
        question: operation.item.question,
        research_status: 'open',
        ...(operation.item.why_it_matters === undefined
          ? {}
          : { why_it_matters: operation.item.why_it_matters }),
        evidence_ids: [],
        error: null,
        last_attempt_at: null,
      };
      break;
    case 'alternatives': {
      const satisfies = (operation.item.satisfies_constraints ?? [])
        .map((reference) => resolveReference(reference, refMap, ideaCase))
        .filter((value): value is string => value !== null);
      const violates = (operation.item.violates_constraints ?? [])
        .map((reference) => resolveReference(reference, refMap, ideaCase))
        .filter((value): value is string => value !== null);
      raw = {
        ...base,
        summary: operation.item.summary,
        approach: operation.item.approach,
        pros: operation.item.pros ?? [],
        cons: operation.item.cons ?? [],
        tradeoffs: operation.item.tradeoffs ?? [],
        preconditions: operation.item.preconditions ?? [],
        satisfies_constraints: satisfies,
        violates_constraints: violates,
        selected: false,
      };
      break;
    }
    case 'decisions': {
      const alternativeId = resolveReference(operation.item.alternative_id, refMap, ideaCase);
      if (operation.item.alternative_id && !alternativeId) {
        notes.push('The referenced alternative does not exist, so the decision was recorded without a link.');
      }
      raw = {
        ...base,
        question: operation.item.question,
        chosen: operation.item.chosen,
        alternative_id: alternativeId,
        decided_by: options.origin === 'user' || quoteVerified ? 'user' : 'system',
        decided_at: timestamp,
      };
      break;
    }
    case 'rejected_approaches': {
      const alternativeId = resolveReference(operation.item.alternative_id, refMap, ideaCase);
      raw = {
        ...base,
        reason: operation.item.reason,
        alternative_id: alternativeId,
        rejected_at: timestamp,
      };
      break;
    }
    default:
      raw = base;
  }

  // Final gate: nothing enters the state without satisfying the canonical
  // item schema, independent of how it was constructed above.
  const parsed = COLLECTION_ITEM_SCHEMAS[collection].parse(raw) as AnyIdeaItem;
  return { item: parsed, note: joinNotes(notes) };
}

function applyUpdate(
  ideaCase: IdeaCase,
  targetId: string,
  changes: Record<string, unknown>,
  reason: string,
  timestamp: string,
): string | null {
  const located = locateItem(ideaCase, targetId);
  /* c8 ignore next -- caller resolved the reference first */
  if (!located) return null;
  const collectionItems = ideaCase[located.collection] as AnyIdeaItem[];
  const current = collectionItems[located.index] as AnyIdeaItem;

  const merged: Record<string, unknown> = { ...current };
  const notes: string[] = [];

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (!(key in current)) {
      notes.push(`"${key}" does not apply to a ${located.collection.replace(/_/gu, ' ')} item and was ignored.`);
      continue;
    }
    merged[key] = value;
  }

  if (changes.status !== undefined && changes.status !== 'active') {
    merged.status_reason = reason;
  }
  merged.updated_at = timestamp;

  const parsed = COLLECTION_ITEM_SCHEMAS[located.collection].parse(merged) as AnyIdeaItem;
  collectionItems[located.index] = parsed;

  // Selecting an alternative is exclusive: the Idea State records one chosen
  // approach at a time. Earlier choices stay in `decisions` as history.
  if (located.collection === 'alternatives' && changes.selected === true) {
    for (const alternative of ideaCase.alternatives) {
      if (alternative.id !== targetId && alternative.selected) {
        alternative.selected = false;
        alternative.updated_at = timestamp;
      }
    }
  }

  return notes.length > 0 ? notes.join(' ') : null;
}

/**
 * Applies a batch of operations and returns a new case plus a per-operation
 * outcome. The input case is never mutated.
 */
export function applyOperations(
  ideaCase: IdeaCase,
  entries: readonly ApplyEntry[],
  options: ApplyOptions,
): ApplyResult {
  const draft: IdeaCase = structuredClone(ideaCase);
  const outcomes = new Map<string, OperationOutcome>();
  const refMap = new Map<string, string>();
  const takenIds = collectItemIds(draft);
  const maxItems = options.maxItemsPerCollection ?? DEFAULT_MAX_ITEMS_PER_COLLECTION;
  const timestamp = options.now.toISOString();
  let changed = false;

  const skip = (entryId: string, note: string): void => {
    outcomes.set(entryId, { applied: false, note, createdItemId: null });
  };

  for (const entry of entries) {
    const { operation } = entry;

    switch (operation.op) {
      case 'add': {
        const collection = operation.collection;
        if (draft[collection].length >= maxItems) {
          skip(entry.id, `The ${collection.replace(/_/gu, ' ')} list is at its limit of ${maxItems} items.`);
          break;
        }
        const built = buildItem(operation, draft, refMap, options, takenIds);
        const duplicate = findDuplicate(draft, collection, identityText(collection, built.item));
        if (duplicate) {
          skip(entry.id, `Already tracked as ${duplicate.id}.`);
          break;
        }
        (draft[collection] as AnyIdeaItem[]).push(built.item);
        takenIds.add(built.item.id);
        if (operation.ref) refMap.set(operation.ref, built.item.id);
        outcomes.set(entry.id, {
          applied: true,
          note: built.note,
          createdItemId: built.item.id,
        });
        changed = true;
        break;
      }

      case 'update': {
        const targetId = resolveReference(operation.target_id, refMap, draft);
        if (!targetId) {
          skip(entry.id, `No item with id "${operation.target_id}" exists.`);
          break;
        }
        const note = applyUpdate(draft, targetId, operation.changes, operation.reason, timestamp);
        outcomes.set(entry.id, { applied: true, note, createdItemId: null });
        changed = true;
        break;
      }

      case 'invalidate': {
        const targetId = resolveReference(operation.target_id, refMap, draft);
        if (!targetId) {
          skip(entry.id, `No item with id "${operation.target_id}" exists.`);
          break;
        }
        const located = locateItem(draft, targetId);
        /* c8 ignore next -- resolveReference guarantees presence */
        if (!located) break;
        if (located.item.status === 'invalidated') {
          skip(entry.id, `${targetId} was already invalidated.`);
          break;
        }
        const note = applyUpdate(
          draft,
          targetId,
          { status: 'invalidated' },
          operation.reason,
          timestamp,
        );
        outcomes.set(entry.id, { applied: true, note, createdItemId: null });
        changed = true;
        break;
      }

      case 'relate': {
        const from = resolveReference(operation.from, refMap, draft);
        const to = resolveReference(operation.to, refMap, draft);
        if (!from || !to) {
          skip(entry.id, `Cannot link "${operation.from}" → "${operation.to}": one of them does not exist.`);
          break;
        }
        if (from === to) {
          skip(entry.id, 'An item cannot be related to itself.');
          break;
        }
        const alreadyLinked = draft.relations.some(
          (relation) => relation.from === from && relation.to === to && relation.type === operation.type,
        );
        if (alreadyLinked) {
          skip(entry.id, 'That link already exists.');
          break;
        }
        const relation: Relation = {
          id: uniqueShortId(ID_PREFIXES.relation, takenIds),
          from,
          to,
          type: operation.type,
          ...(operation.note === undefined ? {} : { note: operation.note }),
          created_at: timestamp,
          created_in_version: options.versionIndex,
        };
        draft.relations.push(relation);
        takenIds.add(relation.id);
        outcomes.set(entry.id, { applied: true, note: null, createdItemId: relation.id });
        changed = true;
        break;
      }

      case 'set_field': {
        if (operation.field === 'title') draft.title = operation.value;
        else if (operation.field === 'current_intent') draft.current_intent = operation.value;
        else draft.current_state = operation.value;
        outcomes.set(entry.id, { applied: true, note: null, createdItemId: null });
        changed = true;
        break;
      }

      /* c8 ignore next 4 -- exhaustive over the operation union */
      default: {
        const unreachable: never = operation;
        skip(entry.id, `Unsupported operation: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  if (changed) draft.updated_at = timestamp;
  return { ideaCase: draft, outcomes, changed };
}
