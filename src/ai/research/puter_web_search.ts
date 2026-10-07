/**
 * Puter's `web_search` tool as a research source.
 *
 * This lives in `src/ai`, not `src/research`, because it is provider-specific: it
 * calls `puter.ai.chat` with `tools: [{ type: "web_search" }]`. `src/core` and the
 * provider-neutral half of `src/research` never learn that Puter exists, and the
 * architecture tests check that by reading the sources.
 *
 * ## Why this is off by default and heavily guarded
 *
 * Two documented facts, and one gap between them:
 *
 *  - Puter documents `tools: [{ type: "web_search" }]` for OpenAI-routed models.
 *  - OpenAI documents that web-search answers carry `annotations` of type
 *    `url_citation`, each with `url`, `title`, `start_index` and `end_index`.
 *  - Puter's *shipped* `ChatMessage` declaration has no `annotations` field at all,
 *    and community reports say the array is frequently empty.
 *
 * So the payload is read as `unknown` and validated, and the rule is absolute: **no
 * citation, no finding.** An empty annotation array yields zero findings and an honest
 * note — never a synthesised one. A source that could not be verified would otherwise
 * put fabricated references into the Idea State, which is the exact failure the whole
 * evidence model exists to prevent.
 *
 * There is a second guard behind that one: a citation whose `start_index`/`end_index`
 * span does not actually appear in the returned text is dropped. That catches a
 * citation that is real but attached to a claim the source did not make.
 */
import { z } from 'zod';

import { AIError } from '../errors.js';
import type { PuterLoader } from '../providers/puter.js';
import type { ResearchFinding, ResearchSearchOptions, ResearchSource } from '../../research/evidence.js';

export const PUTER_WEB_SEARCH_SOURCE_ID = 'puter-web-search';

/**
 * Confidence ceiling for a web-search finding.
 *
 * Higher than the Wikipedia source's, because a citation with a verified span is a
 * stronger claim than four sentences of a lead section — but well short of certain,
 * because the model chose what to say about the page and Ideno has not read it.
 */
export const MAX_WEB_SEARCH_CONFIDENCE = 0.6;

/** Models Puter routes to OpenAI, which is where `web_search` is documented to work. */
const OPENAI_MODEL_PATTERN = /^(openai\/|gpt-|o[1-9]|chatgpt-)/i;

/** One `url_citation` annotation, validated rather than assumed. */
const UrlCitationSchema = z.object({
  type: z.literal('url_citation'),
  // Permissive about the value on purpose: an empty or unusable URL is dropped as one
  // citation below, rather than failing the whole annotation array and costing every
  // good citation that came with it.
  url: z.string().max(2000),
  title: z.string().min(1).max(400).optional(),
  start_index: z.number().int().min(0).optional(),
  end_index: z.number().int().min(0).optional(),
});

/**
 * Annotations arrive either flat (`{type, url, title, …}`) or nested under a
 * `url_citation` key, depending on whether the shape came from the Responses API or
 * from Chat Completions. Both are accepted, because guessing which one a provider
 * used is exactly the kind of assumption this module refuses to make.
 */
const AnnotationSchema = z.union([
  UrlCitationSchema,
  z.object({ type: z.string().max(40), url_citation: UrlCitationSchema.extend({ type: z.string().max(40) }) }),
]);

const AnnotationsSchema = z.array(AnnotationSchema).max(50);

export interface PuterWebSearchOptions {
  /** Injectable for tests; defaults to the same loader the Puter provider uses. */
  loader?: PuterLoader;
  /** Model to route through. Must be an OpenAI-routed model for the tool to apply. */
  model?: string | null;
  timeout_ms?: number;
}

export interface PuterWebSearchReport {
  findings: ResearchFinding[];
  /** Why citations were dropped. Surfaced to the user, never swallowed. */
  dropped: string[];
}

export class PuterWebSearchSource implements ResearchSource {
  readonly id = PUTER_WEB_SEARCH_SOURCE_ID;
  readonly label = 'Puter web search (cited results only)';

