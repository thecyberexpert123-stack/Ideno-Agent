/**
 * The change contract: what a reasoning operation may propose, and the record
 * Ideno keeps of every proposed change.
 *
 * Two hard rules are encoded in these schemas:
 *
 * 1. Models never mint identifiers, timestamps, provenance-of-decision, or
 *    `origin_operation`. Those are Core's to assign, which is what stops a
 *    malformed or hallucinated model response from corrupting the Idea State.
 * 2. Evidence provenance is derived from its origin. A model cannot label its
 *    own recall as `evidence_supported` — the field simply is not in its
 *    output contract.
 */
import { z } from 'zod';

import {
  AffectedSchema,
  ConfidenceSchema,
  IdSchema,
  ImpactSchema,
  ModelClaimableProvenanceSchema,
  OriginOperationSchema,
  ProvenanceSchema,
  ShortTextSchema,
  TextSchema,
  TimestampSchema,
} from './common.js';
import { formatZodIssuesInline } from './format.js';
import {
  AlternativeSchema,
  AlternativeStatusSchema,
  AssumptionSchema,
  AssumptionStatusSchema,
  ConstraintSchema,
  ConstraintStatusSchema,
  DecisionSchema,
  DecisionStatusSchema,
  EvidenceSchema,
  EvidenceStatusSchema,
  FindingSchema,
  FindingStatusSchema,
  OpenQuestionSchema,
  OpenQuestionStatusSchema,
  RejectedApproachSchema,
  RequirementSchema,
  RequirementStatusSchema,
  ResearchItemSchema,
  ResearchItemStatusSchema,
  UnknownSchema,
  UnknownStatusSchema,
} from './idea_state.js';

// ---------------------------------------------------------------------------
// Drafts (model-proposed items)
// ---------------------------------------------------------------------------

/** Fields Core assigns for items built on `BaseItemSchema`. */
const CORE_ASSIGNED = {
  id: true,
  created_at: true,
  updated_at: true,
  origin_operation: true,
  source_message_id: true,
} as const;

/** Same idea for records that carry no `updated_at`. */
const CORE_ASSIGNED_SIMPLE = {
  id: true,
  created_at: true,
  origin_operation: true,
  source_message_id: true,
} as const;

const DraftProvenance = ModelClaimableProvenanceSchema.default('model_inferred');

export const RequirementDraftSchema = RequirementSchema.omit(CORE_ASSIGNED).extend({
  provenance: DraftProvenance,
  kind: z.enum(['explicit', 'implied', 'non_functional']).default('implied'),
  affects: AffectedSchema.optional(),
});
export type RequirementDraft = z.infer<typeof RequirementDraftSchema>;

export const AssumptionDraftSchema = AssumptionSchema.omit(CORE_ASSIGNED).extend({
  provenance: DraftProvenance,
  affects: AffectedSchema.optional(),
});
export type AssumptionDraft = z.infer<typeof AssumptionDraftSchema>;

export const ConstraintDraftSchema = ConstraintSchema.omit(CORE_ASSIGNED).extend({
  provenance: DraftProvenance,
  affects: AffectedSchema.optional(),
});
export type ConstraintDraft = z.infer<typeof ConstraintDraftSchema>;

export const UnknownDraftSchema = UnknownSchema.omit(CORE_ASSIGNED).extend({
  provenance: ModelClaimableProvenanceSchema.default('unknown'),
  affects: AffectedSchema.optional(),
});
export type UnknownDraft = z.infer<typeof UnknownDraftSchema>;

export const FindingDraftSchema = FindingSchema.omit(CORE_ASSIGNED).extend({
  provenance: DraftProvenance,
  affects: AffectedSchema.optional(),
});
export type FindingDraft = z.infer<typeof FindingDraftSchema>;

export const AlternativeDraftSchema = AlternativeSchema.omit(CORE_ASSIGNED).extend({
  provenance: DraftProvenance,
  affects: AffectedSchema.optional(),
});
export type AlternativeDraft = z.infer<typeof AlternativeDraftSchema>;

/**
 * Evidence as a model may propose it. `provenance` and `status` are absent on
 * purpose: Core derives provenance from `origin`, so "supported by evidence"
 * can only ever mean a real source was named by the user or returned by a
 * registered research source.
 */
