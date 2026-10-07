/**
 * The canonical Idea State.
 *
 * This file is the source of truth for what an Ideno idea *is*. Every layer —
 * persistence, model-output validation, diffing and the UI — derives its types
 * from these schemas, so there is exactly one definition of a Constraint or an
 * Evidence record in the codebase.
 *
 * Design rules enforced here:
 *  - Identifiers and timestamps are minted by Ideno Core, never by a model.
 *  - Every item carries a `provenance`, so a fact stated by the human is never
 *    visually or logically interchangeable with a model guess.
 *  - Nothing is deleted: items move to a terminal status (`dropped`,
 *    `invalidated`, `rejected`, ...) so history stays explainable.
 */
import { z } from 'zod';

import {
  ConfidenceSchema,
  IdSchema,
  ImpactSchema,
  OriginOperationSchema,
  ProvenanceSchema,
  ShortTextSchema,
  TextSchema,
  TimestampSchema,
} from './common.js';
import { BranchSchema, MAX_BRANCHES } from './branches.js';

// ---------------------------------------------------------------------------
// Shared item shape
// ---------------------------------------------------------------------------

export const BaseItemSchema = z.object({
  id: IdSchema,
  text: TextSchema,
  provenance: ProvenanceSchema,
  origin_operation: OriginOperationSchema,
  /** Transcript entry this item came from, when it came from a conversation. */
  source_message_id: IdSchema.nullable().default(null),
  /** Evidence records backing this item (required for `evidence_supported`). */
  evidence_refs: z.array(IdSchema).max(20).default([]),
  notes: z.string().trim().max(1000).nullable().default(null),
  created_at: TimestampSchema,
  updated_at: TimestampSchema.nullable().default(null),
});
export type BaseItem = z.infer<typeof BaseItemSchema>;

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export const RequirementStatusSchema = z.enum(['open', 'satisfied', 'conflicted', 'dropped']);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const RequirementSchema = BaseItemSchema.extend({
  status: RequirementStatusSchema.default('open'),
  priority: z.enum(['must', 'should', 'could']).default('should'),
  /** `explicit` = stated by the human, `implied` = follows from the goal. */
  kind: z.enum(['explicit', 'implied', 'non_functional']).default('explicit'),
});
export type Requirement = z.infer<typeof RequirementSchema>;

// ---------------------------------------------------------------------------
// Assumptions
// ---------------------------------------------------------------------------

export const AssumptionStatusSchema = z.enum(['active', 'confirmed', 'invalidated']);
export type AssumptionStatus = z.infer<typeof AssumptionStatusSchema>;

