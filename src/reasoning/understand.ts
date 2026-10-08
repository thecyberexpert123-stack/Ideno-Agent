import type { AIRuntime } from '../ai/runtime.js';
import { buildIdeaContext } from '../core/context.js';
import type { IdeaCase } from '../core/schemas.js';
import { stageUserMessage, understandInstructions } from './prompts.js';
import { UnderstandResultSchema, type UnderstandResult } from './schemas.js';

export interface StageOptions {
  readonly providerId?: string;
  readonly signal?: AbortSignal;
}

/**
 * UNDERSTAND — the only stage that runs on every turn.
 *
 * Turns a free-form message into typed extractions plus routing flags the
 * orchestrator uses to decide which further stages are worth running.
 */
export async function runUnderstand(
  runtime: AIRuntime,
  ideaCase: IdeaCase,
  userMessage: string,
  options: StageOptions = {},
): Promise<UnderstandResult> {
  const result = await runtime.completeStructured({
    schema: UnderstandResultSchema,
    schemaName: 'ideno_understand',
    system: understandInstructions(),
    user: stageUserMessage({
      context: buildIdeaContext(ideaCase),
      userMessage,
    }),
    temperature: 0.2,
    purpose: 'understand',
    ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.value;
}
