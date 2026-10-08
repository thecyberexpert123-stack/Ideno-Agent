import type { PendingAddition } from '../core/context.js';
import { shortId } from '../core/ids.js';
import { itemExists } from '../core/idea_state.js';
import type {
  CollectionName,
  EpistemicStatus,
  IdeaCase,
  StateOperation,
} from '../core/schemas.js';
import type {
  Basis,
  CritiqueResult,
  ExploreResult,
  ExtractedStatement,
  ExtractedUnknown,
  ImpactResult,
  UnderstandResult,
} from './schemas.js';

/**
 * Translation: reasoning output → state operations.
 *
 * This is ordinary, deterministic TypeScript on purpose. The model describes
 * findings in its own domain language; only this module decides what that
 * means for the Idea State. A model therefore cannot emit an illegal
 * transition, target an id that does not exist, or award itself a stronger
 * epistemic status than its basis allows.
 */

export interface DraftEntry {
  readonly id: string;
  readonly operation: StateOperation;
  readonly label: string;
  readonly affected_areas: string[];
  readonly affected_item_ids: string[];
}

export interface TranslationOutput {
  readonly entries: DraftEntry[];
  readonly pendingAdditions: PendingAddition[];
}

/** Basis → epistemic status. `stated` is still verified by the applier. */
export function statusForBasis(basis: Basis): EpistemicStatus {
  switch (basis) {
    case 'stated':
      return 'known';
    case 'implied':
      return 'assumed';
    case 'inferred':
      return 'model_suggestion';
  }
}

/**
 * Allocates changeset-local refs. Each stage uses its own prefix so that refs
 * stay unique across the single batch all stages contribute to.
 */
class RefAllocator {
  #counter = 0;
  constructor(private readonly prefix: string) {}
  next(): string {
    this.#counter += 1;
    return `${this.prefix}${this.#counter}`;
  }
}

function entry(
  operation: StateOperation,
  label: string,
  options: { areas?: readonly string[]; items?: readonly string[] } = {},
): DraftEntry {
  return {
    id: shortId('op'),
    operation,
    label: label.slice(0, 300),
    affected_areas: [...(options.areas ?? [])].slice(0, 10),
    affected_item_ids: [...(options.items ?? [])].slice(0, 10),
  };
}

/** Drops ids the model invented; keeps real ids and in-flight `@refs`. */
function keepResolvable(
  ideaCase: IdeaCase,
  ids: readonly string[] | null | undefined,
  refs: ReadonlySet<string>,
): string[] {
  const kept: string[] = [];
  for (const id of ids ?? []) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@')) {
      if (refs.has(trimmed.slice(1))) kept.push(trimmed);
      continue;
    }
    if (itemExists(ideaCase, trimmed)) kept.push(trimmed);
  }
  return [...new Set(kept)];
}

function baseFields(statement: ExtractedStatement): {
  text: string;
  epistemic_status: EpistemicStatus;
  confidence?: number | null;
  rationale?: string;
  source_quote?: string | null;
} {
  return {
    text: statement.text,
    epistemic_status: statusForBasis(statement.basis),
    ...(statement.confidence === undefined || statement.confidence === null
      ? {}
      : { confidence: statement.confidence }),
    ...(statement.rationale ? { rationale: statement.rationale } : {}),
    ...(statement.source_quote ? { source_quote: statement.source_quote } : {}),
  };
}

function openFields(statement: ExtractedUnknown): {
  impact: number;
  blocks: string[];
} {
  return {
    impact: statement.impact ?? 0.5,
    blocks: statement.blocks ?? [],
  };
}

/** Collections whose items carry no fields beyond the common item shape. */
type SimpleCollection = 'requirements' | 'constraints' | 'assumptions';

