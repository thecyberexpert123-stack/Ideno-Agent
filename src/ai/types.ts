/**
 * The AI Runtime Interface.
 *
 * Ideno Core talks to this interface and nothing else. No module under
 * `src/core`, `src/reasoning` or `src/research` may import a provider, name a
 * vendor, or depend on a vendor-specific response shape. Adding a provider
 * means adding a file under `src/ai/providers/` and registering it.
 */

export type CompletionRole = 'system' | 'user' | 'assistant';

export interface CompletionMessage {
  readonly role: CompletionRole;
  readonly content: string;
}

/** A JSON Schema the provider should constrain its output to, when able. */
export interface JsonSchemaSpec {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface CompletionRequest {
  readonly messages: readonly CompletionMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /**
   * Set when the caller needs machine-readable JSON. Providers that support
   * native structured output should use it; the runtime validates the result
   * either way, so honouring it is an optimisation, not a contract.
   */
  readonly jsonSchema?: JsonSchemaSpec;
  readonly signal?: AbortSignal;
  /** Short label (e.g. `understand`) used for logs and diagnostics only. */
  readonly purpose?: string;
}

export interface CompletionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly providerId: string;
  readonly model: string;
  readonly finishReason: string | null;
  readonly usage: CompletionUsage | null;
  readonly latencyMs: number;
}

/** What the UI shows on the provider status panel. */
export interface ProviderDescription {
  readonly id: string;
  readonly label: string;
  /** False when required configuration (endpoint, key, token) is missing. */
  readonly configured: boolean;
  readonly model: string | null;
  readonly supportsJsonSchema: boolean;
  /** One sentence explaining the current state, including how to fix it. */
  readonly detail: string;
  /** Documentation link for configuring this provider. */
  readonly docsUrl?: string;
}

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  readonly supportsJsonSchema: boolean;
  /** True when the provider has everything it needs to attempt a call. */
  isConfigured(): boolean;
  describe(): ProviderDescription;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
