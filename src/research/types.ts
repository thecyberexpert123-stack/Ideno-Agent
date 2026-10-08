/** A document actually retrieved from a source, with its provenance. */
export interface SourceDocument {
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string | null;
  /** Extracted plain text. Never the raw markup. */
  readonly text: string;
  readonly retrievedAt: string;
  readonly contentType: string;
  /** True when the body was cut short by the size cap. */
  readonly truncated: boolean;
}

export interface SourceFetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * Retrieves a source document.
 *
 * Kept behind an interface so that a future research plugin (a search API, a
 * document store, a local corpus) slots in without the research service
 * changing.
 */
export interface SourceFetcher {
  readonly id: string;
  fetch(url: string, options?: SourceFetchOptions): Promise<SourceDocument>;
}
