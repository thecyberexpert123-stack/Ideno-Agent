/**
 * Provider-neutral AI interfaces.
 *
 * Ideno Core talks to `AIProvider` and nothing else. There is no Puter import,
 * no OpenAI HTTP shape and no model name anywhere outside `src/ai/providers/`.
 * Adding a provider means adding one file that satisfies this interface.
 */
import type { Operation } from '../../core/schemas/index.js';
import type { ProviderId } from '../settings.js';

/** One turn of the structured context handed to a model. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Which reasoning operation issued the call. Used for logging and limits. */
  task: Operation;
  messages: ChatTurn[];
  /** Provider-specific model id. `null` means "provider default". */
  model?: string | null;
  temperature?: number;
  max_output_tokens?: number;
  /** Hard wall-clock budget. Providers must honour `signal`. */
  timeout_ms?: number;
  signal?: AbortSignal;
  /**
   * Hint that the caller wants JSON. Providers with a native JSON mode use it;
   * providers without one ignore it, because the runtime parses and validates
   * the response either way.
   */
  json_mode?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider_id: ProviderId;
  finish_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * One piece of a streamed completion.
 *
 * Deliberately coarse: `text` is the only variant Ideno acts on. Reasoning deltas
 * are reported but never stored, because a summary of the reasoning is what the
 * product keeps and the raw stream is not.
 */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'finish'; reason?: string | null; usage?: CompletionResult['usage'] };

/** What a streaming provider yields, plus what the stream resolved to. */
export interface CompletionStream {
  chunks: AsyncIterable<StreamChunk>;
  /** The model and provider, known before the first chunk arrives. */
  model: string;
  provider_id: ProviderId;
}

/** What a provider can do. The runtime adapts to these instead of assuming. */
export interface ProviderCapabilities {
  /** Native `response_format: { type: "json_object" }` support. */
  json_mode: boolean;
  streaming: boolean;
  /** Can enumerate its own models. */
  model_catalog: boolean;
  /** Function/tool calling. */
  tools: boolean;
  /** Accepts a max-output-tokens parameter. */
  max_output_tokens: boolean;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider?: string;
  context_window?: number | null;
}

export type ProviderAction = 'sign_in' | 'configure' | 'retry' | 'none';

export interface ProviderAvailability {
  available: boolean;
  /** Human-readable explanation when unavailable. */
  reason?: string;
  /** What the UI should offer to do about it. */
  action?: ProviderAction;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;

  capabilities(): ProviderCapabilities;

  /**
   * Must not throw: an unreachable provider is a normal state of the world, and
   * Ideno has to be able to render its UI and explain itself when that happens.
   */
  isAvailable(): Promise<ProviderAvailability>;

  /** Model catalog, or an empty list when the provider cannot enumerate. */
  listModels(): Promise<ModelInfo[]>;

  complete(request: CompletionRequest): Promise<CompletionResult>;

  /**
   * Streaming completion. Optional, and the runtime adapts: a provider that does
   * not implement it is still a fully valid provider, and every structured call
   * falls back to `complete`.
   *
   * Streaming changes what the user sees *while* waiting. It never changes what may
   * be written: the runtime accumulates the whole response and validates it exactly
   * as it would a non-streamed one, so a half-arrived document can never reach the
   * Idea State.
   */
  completeStream?(request: CompletionRequest): Promise<CompletionStream>;

  /** Optional interactive sign-in (Puter). Resolves to the new availability. */
  signIn?(): Promise<ProviderAvailability>;

  /**
   * Optional per-session reset. A stateful provider (the scripted one, which
   * replays a queue) uses it when the user starts a new idea; stateless providers
   * simply do not implement it. Declaring it here is what keeps the UI from having
   * to import a concrete adapter to call it.
   */
  reset?(): void;
}
