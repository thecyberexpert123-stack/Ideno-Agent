import { z } from 'zod';

/**
 * Canonical schema for the Ideno Idea State.
 *
 * This module is the single source of truth for what an idea *is* inside
 * Ideno. Everything else — the orchestrator, the reasoning stages, the HTTP
 * API, the UI, and any future renderer plugin — is defined in terms of these
 * types. Model output is never trusted: it is parsed through the proposal
 * schemas at the bottom of this file before it can touch persisted state.
 */

/** Bumped whenever a persisted case can no longer be read by the old reader. */
export const SCHEMA_VERSION = 1;

const IsoDateTime = z.iso.datetime();
const NonEmptyText = z.string().trim().min(1).max(2000);
const ShortText = z.string().trim().min(1).max(300);
const OptionalText = z.string().trim().max(2000).optional();

/* ------------------------------------------------------------------------ */
/* Epistemic bookkeeping                                                     */
/* ------------------------------------------------------------------------ */

/**
 * How much we actually know about a statement. Ideno's central promise is that
 * these are never conflated: a model's guess must not be displayed, exported,
 * or reasoned about as if it were a fact the user stated or a claim backed by
 * a source.
 */
export const EpistemicStatusSchema = z.enum([
  /** Stated by the user, or directly entailed by something they stated. */
  'known',
  /** A working assumption Ideno is carrying. Plausible, unverified. */
  'assumed',
  /** Explicitly not known. Named so it can be closed later. */
  'unknown',
  /** Backed by at least one evidence record with a real source. */
  'evidence_supported',
  /** Produced by the model. Unverified, not attributable to the user. */
  'model_suggestion',
  /** Chosen by the human. Authoritative by definition. */
  'user_decision',
]);
export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

/** Who introduced an item. Distinct from epistemic status on purpose. */
export const OriginSchema = z.enum(['user', 'model', 'research', 'system']);
export type Origin = z.infer<typeof OriginSchema>;

/** Lifecycle of an item inside the state, independent of how true it is. */
export const ItemStatusSchema = z.enum([
  'active',
  /** Replaced by a newer item; kept for history. */
  'superseded',
  /** Still present, but something later proved it wrong or inapplicable. */
  'invalidated',
  /** The user explicitly turned it down. */
  'rejected',
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const CollectionNameSchema = z.enum([
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
]);
export type CollectionName = z.infer<typeof CollectionNameSchema>;

/* ------------------------------------------------------------------------ */
/* Items                                                                     */
/* ------------------------------------------------------------------------ */

const BaseItemShape = {
  id: z.string().min(1),
  text: NonEmptyText,
  epistemic_status: EpistemicStatusSchema,
  origin: OriginSchema,
  status: ItemStatusSchema.default('active'),
  /** Model-reported confidence in [0,1]. Absent when nobody can honestly say. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** Short justification. Never chain-of-thought — a conclusion, not a trace. */
  rationale: OptionalText,
  tags: z.array(ShortText).max(12).default([]),
  /** Evidence ids supporting this item. Required for `evidence_supported`. */
  supported_by: z.array(z.string()).default([]),
  /**
   * Verbatim span of the user's message this item was derived from. The patch
   * applier verifies the quote really occurs in the turn before it will let an
   * item claim `known`/`user_decision`.
   */
  source_quote: z.string().trim().max(600).nullable().default(null),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  created_in_version: z.number().int().min(0),
  /** Why this item left `active`. */
  status_reason: OptionalText,
};

export const IdeaItemSchema = z.object(BaseItemShape);
export type IdeaItem = z.infer<typeof IdeaItemSchema>;

/** An unknown/open question also carries how much resolving it would matter. */
export const OpenItemSchema = z.object({
  ...BaseItemShape,
  /** 0..1 — how much the current design hinges on resolving this. */
  impact: z.number().min(0).max(1).default(0.5),
  /** Which parts of the design this blocks. Free-form area labels. */
  blocks: z.array(ShortText).max(12).default([]),
});
export type OpenItem = z.infer<typeof OpenItemSchema>;

export const EvidenceSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    url: z.url().max(2000),
    title: z.string().trim().max(300).optional(),
    /**
     * When Ideno actually retrieved the page. Null for a URL the user cited
     * without Ideno reading it — conflating the two would let an unread link
     * masquerade as a checked source.
     */
    retrieved_at: IsoDateTime.nullable().default(null),
    /** True only when the research plugin fetched and read this URL. */
    fetched_by_ideno: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('user'),
    /** What the user said they were citing, e.g. "datasheet on my desk". */
    description: ShortText,
  }),
  z.object({
    type: z.literal('document'),
    name: ShortText,
    location: z.string().trim().max(500).optional(),
  }),
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/**
 * A claim that is actually attributable to something outside the model.
 *
 * There is deliberately no `type: 'model'` source. A model assertion without a
 * source is not evidence; it is a research question, and Ideno records it as
 * one.
 */
