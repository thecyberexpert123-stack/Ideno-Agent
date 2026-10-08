import type {
  AIProvider,
  CompletionRequest,
  CompletionResult,
  ProviderDescription,
} from '../../ai/types.js';

/**
 * A deterministic stand-in for a model, used by the test suite.
 *
 * It is a test double, not a product feature: it is not registered by the
 * server and cannot be selected at runtime. Tests script what the "model"
 * returns per reasoning stage so that orchestration, translation, applier
 * invariants and failure handling can be verified exactly — none of which
 * depend on model quality.
 */
export type ScriptedReply = string | Error | ((request: CompletionRequest) => string | Error);

export interface ScriptedProviderOptions {
  /** Replies keyed by `keyFor(request)`, consumed in order. */
  readonly replies: Readonly<Record<string, readonly ScriptedReply[]>>;
  /** Reply used when a key has no script left. Throws if omitted. */
  readonly fallback?: ScriptedReply;
  /** Defaults to the request purpose. Override to route by turn content. */
  readonly keyFor?: (request: CompletionRequest) => string;
  readonly id?: string;
  readonly configured?: boolean;
}

export class ScriptedProvider implements AIProvider {
  readonly id: string;
  readonly label = 'Scripted test provider';
  readonly supportsJsonSchema = true;

  readonly #replies: Map<string, ScriptedReply[]>;
  readonly #fallback: ScriptedReply | undefined;
  readonly #configured: boolean;
  readonly #keyFor: (request: CompletionRequest) => string;
  readonly calls: CompletionRequest[] = [];

  constructor(options: ScriptedProviderOptions) {
    this.id = options.id ?? 'scripted';
    this.#replies = new Map(
      Object.entries(options.replies).map(([key, replies]) => [key, [...replies]]),
    );
    this.#fallback = options.fallback;
    this.#configured = options.configured ?? true;
    this.#keyFor = options.keyFor ?? ((request) => request.purpose ?? 'unknown');
  }

  isConfigured(): boolean {
    return this.#configured;
  }

  describe(): ProviderDescription {
    return {
      id: this.id,
      label: this.label,
      configured: this.#configured,
      model: 'scripted',
      supportsJsonSchema: true,
      detail: 'Deterministic replies supplied by the test.',
    };
  }

  callsFor(purpose: string): CompletionRequest[] {
    return this.calls.filter((call) => call.purpose === purpose);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(request);
    const key = this.#keyFor(request);
    const queue = this.#replies.get(key);
    const next = queue?.shift() ?? this.#fallback;

    if (next === undefined) {
      throw new Error(`ScriptedProvider has no reply left for key "${key}"`);
    }

    const resolved = typeof next === 'function' ? next(request) : next;
    if (resolved instanceof Error) throw resolved;

    return {
      text: resolved,
      providerId: this.id,
      model: 'scripted',
      finishReason: 'stop',
      usage: null,
      latencyMs: 1,
    };
  }
}

/** Convenience: serialise an object as the model's reply. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}