/** UNDERSTAND → operations. Also returns the `@refs` later stages can cite. */
export function translateUnderstand(
  result: UnderstandResult,
  ideaCase: IdeaCase,
): TranslationOutput {
  const entries: DraftEntry[] = [];
  const pendingAdditions: PendingAddition[] = [];
  const refs = new RefAllocator('n');

  if (result.title_suggestion && result.title_suggestion.trim() !== ideaCase.title) {
    entries.push(
      entry(
        { op: 'set_field', field: 'title', value: result.title_suggestion.trim() },
        `Title: ${result.title_suggestion.trim()}`,
      ),
    );
  }

  const goal = result.goal?.trim();
  if (goal && goal !== ideaCase.current_intent) {
    entries.push(
      entry({ op: 'set_field', field: 'current_intent', value: goal }, `Goal: ${goal}`),
    );
  }

  // `current_state` (phase + summary) is set once by the orchestrator after
  // every stage has reported, so a turn never emits two competing updates.

  const addSimple = (collection: SimpleCollection, statements: readonly ExtractedStatement[]): void => {
    for (const statement of statements) {
      const ref = refs.next();
      entries.push(
        entry(
          { op: 'add', collection, ref, item: baseFields(statement) },
          statement.text,
        ),
      );
      pendingAdditions.push({ ref, collection, text: statement.text });
    }
  };

  addSimple('constraints', result.constraints);
  addSimple('requirements', result.requirements);
  addSimple('assumptions', result.assumptions);

  for (const unknown of result.unknowns) {
    const ref = refs.next();
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'unknowns',
          ref,
          item: { ...baseFields(unknown), ...openFields(unknown) },
        },
        unknown.text,
        { areas: unknown.blocks ?? [] },
      ),
    );
    pendingAdditions.push({ ref, collection: 'unknowns', text: unknown.text });
  }

  for (const provided of result.evidence) {
    const url = provided.source_url?.trim();
    const source = url
      ? ({
          type: 'url' as const,
          url,
          retrieved_at: null,
          // The user cited it; Ideno has not read it.
          fetched_by_ideno: false,
        })
      : ({
          type: 'user' as const,
          description: provided.source_description?.trim() || 'cited by the user',
        });

    entries.push(
      entry(
        {
          op: 'add',
          collection: 'evidence',
          item: {
            text: provided.claim,
            epistemic_status: 'evidence_supported',
            claim: provided.claim,
            relevance: provided.relevance,
            source,
            ...(provided.excerpt ? { excerpt: provided.excerpt } : {}),
            ...(provided.source_quote ? { source_quote: provided.source_quote } : {}),
          },
        },
        provided.claim,
      ),
    );
  }

  const knownRefs = new Set(pendingAdditions.map((addition) => addition.ref));

  if (result.decision) {
    const alternativeId = keepResolvable(ideaCase, [result.decision.alternative_id ?? ''], knownRefs)[0];
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'decisions',
          item: {
            text: `${result.decision.question} → ${result.decision.chosen}`,
            epistemic_status: 'user_decision',
            question: result.decision.question,
            chosen: result.decision.chosen,
            ...(alternativeId ? { alternative_id: alternativeId } : {}),
            ...(result.decision.rationale ? { rationale: result.decision.rationale } : {}),
            ...(result.decision.source_quote ? { source_quote: result.decision.source_quote } : {}),
          },
        },
        `${result.decision.question} → ${result.decision.chosen}`,
        { items: alternativeId ? [alternativeId] : [] },
      ),
    );

    if (alternativeId) {
      entries.push(
        entry(
          {
            op: 'update',
            target_id: alternativeId,
            changes: { selected: true, epistemic_status: 'user_decision' },
            reason: `Chosen by you: ${result.decision.chosen}`,
          },
          `Marked ${alternativeId} as the selected approach`,
          { items: [alternativeId] },
        ),
      );
    }
  }

  for (const rejection of result.rejections) {
    const alternativeId = keepResolvable(ideaCase, [rejection.alternative_id ?? ''], knownRefs)[0];
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'rejected_approaches',
          item: {
            text: rejection.text,
            epistemic_status: 'user_decision',
            reason: rejection.reason,
            ...(alternativeId ? { alternative_id: alternativeId } : {}),
            ...(rejection.source_quote ? { source_quote: rejection.source_quote } : {}),
          },
        },
        `${rejection.text} — ${rejection.reason}`,
        { items: alternativeId ? [alternativeId] : [] },
      ),
    );

    if (alternativeId) {
      entries.push(
        entry(
          {
            op: 'update',
            target_id: alternativeId,
            changes: { status: 'rejected' },
            reason: rejection.reason,
          },
          `Rejected ${alternativeId}: ${rejection.reason}`,
          { items: [alternativeId] },
        ),
      );
    }
  }

  return { entries, pendingAdditions };
}

/** IMPACT → invalidations, links and newly relevant unknowns. */
export function translateImpact(
  result: ImpactResult,
  ideaCase: IdeaCase,
  pendingAdditions: readonly PendingAddition[],
): DraftEntry[] {
  const entries: DraftEntry[] = [];
  const refs = new Set(pendingAdditions.map((addition) => addition.ref));
  const areas = result.affected_areas;

  for (const impact of result.impacts) {
    const [cause] = keepResolvable(ideaCase, [impact.cause_ref], refs);
    const [target] = keepResolvable(ideaCase, [impact.item_id], refs);
    if (!target) continue;

    if (impact.effect === 'invalidates') {
      entries.push(
        entry(
          { op: 'invalidate', target_id: target, reason: impact.reason },
          impact.reason,
          { areas, items: [target, ...(cause ? [cause] : [])] },
        ),
      );
    } else {
      entries.push(
        entry(
          {
            op: 'update',
            target_id: target,
            changes: { rationale: impact.reason },
            reason: impact.reason,
          },
          impact.reason,
          { areas, items: [target, ...(cause ? [cause] : [])] },
        ),
      );
    }

    if (cause) {
      const relationType =
        impact.effect === 'reinforces' ? 'supports' : impact.effect === 'weakens' ? 'affects' : 'contradicts';
      entries.push(
        entry(
          { op: 'relate', from: cause, to: target, type: relationType, note: impact.reason },
          `${cause} ${relationType} ${target}`,
          { areas, items: [cause, target] },
        ),
      );
    }
  }

  for (const unknown of result.newly_relevant_unknowns) {
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'unknowns',
          item: { ...baseFields(unknown), ...openFields(unknown) },
        },
        unknown.text,
        { areas: unknown.blocks ?? areas },
      ),
    );
  }

  return entries;
}

