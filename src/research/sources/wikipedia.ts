/**
 * Wikipedia as a research source.
 *
 * The bar for this module is the one the whole evidence pipeline exists to enforce:
 * **nothing is recorded that was not retrieved.** A finding without a title and a
 * locator is dropped by `findingsToEvidenceDrafts` before it can become evidence, and
 * a citation is only ever built from identifiers the API returned — never assembled
 * from the search terms, which is how a plausible-looking reference to a page that
 * does not exist gets invented.
 *
 * ## Why the Action API rather than the REST API
 *
 * Both can answer this query. MediaWiki's own documentation shows the Action API
 * (`/w/api.php`) being called from browser JavaScript with `origin=*`, which is the
 * CORS contract Ideno needs; the REST API examples in the same documentation are
 * server-side `requests` calls. So the choice is not stylistic — it is the endpoint
 * whose cross-origin use is documented.
 *
 * `origin=*` makes the request anonymous. That is the right trade for a read-only
 * lookup from somebody's browser: it sends no identity, and it is what keeps Ideno
 * free of credentials it would otherwise have to store.
 *
 * ## What a finding here actually claims
 *
 * Only the **lead section** of an article is read, so confidence is capped well below
 * 1 and the relevance text says so in terms. Presenting a summary as though the source
 * had been read in full would be a subtler version of the fabrication this module
 * exists to prevent.
 *
 * ## Not verified live
 *
 * Written against the documented response shape and tested with an injected `fetch`.
 * This sandbox has no route to `en.wikipedia.org`, so no request in this file has ever
 * been observed succeeding against the real service; the parsing is defensive because
 * of that, not in spite of it.
 */
import { z } from 'zod';

import type { ResearchFinding, ResearchSearchOptions, ResearchSource } from '../evidence.js';

export const WIKIPEDIA_SOURCE_ID = 'wikipedia';

/** Endpoint documented for cross-origin browser use with `origin=*`. */
export const WIKIPEDIA_API_URL = 'https://en.wikipedia.org/w/api.php';

/**
 * Confidence ceiling for a finding drawn from a lead section.
 *
 * Not a guess at how reliable Wikipedia is — a statement about how much of the source
 * was read. Four sentences cannot support a claim as strongly as the article it came
 * from, and the number should say that.
 */
export const MAX_SUMMARY_CONFIDENCE = 0.45;

/** Sentences of the lead section to read per page. */
const EXTRACT_SENTENCES = 4;
/** Hard ceiling on results, whatever the caller asks for. */
const MAX_RESULTS = 5;

export interface WikipediaSourceOptions {
  /** Injectable so the whole source is testable with no network. */
  fetch_impl?: typeof fetch;
  /** Language edition. Defaults to English. */
  language?: string;
  /** Sentences of the lead section to read. */
  sentences?: number;
  /** Wall-clock budget for one lookup, in milliseconds. */
  timeout_ms?: number;
  /** Identifies Ideno to the API in logs. Never a secret. */
  user_agent?: string;
}

/**
 * Response shape, validated rather than trusted.
 *
 * Every field is optional or defaulted on purpose. A partial response yields fewer
 * findings; it never yields a finding with an invented field.
 */
const PageSchema = z.object({
  pageid: z.number().optional(),
  // Deliberately permissive about *values*: this schema checks the shape of a reply,
  // and `#toFinding` decides whether a page is usable. An empty title would otherwise
  // fail the whole response, and one odd page in a result list would cost the user
  // every other page that was perfectly good.
  title: z.string().max(400).optional(),
  /** Present with `inprop=url`. The locator a human can follow. */
  fullurl: z.string().max(1000).optional(),
  /** Revision the extract came from, which makes a permanent citation possible. */
  lastrevid: z.number().int().positive().optional(),
  /** When the page was last changed, as reported by the API. */
  touched: z.string().max(64).optional(),
  /** Lead section, plain text because `explaintext` is requested. */
  extract: z.string().max(20_000).optional(),
  /** Set when the title is a disambiguation page rather than a subject. */
  imagerepository: z.string().optional(),
});

const ResponseSchema = z.object({
  error: z.object({ code: z.string().max(80), info: z.string().max(600) }).optional(),
  query: z
    .object({
      pages: z.array(PageSchema).max(50).optional(),
      searchinfo: z.object({ totalhits: z.number().optional() }).optional(),
    })
    .optional(),
});

export class WikipediaSource implements ResearchSource {
  readonly id = WIKIPEDIA_SOURCE_ID;
  readonly label = 'Wikipedia (lead sections)';

  #fetch: typeof fetch;
  #apiUrl: string;
  #sentences: number;
  #timeoutMs: number;
  #publisher: string;

  constructor(options: WikipediaSourceOptions = {}) {
    const language = (options.language ?? 'en').replace(/[^a-z-]/gi, '').slice(0, 12) || 'en';
    this.#fetch = options.fetch_impl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.#apiUrl = language === 'en' ? WIKIPEDIA_API_URL : `https://${language}.wikipedia.org/w/api.php`;
    this.#publisher = `Wikipedia (${language})`;
    this.#sentences = Math.min(12, Math.max(1, options.sentences ?? EXTRACT_SENTENCES));
    this.#timeoutMs = Math.max(1000, options.timeout_ms ?? 15_000);
  }

