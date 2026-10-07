/**
 * Tavily web search as a research source.
 *
 * Tavily is a search API built for agents: one POST returns ranked results, each with
 * its own title, URL and an extracted snippet. That shape is why it is worth having
 * beside Wikipedia — it reaches the current web rather than one encyclopedia, and every
 * result carries a locator a human can follow.
 *
 * The bar is the one the whole evidence pipeline exists to enforce: **nothing is
 * recorded that was not retrieved.** A result with no URL or no title produces no
 * finding, and a finding's claim is the snippet Tavily returned, never a paraphrase
 * written here.
 *
 * ## Two things this module deliberately refuses
 *
 * **It never requests Tavily's synthesised `answer`.** That field is an LLM summary
 * spanning all results with no per-claim attribution, which is precisely what Ideno
 * treats as a model suggestion rather than evidence. Asking for it would create the
 * temptation to store it, so the request sets `include_answer: false` and the response
 * schema ignores it if a server sends one anyway.
 *
 * **It does not treat `score` as truth.** Tavily's score is relevance to the query, and
 * `content` is an AI-extracted portion of the page rather than verbatim text. Both facts
 * are stated in the finding's relevance text, and confidence is capped well below 1 —
 * a high relevance score for a snippet is not the same claim as having read the source.
 *
 * ## Transport
 *
 * Requests go out through an injected `TavilyTransport`. The default is a direct browser
 * `fetch`; the desktop application can inject a transport that routes through its Python
 * host instead. This module never imports the bridge, because only `ui/desktop_bridge.ts`
 * and `ui/app.ts` are allowed to know a desktop host exists — a rule the architecture
 * tests enforce.
 *
 * ## Not verified live
 *
 * Written against Tavily's documented request and response contracts and tested with an
 * injected transport. This sandbox has no route to `api.tavily.com`, so no request here
 * has ever been observed succeeding against the real service — including its CORS
 * policy, which is why a blocked browser call is reported as a distinct, actionable
 * failure rather than as "Tavily found nothing".
 */
import { z } from 'zod';

import type { ResearchFinding, ResearchSearchOptions, ResearchSource } from '../evidence.js';

export const TAVILY_SOURCE_ID = 'tavily';

/** Documented search endpoint. All Tavily endpoints live under this origin. */
export const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * Confidence ceiling for a finding drawn from a Tavily snippet.
 *
 * The snippet is an AI-extracted portion of a page nobody read in full, so this sits at
 * the same level as the Puter web-search ceiling and below a directly supplied source.
 * A result's own relevance score scales it down from there, never up.
 */
export const MAX_TAVILY_CONFIDENCE = 0.6;

/** Below this relevance score a result is dropped: it is noise, not evidence. */
export const MIN_RESULT_SCORE = 0.2;

/** Hard ceiling on results per question, whatever the caller asks for. */
const MAX_RESULTS = 5;

/** Sent to Tavily. Only the fields Ideno needs; the rest keep their documented defaults. */
export interface TavilyRequestBody {
  query: string;
  max_results: number;
  search_depth: 'basic' | 'advanced';
  topic: 'general' | 'news';
  include_answer: false;
  include_raw_content: false;
  include_images: false;
}

/** What a transport is given, and what it must respect. */
export interface TavilyTransportRequest {
  body: TavilyRequestBody;
  /** Bearer token. A transport must never log or echo this. */
  api_key: string;
  timeout_ms: number;
  signal?: AbortSignal;
}

/**
 * One way of reaching Tavily.
 *
 * `kind` is reported to the user when a call fails, because "the browser blocked this"
 * and "the desktop host could not reach it" need different fixes.
 */
export interface TavilyTransport {
  readonly kind: 'http' | 'desktop';
  /** Resolves with the parsed JSON body, or throws with a message a user can act on. */
  post(request: TavilyTransportRequest): Promise<unknown>;
}

export interface TavilySourceOptions {
  /** Required. A source with no key is not registered at all — see `createTavilySource`. */
  api_key?: string;
  /** Defaults to a direct browser fetch. */
  transport?: TavilyTransport;
  /** Test seam for HTTP, used by the default transport. */
  fetch_impl?: typeof fetch;
  timeout_ms?: number;
  /** `advanced` costs more credits and is slower; `basic` is the documented default. */
  search_depth?: 'basic' | 'advanced';
}