export const EvidenceSchema = z.object({
  ...BaseItemShape,
  claim: NonEmptyText,
  source: EvidenceSourceSchema,
  /** Why this claim matters to *this* idea. */
  relevance: NonEmptyText,
  /** Verbatim supporting text from the source, when available. */
  excerpt: z.string().trim().max(4000).nullable().default(null),
  /** The research item this evidence answered, when it came from one. */
  research_item_id: z.string().nullable().default(null),
  timestamp: IsoDateTime,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ResearchItemSchema = z.object({
  ...BaseItemShape,
  question: NonEmptyText,
  research_status: z.enum(['open', 'in_progress', 'answered', 'failed']).default('open'),
  /** Why answering this changes the design. */
  why_it_matters: OptionalText,
  evidence_ids: z.array(z.string()).default([]),
  /** Populated when `research_status === 'failed'`. */
  error: z.string().trim().max(1000).nullable().default(null),
  last_attempt_at: IsoDateTime.nullable().default(null),
});
export type ResearchItem = z.infer<typeof ResearchItemSchema>;

export const AlternativeSchema = z.object({
  ...BaseItemShape,
  summary: NonEmptyText,
  approach: NonEmptyText,
  pros: z.array(ShortText).max(10).default([]),
  cons: z.array(ShortText).max(10).default([]),
  tradeoffs: z.array(ShortText).max(10).default([]),
  /** What must be true for this approach to be viable at all. */
  preconditions: z.array(ShortText).max(10).default([]),
  /** Constraint ids this approach is known to satisfy / violate. */
  satisfies_constraints: z.array(z.string()).default([]),
  violates_constraints: z.array(z.string()).default([]),
  selected: z.boolean().default(false),
});
export type Alternative = z.infer<typeof AlternativeSchema>;

export const DecisionSchema = z.object({
  ...BaseItemShape,
  question: NonEmptyText,
  chosen: NonEmptyText,
  alternative_id: z.string().nullable().default(null),
  /** 'user' for real decisions. 'system' only for bookkeeping consequences. */
  decided_by: z.enum(['user', 'system']).default('user'),
  decided_at: IsoDateTime,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RejectedApproachSchema = z.object({
  ...BaseItemShape,
  reason: NonEmptyText,
  alternative_id: z.string().nullable().default(null),
  rejected_at: IsoDateTime,
});
export type RejectedApproach = z.infer<typeof RejectedApproachSchema>;

/* ------------------------------------------------------------------------ */
/* Relations                                                                 */
/* ------------------------------------------------------------------------ */

export const RelationTypeSchema = z.enum([
  'supports',
  'contradicts',
  'depends_on',
  'addresses',
  'supersedes',
  'affects',
]);
export type RelationType = z.infer<typeof RelationTypeSchema>;

/**
 * A typed edge between two items. Relations are what let Ideno answer "what
 * does this new constraint invalidate?" without re-reading the conversation.
 */
export const RelationSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: RelationTypeSchema,
  note: OptionalText,
  created_at: IsoDateTime,
  created_in_version: z.number().int().min(0),
});
export type Relation = z.infer<typeof RelationSchema>;

/* ------------------------------------------------------------------------ */
/* Case-level state                                                          */
/* ------------------------------------------------------------------------ */

export const IdeaPhaseSchema = z.enum(['capturing', 'exploring', 'converging', 'decided']);
export type IdeaPhase = z.infer<typeof IdeaPhaseSchema>;

export const CurrentStateSchema = z.object({
  phase: IdeaPhaseSchema.default('capturing'),
  /** One-paragraph description of where the idea currently stands. */
  summary: z.string().trim().max(4000).default(''),
});
export type CurrentState = z.infer<typeof CurrentStateSchema>;

export const ConversationTurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'ideno', 'system']),
  text: z.string().max(20_000),
  created_at: IsoDateTime,
  /** Changeset this turn produced, if any. */
  changeset_id: z.string().nullable().default(null),
  /** True when the turn completed with one or more reasoning stages failing. */
  degraded: z.boolean().default(false),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

/* ------------------------------------------------------------------------ */
/* Operations — the only way state ever changes                              */
/* ------------------------------------------------------------------------ */

/**
 * A proposal-local alias (`"a1"`) that later operations in the same changeset
 * reference as `"@a1"`. The model cannot know the ids the applier will mint,
 * so this is how it expresses "relate the constraint I am adding to the
 * assumption I am also adding". Unresolvable references are skipped, never
 * guessed.
 */
export const LocalRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/u);

/** Either an existing item id or a `@ref` to an item added in this changeset. */
const ItemReference = z.string().min(1).max(64);

