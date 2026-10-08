import type { AIRuntime } from '../ai/runtime.js';
import { buildIdeaContext, type PendingAddition } from '../core/context.js';
import type { IdeaCase } from '../core/schemas.js';
import { exploreInstructions, stageUserMessage } from './prompts.js';
import { ExploreResultSchema, type ExploreResult } from './schemas.js';
import type { StageOptions } from './understand.js';

/**
 * EXPLORE — widen the possibility space.
 *
 * Runs when the user asks for options, and also when impact analysis shows the
 * design space itself moved. That second trigger is the non-linear part of the
 * loop: a new constraint sends Ideno back to exploration without being asked.
 */
export async function runExplore(
  runtime: AIRuntime,
  ideaCase: IdeaCase,
  userMessage: string,
  pendingAdditions: readonly PendingAddition[],
  focus: string,
  options: StageOptions = {},
): Promise<ExploreResult> {
  const result = await runtime.completeStructured({
    schema: ExploreResultSchema,
    schemaName: 'ideno_explore',
    system: exploreInstructions(),
    user: stageUserMessage({
      context: buildIdeaContext(ideaCase, { pendingAdditions }),
      userMessage,
      focus,
    }),
    temperature: 0.6,
    purpose: 'explore',
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.value;
}