  /** Where requests go, for display in Settings. Never contains a query. */
  get endpoint(): string {
    return this.#apiUrl;
  }

  async search(query: string, options: ResearchSearchOptions = {}): Promise<ResearchFinding[]> {
    const question = query.trim();
    if (question.length === 0) return [];

    const limit = Math.min(MAX_RESULTS, Math.max(1, options.limit ?? 3));
    const url = this.#requestUrl(question, limit);

    const response = await this.#get(url, options.signal);
    const parsed = ResponseSchema.safeParse(response);
    if (!parsed.success) {
      // An unrecognised response is a failure, not zero findings: the difference
      // matters, because "Wikipedia found nothing" and "Wikipedia answered in a shape
      // I did not expect" call for different responses from the user.
      throw new Error(`Wikipedia answered in an unrecognised format (${parsed.error.issues[0]?.message ?? 'unknown'}).`);
    }
    if (parsed.data.error) {
      throw new Error(`Wikipedia reported ${parsed.data.error.code}: ${parsed.data.error.info}`);
    }

    const pages = parsed.data.query?.pages ?? [];
    const findings: ResearchFinding[] = [];
    for (const page of pages.slice(0, limit)) {
      const finding = this.#toFinding(page, question);
      if (finding) findings.push(finding);
    }
    return findings;
  }

  #requestUrl(question: string, limit: number): string {
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      // Cleaner output: real booleans and `pages` as an array rather than a keyed
      // object, which is one less shape to defend against.
      formatversion: '2',
      // Anonymous cross-origin request, as documented.
      origin: '*',
      generator: 'search',
      gsrsearch: question,
      gsrlimit: String(limit),
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      exsentences: String(this.#sentences),
      inprop: 'url',
      redirects: '1',
    });
    return `${this.#apiUrl}?${params.toString()}`;
  }

  async #get(url: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('The lookup was cancelled.');
      throw new Error(`Wikipedia could not be reached (${describe(error)}).`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new Error(`Wikipedia returned HTTP ${response.status} for that lookup.`);
    }
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new Error(`Wikipedia's reply was not valid JSON (${describe(error)}).`);
    }
  }

  /**
   * Builds one finding from one page, or nothing.
   *
   * The rules are the ones that keep a citation honest:
   *  - a page with no title or no URL produces no finding, because a locator is what
   *    makes evidence checkable;
   *  - a page with no readable extract produces no finding, because there is then
   *    nothing the source actually says;
   *  - the claim is the source's own words, trimmed, never a paraphrase written here.
   */
  #toFinding(page: z.infer<typeof PageSchema>, question: string): ResearchFinding | null {
    const title = page.title?.trim();
    const url = page.fullurl?.trim();
    const extract = cleanExtract(page.extract);
    if (!title || !url || extract.length === 0) return null;

    return {
      claim: extract,
      source: {
        title,
        locator: permalink(url, page.lastrevid),
        publisher: this.#publisher,
      },
      // Says what was read, and what that means for how much weight it carries. A
      // relevance field that claimed the article supported the answer would be
      // overstating what four sentences can do.
      relevance: `Lead section of the Wikipedia article “${title}”, retrieved for “${truncate(question, 120)}”. ` +
        `Only the first ${this.#sentences} sentences were read; the article itself was not.`,
      confidence: MAX_SUMMARY_CONFIDENCE,
      retrieved_at: new Date().toISOString(),
    };
  }
}

/**
 * A permanent citation where one is possible.
 *
 * `?oldid=<revid>` points at the exact revision the extract came from, which is the
 * difference between "this page said this" and "this page says this, as of a moment I
 * can name". Without a revision id the plain article URL is used, because a real URL
 * to the current revision is better than a constructed guess at an old one.
 */
export function permalink(url: string, revision: number | undefined): string {
  if (typeof revision !== 'number' || !Number.isFinite(revision) || revision <= 0) return url;
  try {
    const parsed = new URL(url);
    // Never append to a URL that already carries a query: two `oldid`s, or an oldid
    // fighting an existing parameter, would cite something other than what was read.
    if (parsed.search.length > 0) return url;
    parsed.search = `?oldid=${Math.floor(revision)}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Strips markup the API can still include, and normalises whitespace.
 *
 * `explaintext` asks for plain text, and the search generator's highlights are what
 * this mainly defends against: MediaWiki wraps matched terms in
 * `<span class="searchmatch">` in some endpoints. Rendering that as text would put
 * markup into the Idea State, so it is removed here rather than trusted away.
 */
export function cleanExtract(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    // Removed rather than replaced with a space: inline markup sits between a word and
    // its own punctuation, so substituting a space turns "wet.</span>" into "wet .".
    .replace(/<[^>]*>/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

export function createWikipediaSource(options: WikipediaSourceOptions = {}): ResearchSource {
  return new WikipediaSource(options);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
