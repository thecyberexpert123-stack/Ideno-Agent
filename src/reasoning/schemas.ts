import { z } from 'zod';
import { IdeaPhaseSchema } from '../core/schemas.js';

/**
 * Schemas for what each reasoning stage is allowed to return.
 *
 * These are deliberately *not* the state-operation schemas. A stage describes
 * what it found in its own domain language; translating that into state
 * operations is done by ordinary TypeScript in `src/core/orchestrator.ts`.
 *
 * Two reasons:
 *  - The model never gets to write state directly, so a hallucinated id or an
 *    illegal transition cannot be expressed, let alone applied.
 *  - The stage contracts stay small, which materially improves compliance from
 *    smaller local models.
 */

const Sentence = z.string().trim().min(1).max(400);
const Paragraph = z.string().trim().max(800);
const Label = z.string().trim().min(1).max(80);
const ItemId = z.string().trim().min(1).max(64);

/**
 * How a statement relates to what the user actually said.
 *
 * `stated`  — the user said it; `source_quote` must contain their words.
 * `implied` — a direct consequence of what they said.
 * `inferred` — the model's own idea. Recorded as a suggestion, never as fact.
 */
export const BasisSchema = z.enum(['stated', 'implied', 'inferred']);
export type Basis = z.infer<typeof BasisSchema>;

export const ExtractedStatementSchema = z.object({
  text: Sentence,
  basis: BasisSchema,
  /** Required when basis is `stated`: the user's own words, copied exactly. */
  source_quote: z.string().trim().max(300).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  rationale: Paragraph.nullable().optional(),
});
export type ExtractedStatement = z.infer<typeof ExtractedStatementSchema>;

export const ExtractedUnknownSchema = ExtractedStatementSchema.extend({
  /** 0..1 — how much the current design hinges on resolving this. */
  impact: z.number().min(0).max(1).nullable().optional(),
  blocks: z.array(Label).max(6).nullable().optional(),
});
export type ExtractedUnknown = z.infer<typeof ExtractedUnknownSchema>;

export const ProvidedEvidenceSchema = z.object({
  claim: Sentence,
  relevance: Sentence,
  /** A URL the user cited. Ideno records that it has not read it. */
  source_url: z.string().trim().max(2000).nullable().optional(),
  /** What the user said they were citing, when there is no URL. */
  source_description: z.string().trim().max(300).nullable().optional(),
  excerpt: z.string().trim().max(2000).nullable().optional(),
  source_quote: z.string().trim().max(300).nullable().optional(),
});
export type ProvidedEvidence = z.infer<typeof ProvidedEvidenceSchema>;

export const DecisionProposalSchema = z.object({
  question: Sentence,
  chosen: Sentence,
  /** Id of the alternative the user picked, when they picked an existing one. */
  alternative_id: ItemId.nullable().optional(),
  rationale: Paragraph.nullable().optional(),
  source_quote: z.string().trim().max(300).nullable().optional(),
});
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>;

export const RejectionProposalSchema = z.object({
  text: Sentence,
  reason: Sentence,
  alternative_id: ItemId.nullable().optional(),
  source_quote: z.string().trim().max(300).nullable().optional(),
});
export type RejectionProposal = z.infer<typeof RejectionProposalSchema>;

export const TurnIntentSchema = z.enum([
  'new_idea',
  'refine_idea',
  'add_constraint',
  'add_requirement',
  'provide_evidence',
  'request_alternatives',
  'make_decision',
  'reject_approach',
  'ask_question',
  'other',
]);
export type TurnIntent = z.infer<typeof TurnIntentSchema>;

