/**
 * Behaviour settings — the provider-agnostic half of Ideno's configuration.
 *
 * These are the knobs the orchestrator and the reasoning layer actually read: how
 * much conversation to include, how strictly to review proposed changes, and the
 * sampling budget. Nothing here names a provider, which is what keeps `src/core`
 * free of provider-specific anything.
 */
import { z } from 'zod';

/**
 * `assisted` applies changes grounded in the user's own words and queues
 * everything the model inferred for review. `strict` queues everything the model
 * touched. Either way the human stays the decision-maker; the difference is only
 * how much clicking their own statements require.
 */
export const ReviewModeSchema = z.enum(['assisted', 'strict']);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const BehaviourSettingsSchema = z.object({
  review_mode: ReviewModeSchema.default('assisted'),
  temperature: z.number().min(0).max(2).default(0.3),
  timeout_ms: z.number().int().min(5_000).max(180_000).default(60_000),
  /** Transcript turns included when building model context. */
  context_transcript_turns: z.number().int().min(0).max(24).default(6),
});
export type BehaviourSettings = z.infer<typeof BehaviourSettingsSchema>;