export const AssumptionSchema = BaseItemSchema.extend({
  status: AssumptionStatusSchema.default('active'),
  confidence: ConfidenceSchema.default(0.5),
  /** What breaks if this assumption turns out to be false. */
  if_false_impact: ImpactSchema.default('medium'),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export const ConstraintStatusSchema = z.enum(['active', 'relaxed', 'violated', 'dropped']);
export type ConstraintStatus = z.infer<typeof ConstraintStatusSchema>;

export const ConstraintCategorySchema = z.enum([
  'physical',
  'environmental',
  'power',
  'connectivity',
  'budget',
  'regulatory',
  'technical',
  'temporal',
  'skill',
  'other',
]);
export type ConstraintCategory = z.infer<typeof ConstraintCategorySchema>;

export const ConstraintSchema = BaseItemSchema.extend({
  status: ConstraintStatusSchema.default('active'),
  category: ConstraintCategorySchema.default('other'),
  /** Hard constraints cannot be traded away; soft ones can be negotiated. */
  hard: z.boolean().default(true),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

// ---------------------------------------------------------------------------
// Unknowns
// ---------------------------------------------------------------------------

export const UnknownStatusSchema = z.enum(['open', 'resolved', 'deferred']);
export type UnknownStatus = z.infer<typeof UnknownStatusSchema>;

export const UnknownSchema = BaseItemSchema.extend({
  status: UnknownStatusSchema.default('open'),
  impact: ImpactSchema.default('medium'),
  /** Design areas this unknown blocks, e.g. "Power architecture". */
  affected_areas: z.array(ShortTextSchema).max(8).default([]),
  resolution: z.string().trim().max(1000).nullable().default(null),
});
export type Unknown = z.infer<typeof UnknownSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Where an Evidence record came from. This is the anti-fabrication gate:
 * only `user_supplied` and `research_source` evidence may carry the
 * `evidence_supported` provenance. `model_recall` is the model's own memory of
 * the world and is always stored as a `model_suggestion`.
 */
export const EvidenceOriginSchema = z.enum(['user_supplied', 'research_source', 'model_recall']);
export type EvidenceOrigin = z.infer<typeof EvidenceOriginSchema>;

export const EvidenceStatusSchema = z.enum(['accepted', 'disputed', 'retracted']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceSourceSchema = z.object({
  title: ShortTextSchema,
  /** URL, DOI, file path, or a precise human-readable citation. */
  locator: ShortTextSchema,
  publisher: z.string().trim().max(160).nullable().default(null),
});
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  id: IdSchema,
  claim: TextSchema,
  source: EvidenceSourceSchema,
  relevance: TextSchema,
  confidence: ConfidenceSchema,
  /** When this evidence was recorded in the Idea State. */
  timestamp: TimestampSchema,
  origin: EvidenceOriginSchema,
  status: EvidenceStatusSchema.default('accepted'),
  provenance: ProvenanceSchema,
  origin_operation: OriginOperationSchema,
  source_message_id: IdSchema.nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ---------------------------------------------------------------------------
// Research items
// ---------------------------------------------------------------------------

export const ResearchItemStatusSchema = z.enum(['open', 'in_progress', 'answered', 'abandoned']);
export type ResearchItemStatus = z.infer<typeof ResearchItemStatusSchema>;

export const ResearchItemSchema = z.object({
  id: IdSchema,
  question: TextSchema,
  priority: ImpactSchema.default('medium'),
  status: ResearchItemStatusSchema.default('open'),
  /** Why answering this matters for the idea. */
  rationale: z.string().trim().max(600).nullable().default(null),
  evidence_refs: z.array(IdSchema).max(20).default([]),
  origin_operation: OriginOperationSchema,
  source_message_id: IdSchema.nullable().default(null),
  created_at: TimestampSchema,
  updated_at: TimestampSchema.nullable().default(null),
});
export type ResearchItem = z.infer<typeof ResearchItemSchema>;

// ---------------------------------------------------------------------------
// Alternatives and the renderer-independent component graph
// ---------------------------------------------------------------------------

/**
 * Optional structured geometry attached to an alternative.
 *
 * Dimensions are free strings with units ("40mm", "1.2 m") because that is what
 * a model or a human naturally writes. `src/render/canonical.ts` parses them
 * into a normalised, renderer-independent representation and reports anything
 * it cannot parse instead of silently dropping it.
 */
export const ComponentObjectSchema = z.object({
  name: ShortTextSchema,
  type: z.enum(['box', 'cylinder', 'sphere', 'tube', 'assembly', 'custom']).default('custom'),
  dimensions: z.record(z.string().max(40), z.string().trim().max(40)).default({}),
  properties: z
    .record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean()]))
    .default({}),
  material: z.string().trim().max(120).nullable().default(null),
});
export type ComponentObject = z.infer<typeof ComponentObjectSchema>;

export const ComponentConnectionSchema = z.object({
  from: ShortTextSchema,
  to: ShortTextSchema,
  kind: z.enum(['fluid', 'electrical', 'data', 'mechanical', 'thermal', 'other']).default('other'),
  label: z.string().trim().max(120).nullable().default(null),
});
export type ComponentConnection = z.infer<typeof ComponentConnectionSchema>;

export const ComponentConstraintSchema = z.object({
  key: ShortTextSchema,
  value: z.union([z.string().trim().max(200), z.number(), z.boolean()]),
});
export type ComponentConstraint = z.infer<typeof ComponentConstraintSchema>;

export const ComponentGraphSchema = z.object({
  objects: z.array(ComponentObjectSchema).max(40).default([]),
  connections: z.array(ComponentConnectionSchema).max(60).default([]),
  constraints: z.array(ComponentConstraintSchema).max(40).default([]),
});
export type ComponentGraph = z.infer<typeof ComponentGraphSchema>;

export const AlternativeStatusSchema = z.enum(['proposed', 'selected', 'rejected', 'parked']);
export type AlternativeStatus = z.infer<typeof AlternativeStatusSchema>;

export const AlternativeSchema = BaseItemSchema.extend({
  name: ShortTextSchema,
  summary: TextSchema,
  pros: z.array(ShortTextSchema).max(12).default([]),
  cons: z.array(ShortTextSchema).max(12).default([]),
  /** Requirement / constraint / unknown ids this alternative addresses. */
  addresses: z.array(IdSchema).max(20).default([]),
  status: AlternativeStatusSchema.default('proposed'),
  /** Structured geometry, when the alternative has a describable form. */
  spec: ComponentGraphSchema.nullable().default(null),
});
export type Alternative = z.infer<typeof AlternativeSchema>;

// ---------------------------------------------------------------------------
// Decisions and rejected approaches
// ---------------------------------------------------------------------------

export const DecisionStatusSchema = z.enum(['active', 'superseded', 'reversed']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = BaseItemSchema.extend({
  status: DecisionStatusSchema.default('active'),
  rationale: z.string().trim().max(1000).nullable().default(null),
  alternatives_considered: z.array(IdSchema).max(20).default([]),
  /** `user` = the human decided; `model_recommended` = Ideno proposed it. */
  decided_by: z.enum(['user', 'model_recommended']).default('model_recommended'),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RejectedApproachSchema = z.object({
  id: IdSchema,
  name: ShortTextSchema,
  reason: TextSchema,
  rejected_by: z.enum(['user', 'model']).default('model'),
  related_alternative_id: IdSchema.nullable().default(null),
  origin_operation: OriginOperationSchema,
  source_message_id: IdSchema.nullable().default(null),
  created_at: TimestampSchema,
});
export type RejectedApproach = z.infer<typeof RejectedApproachSchema>;

// ---------------------------------------------------------------------------
// Open questions and critique findings
// ---------------------------------------------------------------------------

export const OpenQuestionStatusSchema = z.enum(['unasked', 'asked', 'answered', 'withdrawn']);
export type OpenQuestionStatus = z.infer<typeof OpenQuestionStatusSchema>;

export const OpenQuestionSchema = z.object({
  id: IdSchema,
  question: TextSchema,
  /** `user` = ask the human, `research` = needs evidence, not opinion. */
  target: z.enum(['user', 'research']).default('user'),
  status: OpenQuestionStatusSchema.default('unasked'),
  impact: ImpactSchema.default('medium'),
  unknown_id: IdSchema.nullable().default(null),
  asked_at: TimestampSchema.nullable().default(null),
  origin_operation: OriginOperationSchema,
  source_message_id: IdSchema.nullable().default(null),
  created_at: TimestampSchema,
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

/**
 * Critique output that does not belong in any other collection: a contradiction
 * between two recorded items is not an assumption, a risk is not a requirement.
 * Findings give critique somewhere honest to live.
 */
export const FindingKindSchema = z.enum([
  'contradiction',
  'risk',
  'hidden_dependency',
  'limitation',
  'failure_point',
  'missing_requirement',
]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

export const FindingStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSchema = BaseItemSchema.extend({
  kind: FindingKindSchema,
  severity: z.enum(['critical', 'major', 'minor']).default('major'),
  related_ids: z.array(IdSchema).max(20).default([]),
  recommendation: z.string().trim().max(1000).nullable().default(null),
  status: FindingStatusSchema.default('open'),
});
export type Finding = z.infer<typeof FindingSchema>;

// ---------------------------------------------------------------------------
// IdeaCase
// ---------------------------------------------------------------------------

/**
 * Coarse lifecycle position of the idea. Derived deterministically from the
 * contents of the case by `deriveCurrentState()` — never asserted by a model —
 * so the badge in the UI always agrees with the data behind it.
 */
export const IdeaPhaseSchema = z.enum([
  'seed',
  'structuring',
  'exploring',
  'refining',
  'blocked',
  'decided',
]);
export type IdeaPhase = z.infer<typeof IdeaPhaseSchema>;

export const IDEA_PHASE_LABELS: Record<IdeaPhase, string> = {
  seed: 'Seed',
  structuring: 'Structuring',
  exploring: 'Exploring',
  refining: 'Refining',
  blocked: 'Blocked',
  decided: 'Decided',
};

/**
 * Every field of an idea except its own version history. Splitting this out
 * keeps the type graph acyclic: a version snapshots a body, and a case is a body
 * plus its history.
 */
export const IdeaCaseBodySchema = z.object({
  id: IdSchema,
  title: ShortTextSchema,
  /** The user's first, unedited words. Never rewritten. */
  original_idea: TextSchema,
  /** Ideno's current best formulation of what the user is trying to do. */
  current_intent: TextSchema,
  current_state: IdeaPhaseSchema.default('seed'),
  requirements: z.array(RequirementSchema).max(200).default([]),
  assumptions: z.array(AssumptionSchema).max(200).default([]),
  constraints: z.array(ConstraintSchema).max(200).default([]),
  unknowns: z.array(UnknownSchema).max(200).default([]),
  evidence: z.array(EvidenceSchema).max(200).default([]),
  research_items: z.array(ResearchItemSchema).max(200).default([]),
  alternatives: z.array(AlternativeSchema).max(60).default([]),
  decisions: z.array(DecisionSchema).max(200).default([]),
  rejected_approaches: z.array(RejectedApproachSchema).max(200).default([]),
  open_questions: z.array(OpenQuestionSchema).max(200).default([]),
  findings: z.array(FindingSchema).max(200).default([]),
  selected_alternative_id: IdSchema.nullable().default(null),
  /**
   * The version tree. `active_branch_id` says which timeline the case is
   * currently on; every commit extends that branch. See `branches.ts` for why a
   * branch is a pointer and not a copy.
   */
  branches: z.array(BranchSchema).max(MAX_BRANCHES).default([]),
  active_branch_id: IdSchema.nullable().default(null),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type IdeaCaseBody = z.infer<typeof IdeaCaseBodySchema>;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export const VersionTriggerSchema = z.enum([
  'initial',
  'turn',
  'accept',
  'reject',
  'user_edit',
  'decision',
  'restore',
  'branch',
]);
export type VersionTrigger = z.infer<typeof VersionTriggerSchema>;

/** What a version actually snapshots: an idea body, without nested history. */
export const IdeaCaseSnapshotSchema = IdeaCaseBodySchema;
export type IdeaCaseSnapshot = z.infer<typeof IdeaCaseSnapshotSchema>;

/**
 * One node in the version tree.
 *
 * `parent_id` and `branch_id` are what make branching work: history is a tree
 * whose nodes are versions, and a branch (`BranchSchema`) is a named pointer at
 * one of them. `number` stays globally monotonic across branches so ordering
 * never depends on which branch you happen to be looking at; the per-branch
 * number a human reads ("main#3") is derived, not stored.
 *
 * A version stores a full snapshot plus references to the change records it
 * applied. "What changed" is derived by diffing two snapshots
 * (`src/core/versioning/diff.ts`) rather than duplicated here, so there is one
 * authority for the shape of a change and one for the shape of the state.
 *
 * `snapshot` is nullable for one reason only: storage pressure. When a workspace
 * exceeds what the browser will hold, the oldest snapshots that are not a branch
 * head, not labelled, and not the original idea are dropped to keep the *current*
 * state savable. The version record itself always survives, so the history still
 * reads as a list of what happened; `snapshot_pruned` makes the loss explicit
 * instead of showing an empty diff and implying nothing changed.
 */
export const VersionRecordSchema = z.object({
  id: IdSchema,
  number: z.number().int().min(0),
  parent_id: IdSchema.nullable().default(null),
  /** Branch this version extends. Null only in pre-branching data. */
  branch_id: IdSchema.nullable().default(null),
  created_at: TimestampSchema,
  summary: ShortTextSchema,
  trigger: VersionTriggerSchema,
  /** The transcript entry that caused this version, if any. */
  message_id: IdSchema.nullable().default(null),
  /** Change records applied in this version (see `ChangeRecordSchema`). */
  applied_change_ids: z.array(IdSchema).max(200).default([]),
  /** A user-given name for this point in history, e.g. "before the balcony constraint". */
  label: z.string().trim().max(120).nullable().default(null),
  snapshot: IdeaCaseSnapshotSchema.nullable(),
  snapshot_pruned: z.boolean().default(false),
});
export type VersionRecord = z.infer<typeof VersionRecordSchema>;

// ---------------------------------------------------------------------------
// IdeaCase
// ---------------------------------------------------------------------------

export const IdeaCaseSchema = IdeaCaseBodySchema.extend({
  version_history: z.array(VersionRecordSchema).max(1000).default([]),
});
export type IdeaCase = z.infer<typeof IdeaCaseSchema>;