export const UnderstandResultSchema = z.object({
  turn_intent: TurnIntentSchema,
  /** One or two sentences, addressed to the user, reflecting what you understood. */
  intent_summary: Sentence,
  /** The user's actual underlying goal, restated. */
  goal: Paragraph.nullable().optional(),
  title_suggestion: z.string().trim().max(80).nullable().optional(),
  phase: IdeaPhaseSchema.nullable().optional(),
  requirements: z.array(ExtractedStatementSchema).max(8).default([]),
  constraints: z.array(ExtractedStatementSchema).max(8).default([]),
  assumptions: z.array(ExtractedStatementSchema).max(8).default([]),
  unknowns: z.array(ExtractedUnknownSchema).max(8).default([]),
  evidence: z.array(ProvidedEvidenceSchema).max(5).default([]),
  decision: DecisionProposalSchema.nullable().optional(),
  rejections: z.array(RejectionProposalSchema).max(5).default([]),
  /** Ids of existing items this message bears on. */
  affected_item_ids: z.array(ItemId).max(20).default([]),
  needs_critique: z.boolean(),
  needs_exploration: z.boolean(),
  needs_research: z.boolean(),
});
export type UnderstandResult = z.infer<typeof UnderstandResultSchema>;

export const ImpactEffectSchema = z.enum(['invalidates', 'weakens', 'reinforces']);
export type ImpactEffect = z.infer<typeof ImpactEffectSchema>;

export const ImpactResultSchema = z.object({
  impacts: z
    .array(
      z.object({
        /** Existing item id, or `@ref` of something being added this turn. */
        cause_ref: ItemId,
        item_id: ItemId,
        effect: ImpactEffectSchema,
        reason: Sentence,
      }),
    )
    .max(20)
    .default([]),
  /** Design areas this turn disturbs, e.g. "power architecture". */
  affected_areas: z.array(Label).max(10).default([]),
  newly_relevant_unknowns: z.array(ExtractedUnknownSchema).max(5).default([]),
  summary: Paragraph.default(''),
});
export type ImpactResult = z.infer<typeof ImpactResultSchema>;

export const CritiqueKindSchema = z.enum([
  'contradiction',
  'unrealistic_assumption',
  'missing_requirement',
  'technical_limitation',
  'hidden_dependency',
  'failure_point',
]);
export type CritiqueKind = z.infer<typeof CritiqueKindSchema>;

export const CritiqueFindingSchema = z.object({
  kind: CritiqueKindSchema,
  text: Sentence,
  severity: z.enum(['low', 'medium', 'high']),
  related_item_ids: z.array(ItemId).max(6).default([]),
  /** Where this finding belongs in the Idea State. */
  record_as: z.enum(['open_question', 'unknown', 'requirement', 'assumption', 'none']),
  /** Set when answering a question would settle the finding. */
  research_question: z.string().trim().max(300).nullable().optional(),
  impact: z.number().min(0).max(1).nullable().optional(),
});
export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;

export const CritiqueResultSchema = z.object({
  findings: z.array(CritiqueFindingSchema).max(8).default([]),
  summary: Paragraph.default(''),
});
export type CritiqueResult = z.infer<typeof CritiqueResultSchema>;

export const AlternativeProposalSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  approach: z.string().trim().min(1).max(800),
  pros: z.array(Label).max(5).default([]),
  cons: z.array(Label).max(5).default([]),
  tradeoffs: z.array(Label).max(5).default([]),
  preconditions: z.array(Label).max(5).default([]),
  satisfies_constraint_ids: z.array(ItemId).max(10).default([]),
  violates_constraint_ids: z.array(ItemId).max(10).default([]),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
export type AlternativeProposal = z.infer<typeof AlternativeProposalSchema>;

export const ExploreResultSchema = z.object({
  alternatives: z.array(AlternativeProposalSchema).max(5).default([]),
  /** Directions worth noticing that are not full alternatives. */
  adjacent_possibilities: z.array(Sentence).max(5).default([]),
  research_questions: z.array(Sentence).max(5).default([]),
  summary: Paragraph.default(''),
});
export type ExploreResult = z.infer<typeof ExploreResultSchema>;