const ResultSchema = z.object({
  // Permissive about *values* on purpose: this validates the shape of a reply, and
  // `#toFinding` decides whether a result is usable. One odd result must not cost the
  // user every other result that was perfectly good.
  title: z.string().max(400).optional(),
  url: z.string().max(2000).optional(),
  content: z.string().max(20_000).optional(),
  score: z.number().optional(),
  published_date: z.string().max(120).optional().nullable(),
});

const ResponseSchema = z.object({
  query: z.string().max(600).optional(),
  results: z.array(ResultSchema).max(50).optional(),
  // Documented as a number in one place and a string in another; both are accepted
  // rather than guessing which the service currently sends.
  response_time: z.union([z.number(), z.string()]).optional().nullable(),
});

export class TavilySource implements ResearchSource {
  readonly id = TAVILY_SOURCE_ID;
  readonly label = 'Tavily web search';

  #apiKey: string;
  #transport: TavilyTransport;
  #timeoutMs: number;
  #depth: 'basic' | 'advanced';

  constructor(options: TavilySourceOptions = {}) {
    const key = options.api_key?.trim();
    if (!key) {
      // Throwing here is correct rather than deferring to search(): a source that can
      // never return anything must not be registered, because a registered source that
      // always fails turns every research turn into a wall of error text.
      throw new Error('Tavily needs an API key before it can be registered.');
    }
    this.#apiKey = key;
    this.#transport =
      options.transport ?? createHttpTransport(options.fetch_impl, TAVILY_API_URL);
    this.#timeoutMs = Math.max(1000, options.timeout_ms ?? 20_000);
    this.#depth = options.search_depth === 'advanced' ? 'advanced' : 'basic';
  }

  /** Which route calls take, for display in Settings. Never contains a key. */
  get transportKind(): 'http' | 'desktop' {
    return this.#transport.kind;
  }

  async search(query: string, options: ResearchSearchOptions = {}): Promise<ResearchFinding[]> {
    const question = query.trim();
    if (question.length === 0) return [];

    const limit = Math.min(MAX_RESULTS, Math.max(1, options.limit ?? 3));
    const body: TavilyRequestBody = {
      query: question,
      max_results: limit,
      search_depth: this.#depth,
      topic: 'general',
      // Refused on purpose: an unattributed synthesis is a model suggestion, not evidence.
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    };

    let payload: unknown;
    try {
      payload = await this.#transport.post({
        body,
        api_key: this.#apiKey,
        timeout_ms: this.#timeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(describe(error));
    }

    const parsed = ResponseSchema.safeParse(payload);
    if (!parsed.success) {
      // An unrecognised response is a failure, not zero findings: "Tavily found nothing"
      // and "Tavily answered in a shape I did not expect" call for different responses.
      throw new Error(
        `Tavily answered in an unrecognised format (${parsed.error.issues[0]?.message ?? 'unknown'}).`,
      );
    }

    const results = parsed.data.results ?? [];
    const findings: ResearchFinding[] = [];
    for (const result of results) {
      const finding = this.#toFinding(result, question);
      if (finding) findings.push(finding);
      if (findings.length >= limit) break;
    }
    return findings;
  }

  /**
   * Builds one finding from one result, or nothing.
   *
   * The rules are the ones that keep a citation honest:
   *  - no URL, no finding — a locator is what makes evidence checkable;
   *  - no title, no finding — an untitled source cannot be identified by a reader;
   *  - no snippet, no finding — there is then nothing the source actually says;
   *  - a non-http(s) URL, no finding — it would render as inert text and could not be followed;
   *  - a relevance score below `MIN_RESULT_SCORE`, no finding — Tavily ranked it as barely related.
   */
  #toFinding(result: z.infer<typeof ResultSchema>, question: string): ResearchFinding | null {
    const title = result.title?.trim();
    const url = result.url?.trim();
    const content = cleanSnippet(result.content);
    if (!title || !url || content.length === 0) return null;
    if (!isFollowableLocator(url)) return null;

    const score = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : null;
    if (score !== null && score < MIN_RESULT_SCORE) return null;