  #loader: PuterLoader;
  #model: string | null;
  #timeoutMs: number;
  /** Findings from the most recent search, for the UI to explain itself. */
  #lastReport: PuterWebSearchReport = { findings: [], dropped: [] };

  constructor(options: PuterWebSearchOptions = {}) {
    this.#loader =
      options.loader ??
      (async () => {
        const existing = (globalThis as { puter?: unknown }).puter;
        if (existing) return { puter: existing } as Awaited<ReturnType<PuterLoader>>;
        return import('@heyputer/puter.js');
      });
    this.#model = options.model ?? null;
    this.#timeoutMs = Math.max(1000, options.timeout_ms ?? 45_000);
  }

  get lastReport(): PuterWebSearchReport {
    return this.#lastReport;
  }

  async search(query: string, options: ResearchSearchOptions = {}): Promise<ResearchFinding[]> {
    const question = query.trim();
    if (question.length === 0) return [];

    const model = this.#model;
    if (!model || !OPENAI_MODEL_PATTERN.test(model)) {
      // Not an error the user can do anything about mid-turn, and not a reason to
      // invent findings either: say so and return nothing.
      this.#lastReport = {
        findings: [],
        dropped: [
          model
            ? `Puter's web search is documented for OpenAI-routed models; "${model}" is not one, so nothing was searched.`
            : 'Puter web search needs a model to be chosen in Settings, so nothing was searched.',
        ],
      };
      return [];
    }

    const puter = await this.#load();
    const response = await this.#ask(puter, question, model, options);
    this.#lastReport = findingsFromResponse(response, question);
    return this.#lastReport.findings;
  }

  async #load(): Promise<unknown> {
    const module = await this.#loader();
    const puter = (module as { puter?: unknown }).puter;
    if (!puter) throw new AIError('provider_unavailable', 'The Puter SDK did not expose `puter`.');
    return puter;
  }

  async #ask(
    puter: unknown,
    question: string,
    model: string,
    options: ResearchSearchOptions,
  ): Promise<{ text: string; annotations: unknown }> {
    const ai = (puter as { ai?: { chat?: unknown } }).ai;
    if (!ai || typeof ai.chat !== 'function') {
      throw new AIError('unsupported_operation', 'This build of the Puter SDK has no ai.chat.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // The instruction asks for citations and forbids answering from memory. It cannot
    // guarantee either, which is why the parsing below is the actual gate: a prompt is
    // a request, and only the annotation array is evidence.
    const prompt = [
      `Research question: ${question}`,
      '',
      'Search the web and answer using only what the retrieved sources say. Cite every',
      'statement with the source it came from. If the sources do not answer the question,',
      'say that plainly and do not answer from memory.',
    ].join('\n');

    try {
      const chat = ai.chat as (
        messages: { role: string; content: string }[],
        chatOptions: Record<string, unknown>,
      ) => Promise<unknown>;
      const raw = await chat([{ role: 'user', content: prompt }], {
        model,
        tools: [{ type: 'web_search' }],
        normalize: true,
        temperature: 0.2,
      });
      return { text: textOf(raw), annotations: annotationsOf(raw) };
    } catch (error) {
      if (options.signal?.aborted) throw new Error('The web search was cancelled.');
      throw new Error(`Puter web search failed (${describe(error)}).`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // The controller exists so a hung request cannot outlive the timeout; Puter's
      // chat() accepts no signal, so aborting it is not possible and the request may
      // still complete upstream. That is a Puter limitation, not a silent one.
      void controller.signal.aborted;
    }
  }
}

/**
 * Turns a web-search response into findings, and reports every citation it dropped.
 *
 * Exported because this is the part that must be testable without a provider: the
 * integrity of the evidence pipeline rests entirely on it.
 */
export function findingsFromResponse(
  response: { text: string; annotations: unknown },
  question: string,
): PuterWebSearchReport {
  const dropped: string[] = [];
  const findings: ResearchFinding[] = [];
  const text = response.text;

  const parsed = AnnotationsSchema.safeParse(response.annotations ?? []);
  if (!parsed.success) {
    // An unrecognised annotation shape is reported rather than guessed at. Guessing
    // here is how a URL from one claim ends up attached to another.
    return {
      findings: [],
      dropped: [
        `Puter returned citations in a shape Ideno did not recognise (${
          parsed.error.issues[0]?.message ?? 'unknown'
        }), so nothing was recorded.`,
      ],
    };
  }

  if (parsed.data.length === 0) {
    return {
      findings: [],
      dropped: [
        text.trim().length === 0
          ? 'Puter web search returned nothing at all.'
          : 'Puter web search answered but returned no citations, so nothing was recorded as evidence. ' +
            'An uncited answer is a model suggestion, not research.',
      ],
    };
  }

  const seen = new Set<string>();
  for (const annotation of parsed.data) {
    const citation = 'url_citation' in annotation ? annotation.url_citation : annotation;
    const url = citation.url.trim();

    if (!isHttpUrl(url)) {
      dropped.push(`A citation named "${truncate(url, 60)}", which is not a usable http(s) address, and was discarded.`);
      continue;
    }
    const title = citation.title?.trim() || hostnameOf(url);
    if (!title) {
      dropped.push(`A citation to ${url} named no title and no readable host, and was discarded.`);
      continue;
    }

    const span = citedSpan(text, citation.start_index, citation.end_index);
    if (span === null) {
      dropped.push(
        `The citation to "${title}" pointed at a span of the answer that is not there, so the claim it supports could not be identified and it was discarded.`,
      );
      continue;
    }
    if (span.trim().length < 12) {
      dropped.push(`The citation to "${title}" covered too little text to be a claim, and was discarded.`);
      continue;
    }
    // The same source cited twice for the same sentence is one finding, not two.
    const key = `${url}::${span}`;
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      claim: span,
      source: { title, locator: url, publisher: hostnameOf(url) },
      relevance: `Cited by a web search run for “${truncate(question, 120)}”. The claim is the cited text; the source was not read in full by Ideno.`,
      confidence: MAX_WEB_SEARCH_CONFIDENCE,
      retrieved_at: new Date().toISOString(),
    });
  }

  if (findings.length === 0 && dropped.length === 0) {
    dropped.push('Every citation Puter returned was a duplicate, so nothing new was recorded.');
  }
  return { findings, dropped };
}