const CRITIQUE_TARGET: Record<string, CollectionName | null> = {
  open_question: 'open_questions',
  unknown: 'unknowns',
  requirement: 'requirements',
  assumption: 'assumptions',
  none: null,
};

const SEVERITY_IMPACT: Record<'low' | 'medium' | 'high', number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.85,
};

/** CRITIQUE → open questions, unknowns, missing requirements, research items. */
export function translateCritique(result: CritiqueResult, ideaCase: IdeaCase): DraftEntry[] {
  const entries: DraftEntry[] = [];
  const noRefs = new Set<string>();
  const refs = new RefAllocator('c');

  for (const finding of result.findings) {
    const related = keepResolvable(ideaCase, finding.related_item_ids, noRefs);
    const collection = CRITIQUE_TARGET[finding.record_as] ?? null;
    const tag = finding.kind.replace(/_/gu, '-');

    if (collection) {
      const impact = finding.impact ?? SEVERITY_IMPACT[finding.severity];
      const ref = refs.next();
      const operation: StateOperation =
        collection === 'unknowns' || collection === 'open_questions'
          ? {
              op: 'add',
              collection,
              ref,
              item: {
                text: finding.text,
                // A critique is an argument Ideno is making, never a fact.
                epistemic_status: 'model_suggestion',
                tags: [tag],
                impact,
                blocks: [],
              },
            }
          : {
              op: 'add',
              collection: collection as 'requirements' | 'assumptions',
              ref,
              item: {
                text: finding.text,
                epistemic_status: 'model_suggestion',
                tags: [tag],
              },
            };

      entries.push(entry(operation, finding.text, { items: related }));

      // Link the finding to the items it is about, so the state records *why*
      // a requirement appeared rather than leaving it floating.
      const relationType = finding.kind === 'contradiction' ? 'contradicts' : 'affects';
      for (const relatedId of related) {
        entries.push(
          entry(
            { op: 'relate', from: `@${ref}`, to: relatedId, type: relationType, note: finding.text },
            `${finding.kind.replace(/_/gu, ' ')} involving ${relatedId}`,
            { items: [relatedId] },
          ),
        );
      }
    }

    if (finding.research_question) {
      entries.push(
        entry(
          {
            op: 'add',
            collection: 'research_items',
            item: {
              text: finding.research_question,
              epistemic_status: 'unknown',
              question: finding.research_question,
              why_it_matters: finding.text,
              tags: [tag],
            },
          },
          finding.research_question,
          { items: related },
        ),
      );
    }
  }

  return entries;
}

/** EXPLORE → alternatives and research items. */
export function translateExplore(result: ExploreResult, ideaCase: IdeaCase): DraftEntry[] {
  const entries: DraftEntry[] = [];
  const noRefs = new Set<string>();

  for (const alternative of result.alternatives) {
    const satisfies = keepResolvable(ideaCase, alternative.satisfies_constraint_ids, noRefs);
    const violates = keepResolvable(ideaCase, alternative.violates_constraint_ids, noRefs);
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'alternatives',
          item: {
            text: alternative.summary,
            epistemic_status: 'model_suggestion',
            ...(alternative.confidence === undefined || alternative.confidence === null
              ? {}
              : { confidence: alternative.confidence }),
            summary: alternative.summary,
            approach: alternative.approach,
            pros: alternative.pros,
            cons: alternative.cons,
            tradeoffs: alternative.tradeoffs,
            preconditions: alternative.preconditions,
            satisfies_constraints: satisfies,
            violates_constraints: violates,
          },
        },
        alternative.summary,
        { items: [...satisfies, ...violates] },
      ),
    );
  }

  for (const possibility of result.adjacent_possibilities) {
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'open_questions',
          item: {
            text: possibility,
            epistemic_status: 'model_suggestion',
            tags: ['adjacent-possibility'],
            impact: 0.35,
            blocks: [],
          },
        },
        possibility,
      ),
    );
  }

  for (const question of result.research_questions) {
    entries.push(
      entry(
        {
          op: 'add',
          collection: 'research_items',
          item: {
            text: question,
            epistemic_status: 'unknown',
            question,
          },
        },
        question,
      ),
    );
  }

  return entries;
}