    return {
      claim: content,
      source: {
        title,
        locator: url,
        publisher: publisherOf(url),
      },
      // States what was actually read, and what the score means. Claiming the page
      // supported the answer would overstate what an extracted snippet can do.
      relevance:
        `Web search result for “${truncate(question, 120)}”, ranked ${score === null ? 'without a reported score' : `${Math.round(score * 100)}% relevant`}. ` +
        `The quoted text is the portion Tavily extracted from “${truncate(title, 80)}”; the page itself was not read in full.` +
        (result.published_date ? ` Published ${result.published_date}.` : ''),
      confidence: confidenceFor(score),
      retrieved_at: new Date().toISOString(),
    };
  }
}

/**
 * Confidence from a relevance score.
 *
 * Scales down from the ceiling and never exceeds it. A missing score gets half the
 * ceiling: an unranked result is weaker evidence than a top-ranked one, but it is not
 * worthless, and inventing a number would be worse than admitting the uncertainty.
 */
export function confidenceFor(score: number | null): number {
  if (score === null) return MAX_TAVILY_CONFIDENCE / 2;
  const clamped = Math.min(1, Math.max(0, score));
  return Math.round(MAX_TAVILY_CONFIDENCE * clamped * 100) / 100;
}

/** Only `http` and `https` can become a link a reader can follow. */
export function isFollowableLocator(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The host, as a publisher name. Falls back to null rather than guessing. */
export function publisherOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Normalises a snippet. Tavily returns text, but never assume it is clean. */
export function cleanSnippet(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

/**
 * The default transport: a direct browser request.
 *
 * A browser cannot tell a CORS block from a dead network — both surface as a `TypeError`
 * with no status — so the failure message names both possibilities and points at the
 * route that has no CORS constraint at all. Saying "blocked by CORS" as a certainty
 * would be a guess dressed as a diagnosis.
 */
export function createHttpTransport(
  fetchImpl: typeof fetch | undefined,
  endpoint: string = TAVILY_API_URL,
): TavilyTransport {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    kind: 'http',
    async post(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeout_ms);
      const onAbort = (): void => controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${request.api_key}`,
          },
          body: JSON.stringify(request.body),
        });
      } catch (error) {
        if (request.signal?.aborted) throw new Error('The web search was cancelled.');
        if (controller.signal.aborted) throw new Error(`Tavily did not respond within ${request.timeout_ms} ms.`);
        throw new Error(
          `Tavily could not be reached from the browser (${describe(error)}). ` +
            'Either the network is unavailable, or the browser blocked this cross-origin request ' +
            '(Tavily may not permit calls from a web page). Running Ideno as the desktop ' +
            'application routes the search through its Python host, which has no such restriction.',
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }

      if (!response.ok) throw new Error(httpFailure(response.status, endpoint));
      try {
        return (await response.json()) as unknown;
      } catch (error) {
        throw new Error(`Tavily's reply was not valid JSON (${describe(error)}).`);
      }
    },
  };
}

/**
 * Turns a status into something a user can act on.
 *
 * Tavily documents 401, 429, 432 and 433 among its failures, and each has a different
 * fix. A bare "HTTP 432" would be honest but useless.
 */
export function httpFailure(status: number, endpoint: string): string {
  switch (status) {
    case 400:
    case 422:
      return `Tavily rejected the request as malformed (HTTP ${status}).`;
    case 401:
    case 403:
      return `Tavily rejected the API key (HTTP ${status}). Check it in Settings — a key that has been rotated or revoked fails here.`;
    case 429:
      return 'Tavily rate-limited this request (HTTP 429). Wait a moment, or raise the plan limit on the account.';
    case 432:
    case 433:
      return `Tavily refused the request against this account's limits (HTTP ${status}). This usually means the credit balance or plan cap has been reached.`;
    default:
      return status >= 500
        ? `Tavily's servers returned HTTP ${status}. Nothing was wrong on this side; try again.`
        : `Tavily returned HTTP ${status} from ${endpoint}.`;
  }
}

/**
 * Creates the source, or null when it cannot work.
 *
 * Returning null rather than throwing keeps the composition root simple: a missing key
 * is an ordinary state (most users have no Tavily account), not an error condition, and
 * the registry should end up without this source rather than fail to build at all.
 */
export function createTavilySource(options: TavilySourceOptions = {}): ResearchSource | null {
  if (!options.api_key?.trim()) return null;
  return new TavilySource(options);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