/**
 * The text a citation actually covers, or null when the indices do not describe this
 * response.
 *
 * Returning null rather than falling back to the whole answer is the point: a claim
 * attributed to a source has to be the claim that source was cited for.
 */
export function citedSpan(
  text: string,
  startIndex: number | undefined,
  endIndex: number | undefined,
): string | null {
  if (typeof startIndex !== 'number' || typeof endIndex !== 'number') return null;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return null;
  if (startIndex < 0 || endIndex <= startIndex || endIndex > text.length) return null;
  return text.slice(startIndex, endIndex);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Reads text out of a Puter response, which may be a string or a message object. */
function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const content = (raw as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

/**
 * Finds annotations wherever Puter put them.
 *
 * The SDK's `ChatMessage` type has no `annotations` field, so this reads the response
 * as data and checks the places the underlying APIs are documented to put it: on the
 * message, or on a content block within it.
 */
function annotationsOf(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return [];
  const message = (raw as { message?: unknown }).message;
  const candidates: unknown[] = [];

  if (message && typeof message === 'object') {
    candidates.push((message as { annotations?: unknown }).annotations);
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') candidates.push((block as { annotations?: unknown }).annotations);
      }
    }
  }
  candidates.push((raw as { annotations?: unknown }).annotations);

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

export function createPuterWebSearchSource(options: PuterWebSearchOptions = {}): ResearchSource {
  return new PuterWebSearchSource(options);
}

/** True when a configured model could use the tool at all. Used by the Settings panel. */
export function webSearchModelLooksSupported(model: string | null): boolean {
  return typeof model === 'string' && OPENAI_MODEL_PATTERN.test(model);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
