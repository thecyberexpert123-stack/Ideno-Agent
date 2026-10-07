/**
 * Operation preparation: state + conversation in, model messages out.
 *
 * This module is pure. Given an operation and the current Idea State it produces
 * exactly the messages a provider will receive, which makes the whole prompt
 * surface testable without a model, a network, or a key.
 *
 * The conversation window is deliberately separate from the state digest, and the
 * newest user message is delivered inside the structured block rather than as a
 * bare chat turn: the state is the source of truth, the transcript is context.
 */
import type {
  ChangeRecord,
  IdeaCaseBody,
  Operation,
  TranscriptEntry,
} from '../core/schemas/index.js';
import type { ChatTurn } from '../ai/provider_interface/provider.js';
import {
  CONTEXT_LEGEND,
  assembleUserPrompt,
  buildPendingDigest,
  buildStateDigest,
  buildTranscriptWindow,
} from './context.js';
import { CONTRACT_NOTES, OPERATION_INSTRUCTIONS, buildSystemPrompt } from './prompts.js';

export interface OperationInput {
  operation: Operation;
  body: IdeaCaseBody;
  /** Conversation *before* the message being processed. */
  history?: TranscriptEntry[];
  /** Changes awaiting the human's Accept / Reject. */
  pending?: ChangeRecord[];
  /** The message being processed, when there is one. */
  user_message?: string | null;
  transcript_turns?: number;
  /** Appended to the operation instruction, e.g. a UI action's specifics. */
  extra_instruction?: string;
  digest_max_chars?: number;
}

export interface PreparedOperation {
  operation: Operation;
  system: string;
  turns: ChatTurn[];
  contract_notes: string;
  /** Character size of everything sent, for budgets and diagnostics. */
  size: number;
}

const DEFAULT_TRANSCRIPT_TURNS = 6;

export function prepareOperation(input: OperationInput): PreparedOperation {
  const baseInstruction = OPERATION_INSTRUCTIONS[input.operation];
  const instruction = input.extra_instruction
    ? `${baseInstruction}\n\nAdditional direction for this turn: ${input.extra_instruction}`
    : baseInstruction;

  const stateDigest = buildStateDigest(input.body, { max_chars: input.digest_max_chars });
  const pendingDigest = buildPendingDigest(input.pending ?? []);
  const history = buildTranscriptWindow(input.history ?? [], input.transcript_turns ?? DEFAULT_TRANSCRIPT_TURNS);

  const taskTurn: ChatTurn = {
    role: 'user',
    content: assembleUserPrompt({
      state_digest: stateDigest,
      pending_digest: pendingDigest,
      instruction,
      user_message: input.user_message ?? undefined,
    }),
  };

  const turns = [...history, taskTurn];
  const system = `${buildSystemPrompt(input.operation)}\n\n${CONTEXT_LEGEND}`;

  return {
    operation: input.operation,
    system,
    turns,
    contract_notes: CONTRACT_NOTES,
    size: system.length + turns.reduce((total, turn) => total + turn.content.length, 0),
  };
}

/**
 * Which operation a plain conversational turn should run.
 *
 * `understand` only while the idea is still raw: after the first structuring
 * pass every message is an update, because the state — not the message count —
 * decides whether Ideno has understood anything yet.
 */
export function initialOperation(body: IdeaCaseBody): Operation {
  const hasStructure =
    body.requirements.length > 0 ||
    body.constraints.length > 0 ||
    body.alternatives.length > 0 ||
    body.unknowns.length > 0 ||
    body.assumptions.length > 0;
  return hasStructure ? 'update' : 'understand';
}