/**
 * Fields a proposal may set on a new item. Identity, timestamps and version
 * bookkeeping are assigned by the applier, never by the model.
 */
const NewItemCommon = {
  text: NonEmptyText,
  epistemic_status: EpistemicStatusSchema,
  confidence: z.number().min(0).max(1).nullable().optional(),
  rationale: OptionalText,
  tags: z.array(ShortText).max(12).optional(),
  supported_by: z.array(ItemReference).optional(),
  source_quote: z.string().trim().max(600).nullable().optional(),
};

function addOperation<C extends CollectionName, S extends z.ZodRawShape>(
  collection: C,
  itemShape: S,
) {
  return z.object({
    op: z.literal('add'),
    collection: z.literal(collection),
    ref: LocalRefSchema.optional(),
    item: z.object(itemShape),
  });
}

const OpenItemShape = {
  ...NewItemCommon,
  impact: z.number().min(0).max(1).optional(),
  blocks: z.array(ShortText).max(12).optional(),
};

export const AddOperationSchema = z.discriminatedUnion('collection', [
  addOperation('requirements', NewItemCommon),
  addOperation('assumptions', NewItemCommon),
  addOperation('constraints', NewItemCommon),
  addOperation('unknowns', OpenItemShape),
  addOperation('open_questions', OpenItemShape),
  addOperation('evidence', {
    ...NewItemCommon,
    claim: NonEmptyText,
    source: EvidenceSourceSchema,
    relevance: NonEmptyText,
    excerpt: z.string().trim().max(4000).nullable().optional(),
    research_item_id: ItemReference.nullable().optional(),
  }),
  addOperation('research_items', {
    ...NewItemCommon,
    question: NonEmptyText,
    why_it_matters: OptionalText,
  }),
  addOperation('alternatives', {
    ...NewItemCommon,
    summary: NonEmptyText,
    approach: NonEmptyText,
    pros: z.array(ShortText).max(10).optional(),
    cons: z.array(ShortText).max(10).optional(),
    tradeoffs: z.array(ShortText).max(10).optional(),
    preconditions: z.array(ShortText).max(10).optional(),
    satisfies_constraints: z.array(ItemReference).optional(),
    violates_constraints: z.array(ItemReference).optional(),
  }),
  addOperation('decisions', {
    ...NewItemCommon,
    question: NonEmptyText,
    chosen: NonEmptyText,
    alternative_id: ItemReference.nullable().optional(),
  }),
  addOperation('rejected_approaches', {
    ...NewItemCommon,
    reason: NonEmptyText,
    alternative_id: ItemReference.nullable().optional(),
  }),
]);
export type AddOperation = z.infer<typeof AddOperationSchema>;

export const UpdateOperationSchema = z.object({
  op: z.literal('update'),
  target_id: ItemReference,
  changes: z
    .object({
      text: NonEmptyText.optional(),
      epistemic_status: EpistemicStatusSchema.optional(),
      status: ItemStatusSchema.optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      rationale: OptionalText,
      impact: z.number().min(0).max(1).optional(),
      tags: z.array(ShortText).max(12).optional(),
      research_status: z.enum(['open', 'in_progress', 'answered', 'failed']).optional(),
      selected: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, {
      message: 'update operation must change at least one field',
    }),
  reason: NonEmptyText,
});
export type UpdateOperation = z.infer<typeof UpdateOperationSchema>;

export const InvalidateOperationSchema = z.object({
  op: z.literal('invalidate'),
  target_id: ItemReference,
  reason: NonEmptyText,
});
export type InvalidateOperation = z.infer<typeof InvalidateOperationSchema>;

export const RelateOperationSchema = z.object({
  op: z.literal('relate'),
  from: ItemReference,
  to: ItemReference,
  type: RelationTypeSchema,
  note: OptionalText,
});
export type RelateOperation = z.infer<typeof RelateOperationSchema>;

export const SetFieldOperationSchema = z.discriminatedUnion('field', [
  z.object({ op: z.literal('set_field'), field: z.literal('title'), value: ShortText }),
  z.object({ op: z.literal('set_field'), field: z.literal('current_intent'), value: NonEmptyText }),
  z.object({
    op: z.literal('set_field'),
    field: z.literal('current_state'),
    value: CurrentStateSchema,
  }),
]);
export type SetFieldOperation = z.infer<typeof SetFieldOperationSchema>;

/** The complete set of state transitions Ideno supports. */
export const StateOperationSchema = z.union([
  AddOperationSchema,
  UpdateOperationSchema,
  InvalidateOperationSchema,
  RelateOperationSchema,
  SetFieldOperationSchema,
]);
export type StateOperation = z.infer<typeof StateOperationSchema>;

/* ------------------------------------------------------------------------ */
/* Changesets — proposed, reviewable state transitions                       */
/* ------------------------------------------------------------------------ */

export const OperationReviewStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'skipped']);
export type OperationReviewStatus = z.infer<typeof OperationReviewStatusSchema>;

