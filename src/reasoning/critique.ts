import type { AIRuntime } from '../ai/runtime.js';
import { buildIdeaContext, type PendingAddition } from '../core/context.js';
import type { IdeaCase } from '../core/schemas.js';
import { critiqueInstructions, stageUserMessage } from './prompts.js';
import { CritiqueResultSchema, type CritiqueResult } from './schemas.js';
import type { StageOptions } from './understand.js';

/**
 * CRITIQUE — stress-test the idea as it currently stands.
 *
 * Findings are recorded as open questions, unknowns, missing requirements or
 * explicit assumptions. They are always `model_suggestion`: a critique is an
 * argument, not a fact, and the user can reject any of it.
 */
export async function runCritique(
  runtime: AIRuntime,
  ideaCase: IdeaCase,
  userMessage: string,
  pendingAdditions: readonly PendingAddition[],
  options: StageOptions = {},
): Promise<CritiqueResult> {
  const result = await runtime.completeStructured({
    schema: CritiqueResultSchema,
    schemaName: 'ideno_critique',
    system: critiqueInstructions(),
    user: stageUserMessage({
      context: buildIdeaContext(ideaCase, { pendingAdditions }),
      userMessage,
      focus:
        'Find the problems that would actually bite when this is built. ' +
        'Prefer a few sharp findings over many shallow ones.',
    }),
    temperature: 0.3,
    purpose: 'critique',
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.value;
}