export const EvidenceDraftSchema = EvidenceSchema.omit({
  id: true,
  timestamp: true,
  provenance: true,
  status: true,
  origin_operation: true,
  source_message_id: true,
}).extend({
  /** Lets another draft in the same change set cite this evidence. */
  temp_id: z.string().min(1).max(40).optional(),
  affects: AffectedSchema.optional(),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraftSchema>;

export const ResearchItemDraftSchema = ResearchItemSchema.omit({
  ...CORE_ASSIGNED,
  evidence_refs: true,
  status: true,
}).extend({
  affects: AffectedSchema.optional(),
});
export type ResearchItemDraft = z.infer<typeof ResearchItemDraftSchema>;

/**
 * A decision draft cannot claim `user_decision` provenance either — Core sets
 * that from `decided_by`, which is only `user` when the human made the choice.
 */
export const DecisionDraftSchema = DecisionSchema.omit({
  ...CORE_ASSIGNED,
  provenance: true,
}).extend({
  affects: AffectedSchema.optional(),
});
export type DecisionDraft = z.infer<typeof DecisionDraftSchema>;

export const RejectedApproachDraftSchema = RejectedApproachSchema.omit(CORE_ASSIGNED_SIMPLE).extend({
  affects: AffectedSchema.optional(),
});
export type RejectedApproachDraft = z.infer<typeof RejectedApproachDraftSchema>;

export const OpenQuestionDraftSchema = OpenQuestionSchema.omit({
  ...CORE_ASSIGNED_SIMPLE,
  status: true,
  asked_at: true,
}).extend({
  affects: AffectedSchema.optional(),
});
export type OpenQuestionDraft = z.infer<typeof OpenQuestionDraftSchema>;

// ---------------------------------------------------------------------------
// Updates to existing items
// ---------------------------------------------------------------------------

/** Every legal item status across collections, used for cross-collection edits. */
export const AnyItemStatusSchema = z.enum(
  Array.from(
    new Set<string>([
      ...RequirementStatusSchema.options,
      ...AssumptionStatusSchema.options,
      ...ConstraintStatusSchema.options,
      ...UnknownStatusSchema.options,
      ...ResearchItemStatusSchema.options,
      ...DecisionStatusSchema.options,
      ...OpenQuestionStatusSchema.options,
      ...FindingStatusSchema.options,
      ...AlternativeStatusSchema.options,
      ...EvidenceStatusSchema.options,
    ]),
  ) as [string, ...string[]],
);
export type AnyItemStatus = z.infer<typeof AnyItemStatusSchema>;

export const ItemUpdateSchema = z.object({
  id: IdSchema,
  text: TextSchema.optional(),
  status: AnyItemStatusSchema.optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  /** Only applied to collections that carry the field; ignored otherwise. */
  confidence: ConfidenceSchema.optional(),
  impact: ImpactSchema.optional(),
  priority: ImpactSchema.optional(),
  resolution: z.string().trim().max(1000).nullable().optional(),
  affects: AffectedSchema.optional(),
});
export type ItemUpdate = z.infer<typeof ItemUpdateSchema>;

/**
 * Explicit "this new information invalidates that" signal. This is what lets
 * Ideno revisit earlier stages instead of treating a correction as small talk.
 */
export const ItemInvalidationSchema = z.object({
  id: IdSchema,
  reason: ShortTextSchema,
  /** Defaults to the collection's terminal status when omitted. */
  new_status: AnyItemStatusSchema.optional(),
  affects: AffectedSchema.optional(),
});
export type ItemInvalidation = z.infer<typeof ItemInvalidationSchema>;

// ---------------------------------------------------------------------------
// Change set
// ---------------------------------------------------------------------------

/**
 * One bounded, validated unit of proposed change. Arrays are capped so a single
 * model response cannot balloon the state (or the review queue) beyond what a
 * human can actually read.
 */
export const ChangeSetSchema = z.object({
  title: ShortTextSchema.optional(),
  current_intent: TextSchema.optional(),
  requirements_added: z.array(RequirementDraftSchema).max(12).optional(),
  assumptions_added: z.array(AssumptionDraftSchema).max(12).optional(),
  constraints_added: z.array(ConstraintDraftSchema).max(12).optional(),
  unknowns_added: z.array(UnknownDraftSchema).max(12).optional(),
  evidence_added: z.array(EvidenceDraftSchema).max(8).optional(),
  research_items_added: z.array(ResearchItemDraftSchema).max(8).optional(),
  alternatives_added: z.array(AlternativeDraftSchema).max(6).optional(),
  decisions_added: z.array(DecisionDraftSchema).max(6).optional(),
  rejected_approaches_added: z.array(RejectedApproachDraftSchema).max(6).optional(),
  open_questions_added: z.array(OpenQuestionDraftSchema).max(6).optional(),
  findings_added: z.array(FindingDraftSchema).max(8).optional(),
  items_updated: z.array(ItemUpdateSchema).max(16).optional(),
  items_invalidated: z.array(ItemInvalidationSchema).max(16).optional(),
  selected_alternative_id: IdSchema.nullable().optional(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

/**
 * Input type: what a caller may hand in before defaults are filled. Producers of
 * change sets (the orchestrator, the user-action helpers) use this so they are
 * not forced to spell out every default.
 */
export type ChangeSetInput = z.input<typeof ChangeSetSchema>;

export const CHANGE_SET_KEYS = Object.keys(ChangeSetSchema.shape) as (keyof ChangeSet)[];

/** True when a validated change set would not alter the Idea State at all. */
export function isEmptyChangeSet(changes: ChangeSet): boolean {
  if (changes.title !== undefined || changes.current_intent !== undefined) return false;
  if (changes.selected_alternative_id !== undefined) return false;
  for (const key of CHANGE_SET_KEYS) {
    const value = changes[key];
    if (Array.isArray(value) && value.length > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Turn plan — the single structured output contract for every operation
// ---------------------------------------------------------------------------

export const OperationSchema = z.enum([
  'understand',
  'update',
  'critique',
  'explore',
  'research',
  'decision',
]);
export type Operation = z.infer<typeof OperationSchema>;

export const TurnClassificationSchema = z.enum([
  'new_idea',
  'new_information',
  'revision',
  'decision',
  'request_alternatives',
  'request_critique',
  'question',
  'out_of_scope',
]);
export type TurnClassification = z.infer<typeof TurnClassificationSchema>;

/**
 * Ideno asks at most one question per turn, and only when the missing
 * information materially changes the design. `impact` is what the orchestrator
 * uses to suppress low-value interrogation.
 */
export const QuestionSchema = z.object({
  text: ShortTextSchema,
  why_it_matters: ShortTextSchema,
  impact: ImpactSchema,
  /** The Unknown this question resolves, when there is one. */
  unknown_id: IdSchema.nullable().default(null),
});
export type Question = z.infer<typeof QuestionSchema>;

export const TurnPlanSchema = z.object({
  operation: OperationSchema,
  classification: TurnClassificationSchema,
  /**
   * A concise, shareable summary of the reasoning. Explicitly not a
   * chain-of-thought transcript: it is stored, shown to the user on request,
   * and kept short enough to audit.
   */
  reasoning_summary: z.string().trim().max(800),
  /** The message the human sees. */
  user_message: z.string().trim().min(1).max(6000),
  changes: ChangeSetSchema,
  question: QuestionSchema.nullable().default(null),
  /** Additional stages to run this turn, against the *updated* state. */
  followups: z.array(z.enum(['critique', 'explore', 'research'])).max(2).default([]),
});
export type TurnPlan = z.infer<typeof TurnPlanSchema>;

/**
 * What a model actually emits: the same contract, before defaults are filled.
 * Producers of plans (the demo script, tests, fixtures) use this type so they are
 * not forced to spell out every field the schema defaults.
 */
export type TurnPlanInput = z.input<typeof TurnPlanSchema>;

// ---------------------------------------------------------------------------
// Change records (Core-side audit + review queue)
// ---------------------------------------------------------------------------

export const ChangeKindSchema = z.enum([
  'title_revised',
  'intent_revised',
  'requirement_added',
  'assumption_added',
  'constraint_added',
  'unknown_added',
  'evidence_added',
  'research_item_added',
  'alternative_added',
  'decision_added',
  'rejected_approach_added',
  'open_question_added',
  'finding_added',
  'item_updated',
  'item_invalidated',
  'alternative_selected',
]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  title_revised: 'Title revised',
  intent_revised: 'Goal restated',
  requirement_added: 'Requirement added',
  assumption_added: 'Assumption added',
  constraint_added: 'Constraint added',
  unknown_added: 'Unknown added',
  evidence_added: 'Evidence added',
  research_item_added: 'Research question added',
  alternative_added: 'Alternative added',
  decision_added: 'Decision recorded',
  rejected_approach_added: 'Approach rejected',
  open_question_added: 'Open question added',
  finding_added: 'Critique finding',
  item_updated: 'Item updated',
  item_invalidated: 'Item invalidated',
  alternative_selected: 'Alternative selected',
};

export const ChangeStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'auto_accepted',
]);
export type ChangeStatus = z.infer<typeof ChangeStatusSchema>;

/**
 * The draft schema for each change kind.
 *
 * A plain union of draft schemas would be wrong here, and subtly so: an
 * untagged union tries members in order, and every item draft accepts `{text}`
 * with everything else defaulted — so a constraint would silently parse as a
 * requirement, losing `category` and `hard`. Validation must therefore be
 * dispatched on `kind`, which is exactly what this map is for.
 */
export const DRAFT_SCHEMA_FOR_KIND: Record<ChangeKind, z.ZodType<unknown>> = {
  title_revised: ShortTextSchema,
  intent_revised: TextSchema,
  requirement_added: RequirementDraftSchema,
  assumption_added: AssumptionDraftSchema,
  constraint_added: ConstraintDraftSchema,
  unknown_added: UnknownDraftSchema,
  evidence_added: EvidenceDraftSchema,
  research_item_added: ResearchItemDraftSchema,
  alternative_added: AlternativeDraftSchema,
  decision_added: DecisionDraftSchema,
  rejected_approach_added: RejectedApproachDraftSchema,
  open_question_added: OpenQuestionDraftSchema,
  finding_added: FindingDraftSchema,
  item_updated: ItemUpdateSchema,
  item_invalidated: ItemInvalidationSchema,
  alternative_selected: IdSchema.nullable(),
};

/**
 * Every proposed change becomes one of these. Pending ones are the review
 * queue; resolved ones are the audit trail behind a version.
 *
 * `draft` is `unknown` at the type level and validated against
 * `DRAFT_SCHEMA_FOR_KIND[kind]` by the refinement below. Readers may therefore
 * narrow it by kind without re-checking: a `ChangeRecord` that exists has
 * already passed.
 */
export const ChangeRecordSchema = z
  .object({
  id: IdSchema,
  kind: ChangeKindSchema,
  /** The validated draft, exactly as it will be applied. */
  draft: z.unknown(),
  affects: AffectedSchema,
  /** Why this change follows from what the user said. Shown in the review card. */
  rationale: z.string().trim().max(800).default(''),
  /**
   * Full provenance, because Core — not the model — marks a change the human
   * made as `user_decision`. Drafts still cannot claim it.
   */
  provenance: ProvenanceSchema.default('model_inferred'),
  origin_operation: OriginOperationSchema.default('update'),
  message_id: IdSchema.nullable().default(null),
  status: ChangeStatusSchema.default('pending'),
  created_at: TimestampSchema,
  resolved_at: TimestampSchema.nullable().default(null),
  /** Item id created or modified when the change was applied. */
  resolved_item_id: IdSchema.nullable().default(null),
  rejection_reason: z.string().trim().max(400).nullable().default(null),
  /** Version created by applying this change, once applied. */
  version_id: IdSchema.nullable().default(null),
  /** Set when Core had to weaken a claim, e.g. unresolved evidence references. */
  integrity_note: z.string().trim().max(400).nullable().default(null),
  })
  .superRefine((record, ctx) => {
    const schema = DRAFT_SCHEMA_FOR_KIND[record.kind];
    if (!schema) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `No draft contract is defined for change kind "${record.kind}".`,
      });
      return;
    }
    const result = schema.safeParse(record.draft);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['draft'],
        message: `Draft for "${record.kind}" is invalid: ${formatZodIssuesInline(result.error, 3)}`,
      });
    }
  });
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;