export const ChangeSetEntrySchema = z.object({
  id: z.string().min(1),
  operation: StateOperationSchema,
  /** Plain-language description of what this single operation does. */
  label: ShortText,
  /** Which parts of the design this operation touches. */
  affected_areas: z.array(ShortText).max(10).default([]),
  /** Ids of existing items this operation reacts to. */
  affected_item_ids: z.array(z.string()).default([]),
  status: OperationReviewStatusSchema.default('pending'),
  /** Set when the applier refused or altered the operation. */
  applier_note: z.string().trim().max(500).nullable().default(null),
  /** Id assigned to the item this operation created, once applied. */
  created_item_id: z.string().nullable().default(null),
});
export type ChangeSetEntry = z.infer<typeof ChangeSetEntrySchema>;

export const ChangeSetStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'partially_accepted',
]);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

export const ChangeSetSchema = z.object({
  id: z.string().min(1),
  case_id: z.string().min(1),
  turn_id: z.string().nullable().default(null),
  source: z.enum(['orchestrator', 'user', 'research']),
  status: ChangeSetStatusSchema.default('pending'),
  summary: ShortText,
  /**
   * A short conclusion-level summary of why these changes are proposed.
   * Deliberately not a reasoning trace: Ideno stores conclusions, not
   * hidden chain-of-thought.
   */
  reasoning_summary: z.string().trim().max(4000).default(''),
  entries: z.array(ChangeSetEntrySchema),
  created_at: IsoDateTime,
  resolved_at: IsoDateTime.nullable().default(null),
  /** Non-fatal problems encountered while producing this changeset. */
  warnings: z.array(z.string().max(500)).default([]),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/* ------------------------------------------------------------------------ */
/* Versions                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * A version is an applied, ordered batch of operations.
 *
 * Only operations are stored, never snapshots: replaying them from v0 yields
 * the state at any point, which keeps case files small and makes "what changed
 * between v2 and v3" a direct read rather than a computed diff.
 *
 * `parent_id` is already present so that branching can be added later without
 * a schema migration; v0.1 always writes a linear chain.
 */
export const VersionRecordSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().min(0),
  parent_id: z.string().nullable(),
  label: ShortText,
  summary: z.string().trim().max(2000).default(''),
  changeset_id: z.string().nullable().default(null),
  operations: z.array(StateOperationSchema).default([]),
  created_at: IsoDateTime,
});
export type VersionRecord = z.infer<typeof VersionRecordSchema>;

/* ------------------------------------------------------------------------ */
/* The Idea Case                                                             */
/* ------------------------------------------------------------------------ */

export const IdeaCaseSchema = z.object({
  schema_version: z.number().int().min(1),
  id: z.string().min(1),
  title: ShortText,
  /** The user's first description, preserved verbatim, never rewritten. */
  original_idea: z.string().trim().min(1).max(20_000),
  current_intent: z.string().trim().max(4000).default(''),

  requirements: z.array(IdeaItemSchema).default([]),
  assumptions: z.array(IdeaItemSchema).default([]),
  constraints: z.array(IdeaItemSchema).default([]),
  unknowns: z.array(OpenItemSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  research_items: z.array(ResearchItemSchema).default([]),
  alternatives: z.array(AlternativeSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  rejected_approaches: z.array(RejectedApproachSchema).default([]),
  open_questions: z.array(OpenItemSchema).default([]),

  relations: z.array(RelationSchema).default([]),
  current_state: CurrentStateSchema,
  version_history: z.array(VersionRecordSchema).default([]),

  changesets: z.array(ChangeSetSchema).default([]),
  conversation: z.array(ConversationTurnSchema).default([]),

  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type IdeaCase = z.infer<typeof IdeaCaseSchema>;

/** Union of every item shape that can live in a state collection. */
export type AnyIdeaItem =
  | IdeaItem
  | OpenItem
  | Evidence
  | ResearchItem
  | Alternative
  | Decision
  | RejectedApproach;

/** Maps a collection name to the item type it holds. */
export const COLLECTION_ITEM_SCHEMAS = {
  requirements: IdeaItemSchema,
  assumptions: IdeaItemSchema,
  constraints: IdeaItemSchema,
  unknowns: OpenItemSchema,
  evidence: EvidenceSchema,
  research_items: ResearchItemSchema,
  alternatives: AlternativeSchema,
  decisions: DecisionSchema,
  rejected_approaches: RejectedApproachSchema,
  open_questions: OpenItemSchema,
} as const satisfies Record<CollectionName, z.ZodTypeAny>;

export const ALL_COLLECTIONS: readonly CollectionName[] = CollectionNameSchema.options;
