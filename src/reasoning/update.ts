import type { AIRuntime } from '../ai/runtime.js';
import { buildIdeaContext, type PendingAddition } from '../core/context.js';
import type { IdeaCase } from '../core/schemas.js';
import { impactInstructions, stageUserMessage } from './prompts.js';
import { ImpactResultSchema, type ImpactResult } from './schemas.js';
import type { StageOptions } from './understand.js';

/**
 * UPDATE — impact analysis.
 *
 * Runs after extraction, with the about-to-be-added items visible as `@refs`,
 * so the model can attribute an effect to the specific new constraint that
 * caused it. This is what makes "it has to run without mains electricity"
 * revisit the power assumptions instead of landing as an unrelated note.
 */
export async function runImpactAnalysis(
  runtime: AIRuntime,
  ideaCase: IdeaCase,
  userMessage: string,
  pendingAdditions: readonly PendingAddition[],
  options: StageOptions = {},
): Promise<ImpactResult> {
  const result = await runtime.completeStructured({
    schema: ImpactResultSchema,
    schemaName: 'ideno_impact',
    system: impactInstructions(),
    user: stageUserMessage({
      context: buildIdeaContext(ideaCase, { pendingAdditions }),
      userMessage,
      focus:
        'Decide what the new information above changes about the existing items. ' +
        'Reference new items by their @ref and existing items by their id.',
    }),
    temperature: 0.1,
    purpose: 'impact',
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.value;
}
