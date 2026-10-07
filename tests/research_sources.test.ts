/**
 * Research sources (B4).
 *
 * The property under test is the one the whole evidence model rests on: **a source
 * records only what it retrieved, with a locator a human can follow.** Every test here
 * is a way that could go wrong — an empty citation list, a citation with no URL, a span
 * that is not in the answer, a transport failure, a response in an unexpected shape —
 * and in each case the expected result is *no finding*, plus a sentence saying why.
 *
 * Both sources are tested with injected transport (a fake `fetch`, a fake SDK), because
 * neither `en.wikipedia.org` nor `api.puter.com` is reachable from this environment. That
 * is stated in the changelog rather than papered over: the parsing is verified, the live
 * services are not.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_SUMMARY_CONFIDENCE,
  WikipediaSource,
  cleanExtract,
  permalink,
} from '../src/research/sources/wikipedia.js';
import {
  MAX_WEB_SEARCH_CONFIDENCE,
  PuterWebSearchSource,
  citedSpan,
  findingsFromResponse,
  isHttpUrl,
  webSearchModelLooksSupported,
} from '../src/ai/research/puter_web_search.js';
import { ResearchRegistry, findingsToEvidenceDrafts, runResearch } from '../src/research/evidence.js';
import { createResearchSources, syncResearchSources } from '../src/ai/factory.js';
import { SettingsSchema } from '../src/ai/settings.js';
import type { ResearchItem } from '../src/core/schemas/index.js';

const QUESTION: ResearchItem = {
  id: 'res_1',
  question: 'How much water do container herbs need per day?',
  priority: 'high',
  status: 'open',
  rationale: null,
  evidence_refs: [],
  origin_operation: 'research',
  source_message_id: null,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: null,
};

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(config: {
  body?: unknown;
  status?: number;
  notJson?: boolean;
  throwError?: Error;
}): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (config.throwError) throw config.throwError;
    const status = config.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (config.notJson) throw new Error('unexpected token');
        return config.body;
      },
      async text() {
        return JSON.stringify(config.body ?? {});
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function wikiResponse(pages: unknown[]): unknown {
  return { batchcomplete: true, query: { searchinfo: { totalhits: pages.length }, pages } };
}

describe('WikipediaSource', () => {
  it('asks the documented browser endpoint anonymously', async () => {
    const { impl, calls } = fakeFetch({
      body: wikiResponse([
        {
          pageid: 89727,
          title: 'Drip irrigation',
          fullurl: 'https://en.wikipedia.org/wiki/Drip_irrigation',
          lastrevid: 1234567890,
          touched: '2026-09-01T10:00:00Z',
          extract: 'Drip irrigation is a form of irrigation that delivers water slowly to the roots of plants.',
        },
      ]),
    });
    const source = new WikipediaSource({ fetch_impl: impl });
    const findings = await source.search(QUESTION.question, { limit: 3 });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://en.wikipedia.org/w/api.php');
    // origin=* is what makes this an anonymous cross-origin request, as documented.
    expect(url.searchParams.get('origin')).toBe('*');
    expect(url.searchParams.get('action')).toBe('query');
    expect(url.searchParams.get('generator')).toBe('search');
    expect(url.searchParams.get('gsrsearch')).toBe(QUESTION.question);
    expect(url.searchParams.get('explaintext')).toBe('1');
    expect(url.searchParams.get('inprop')).toBe('url');
    // No credentials of any kind are attached.
    expect(calls[0]!.init?.headers).toEqual({ Accept: 'application/json' });
    expect(calls[0]!.url).not.toMatch(/key|token|auth/i);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.source.title).toBe('Drip irrigation');
    expect(findings[0]!.source.publisher).toBe('Wikipedia (en)');
    // A permanent citation: the exact revision the extract came from.
    expect(findings[0]!.source.locator).toBe(
      'https://en.wikipedia.org/wiki/Drip_irrigation?oldid=1234567890',
    );
    expect(findings[0]!.claim).toContain('delivers water slowly');
    expect(findings[0]!.confidence).toBe(MAX_SUMMARY_CONFIDENCE);
    expect(findings[0]!.relevance).toMatch(/Only the first \d+ sentences were read/);
  });

  it('falls back to the article URL when no revision is reported', async () => {
    const { impl } = fakeFetch({
      body: wikiResponse([
        { title: 'Hydroponics', fullurl: 'https://en.wikipedia.org/wiki/Hydroponics', extract: 'Hydroponics grows plants without soil.' },
      ]),
    });
    const findings = await new WikipediaSource({ fetch_impl: impl }).search('hydroponics');
    expect(findings[0]!.source.locator).toBe('https://en.wikipedia.org/wiki/Hydroponics');
  });

  it('records nothing for a page with no readable extract', async () => {
    const { impl } = fakeFetch({
      body: wikiResponse([
        { title: 'Disambiguation', fullurl: 'https://en.wikipedia.org/wiki/Foo' },
        { title: '', fullurl: 'https://en.wikipedia.org/wiki/Bar', extract: 'Some text.' },
        { title: 'No URL', extract: 'Some text.' },
      ]),
    });
    const findings = await new WikipediaSource({ fetch_impl: impl }).search('anything');
    expect(findings).toEqual([]);
  });

  it('reports zero results rather than inventing a page', async () => {
    const { impl } = fakeFetch({ body: wikiResponse([]) });
    const findings = await new WikipediaSource({ fetch_impl: impl }).search('a thing nobody wrote about');
    expect(findings).toEqual([]);
  });

  it('throws on an HTTP failure, so the caller records a failure and not silence', async () => {
    const { impl } = fakeFetch({ status: 503, body: {} });
    await expect(new WikipediaSource({ fetch_impl: impl }).search('water')).rejects.toThrow(/HTTP 503/);
  });

  it('throws on a transport failure', async () => {
    const { impl } = fakeFetch({ throwError: new Error('network unreachable') });
    await expect(new WikipediaSource({ fetch_impl: impl }).search('water')).rejects.toThrow(
      /could not be reached.*network unreachable/,
    );
  });

  it('throws on a reply that is not JSON', async () => {
    const { impl } = fakeFetch({ notJson: true });
    await expect(new WikipediaSource({ fetch_impl: impl }).search('water')).rejects.toThrow(/not valid JSON/);
  });

  it('reports an API error rather than treating it as no results', async () => {
    const { impl } = fakeFetch({
      body: { error: { code: 'ratelimited', info: 'You have exceeded the rate limit.' } },
    });
    await expect(new WikipediaSource({ fetch_impl: impl }).search('water')).rejects.toThrow(/ratelimited/);
  });

  it('reports an unrecognised response shape instead of guessing at it', async () => {
    const { impl } = fakeFetch({ body: { query: { pages: 'not an array' } } });
    await expect(new WikipediaSource({ fetch_impl: impl }).search('water')).rejects.toThrow(/unrecognised format/);
  });

  it('honours the caller limit and caps it', async () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      title: `Page ${index}`,
      fullurl: `https://en.wikipedia.org/wiki/Page_${index}`,
      extract: `Text for page ${index}.`,
    }));
    const { impl, calls } = fakeFetch({ body: wikiResponse(pages) });
    const source = new WikipediaSource({ fetch_impl: impl });

    expect(await source.search('q', { limit: 2 })).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get('gsrlimit')).toBe('2');

    // A caller cannot ask for more than the source is willing to hand over, because
    // every finding becomes a change the user has to review.
    expect(await source.search('q', { limit: 99 })).toHaveLength(5);
    expect(new URL(calls[1]!.url).searchParams.get('gsrlimit')).toBe('5');
  });

  it('does nothing for an empty question', async () => {
    const { impl, calls } = fakeFetch({ body: wikiResponse([]) });
    expect(await new WikipediaSource({ fetch_impl: impl }).search('   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('respects cancellation', async () => {
    const controller = new AbortController();
    const impl = (async () => {
      controller.abort();
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    await expect(
      new WikipediaSource({ fetch_impl: impl }).search('water', { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it('uses another language edition when asked', async () => {
    const { impl, calls } = fakeFetch({ body: wikiResponse([]) });
    await new WikipediaSource({ fetch_impl: impl, language: 'de' }).search('wasser');
    expect(new URL(calls[0]!.url).host).toBe('de.wikipedia.org');
  });

  it('refuses a language code that is not a language code', async () => {
    const { impl, calls } = fakeFetch({ body: wikiResponse([]) });
    // A language setting is used to build a hostname, so it is a URL-injection surface.
    await new WikipediaSource({ fetch_impl: impl, language: 'evil.example.com/' }).search('x');
    const host = new URL(calls[0]!.url).host;
    expect(host.endsWith('wikipedia.org')).toBe(true);
    expect(host).not.toContain('evil.example.com');
  });
});

describe('Wikipedia helpers', () => {
  it('builds a permanent link only when it can', () => {
    expect(permalink('https://en.wikipedia.org/wiki/A', 42)).toBe('https://en.wikipedia.org/wiki/A?oldid=42');
    expect(permalink('https://en.wikipedia.org/wiki/A', undefined)).toBe('https://en.wikipedia.org/wiki/A');
    expect(permalink('https://en.wikipedia.org/wiki/A', 0)).toBe('https://en.wikipedia.org/wiki/A');
    // Never append to a URL that already has a query: two oldids would cite something
    // other than what was read.
    expect(permalink('https://en.wikipedia.org/wiki/A?x=1', 42)).toBe('https://en.wikipedia.org/wiki/A?x=1');
    expect(permalink('not a url', 42)).toBe('not a url');
  });

  it('strips markup and citation brackets from an extract', () => {
    expect(cleanExtract('Water<sup>[1]</sup> is <span class="searchmatch">wet</span>.')).toBe('Water is wet.');
    expect(cleanExtract(undefined)).toBe('');
    expect(cleanExtract('  many\n\n  spaces  ')).toBe('many spaces');
    // Bounded, because this text goes into a state field with a maximum length.
    expect(cleanExtract('x'.repeat(5000)).length).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Puter web search
// ---------------------------------------------------------------------------

const ANSWER =
  'Container herbs generally need 250 to 500 mL of water per day in warm weather. ' +
  'Overwatering causes root rot more often than underwatering kills the plant.';

function annotations(_text: string, spans: [number, number][]): unknown[] {
  return spans.map(([start, end], index) => ({
    type: 'url_citation',
    url: `https://example.org/source-${index}`,
    title: `Source ${index}`,
    start_index: start,
    end_index: end,
  }));
}

describe('findingsFromResponse', () => {
  it('records a finding for each citation whose span is really in the answer', () => {
    const report = findingsFromResponse(
      { text: ANSWER, annotations: annotations(ANSWER, [[0, 74], [75, ANSWER.length]]) },
      QUESTION.question,
    );
    expect(report.dropped).toEqual([]);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]!.claim).toBe(ANSWER.slice(0, 74));
    expect(report.findings[0]!.source.locator).toBe('https://example.org/source-0');
    expect(report.findings[0]!.source.publisher).toBe('example.org');
    expect(report.findings[0]!.confidence).toBe(MAX_WEB_SEARCH_CONFIDENCE);
  });

  it('records nothing when the answer carries no citations', async () => {
    // The single most likely real-world outcome, and the one that must not be
    // dressed up: an uncited answer is a model suggestion, not research.
    const report = findingsFromResponse({ text: ANSWER, annotations: [] }, QUESTION.question);
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/no citations/);
    expect(report.dropped.join(' ')).toMatch(/not research/);
  });

  it('records nothing when the answer is empty and says so', () => {
    const report = findingsFromResponse({ text: '', annotations: [] }, 'q');
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/returned nothing at all/);
  });

  it('drops a citation with no usable URL', () => {
    const report = findingsFromResponse(
      {
        text: ANSWER,
        annotations: [
          { type: 'url_citation', url: 'javascript:alert(1)', title: 'Bad', start_index: 0, end_index: 20 },
          { type: 'url_citation', url: 'not a url', title: 'Worse', start_index: 0, end_index: 20 },
          { type: 'url_citation', url: '', title: 'Empty', start_index: 0, end_index: 20 },
        ],
      },
      'q',
    );
    expect(report.findings).toEqual([]);
    expect(report.dropped).toHaveLength(3);
    expect(report.dropped.join(' ')).toMatch(/not a usable http\(s\) address/);
  });

  it('drops a citation whose span is not in the answer', () => {
    // A real URL attached to text the source never said is worse than no citation at
    // all, because it looks verifiable.
    const report = findingsFromResponse(
      {
        text: ANSWER,
        annotations: [
          { type: 'url_citation', url: 'https://example.org/a', title: 'A', start_index: 0, end_index: 5000 },
          { type: 'url_citation', url: 'https://example.org/b', title: 'B', start_index: 40, end_index: 10 },
          { type: 'url_citation', url: 'https://example.org/c', title: 'C' },
        ],
      },
      'q',
    );
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/span of the answer that is not there/);
  });

  it('drops a citation covering too little text to be a claim', () => {
    const report = findingsFromResponse(
      { text: ANSWER, annotations: [{ type: 'url_citation', url: 'https://example.org/a', title: 'A', start_index: 0, end_index: 4 }] },
      'q',
    );
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/too little text/);
  });

  it('accepts the nested annotation shape as well as the flat one', () => {
    const nested = [
      {
        type: 'url_citation',
        url_citation: { type: 'url_citation', url: 'https://example.org/n', title: 'Nested', start_index: 0, end_index: 60 },
      },
    ];
    const report = findingsFromResponse({ text: ANSWER, annotations: nested }, 'q');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.source.locator).toBe('https://example.org/n');
  });

  it('uses the host as a title when the citation names none', () => {
    const report = findingsFromResponse(
      {
        text: ANSWER,
        annotations: [{ type: 'url_citation', url: 'https://gardening.example.org/guide', start_index: 0, end_index: 60 }],
      },
      'q',
    );
    expect(report.findings[0]!.source.title).toBe('gardening.example.org');
  });

  it('collapses a duplicate citation of the same sentence', () => {
    // Same source, same span: one finding, not two. Two rows for one fact would make
    // the evidence list look better supported than it is.
    const citation = { type: 'url_citation', url: 'https://example.org/same', title: 'Same', start_index: 0, end_index: 74 };
    const report = findingsFromResponse({ text: ANSWER, annotations: [citation, { ...citation }] }, 'q');
    expect(report.findings).toHaveLength(1);
  });

  it('reports an unrecognised annotation shape instead of guessing', () => {
    const report = findingsFromResponse({ text: ANSWER, annotations: [{ url: 'https://example.org' }] }, 'q');
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/did not recognise/);
  });

  it('treats a missing annotations field as none', () => {
    const report = findingsFromResponse({ text: ANSWER, annotations: undefined }, 'q');
    expect(report.findings).toEqual([]);
    expect(report.dropped.join(' ')).toMatch(/no citations/);
  });
});

describe('PuterWebSearchSource', () => {
  function fakeSdk(config: {
    response?: unknown;
    error?: Error;
  }): { puter: unknown; calls: { messages: unknown; options: Record<string, unknown> }[] } {
    const calls: { messages: unknown; options: Record<string, unknown> }[] = [];
    const puter = {
      ai: {
        async chat(messages: unknown, options: Record<string, unknown>) {
          calls.push({ messages, options });
          if (config.error) throw config.error;
          return config.response;
        },
      },
    };
    return { puter, calls };
  }

  it('asks for the web_search tool and reads citations off the message', async () => {
    const sdk = fakeSdk({
      response: {
        message: { content: ANSWER, annotations: annotations(ANSWER, [[0, 74]]) },
        finish_reason: 'stop',
      },
    });
    const source = new PuterWebSearchSource({
      loader: async () => ({ puter: sdk.puter }) as never,
      model: 'openai/gpt-5.6-luna',
    });

    const findings = await source.search(QUESTION.question);
    expect(findings).toHaveLength(1);
    expect(sdk.calls[0]!.options).toMatchObject({ model: 'openai/gpt-5.6-luna', tools: [{ type: 'web_search' }] });
    // The prompt asks for citations and forbids answering from memory — but the gate
    // is the parsing, not the instruction.
    expect(JSON.stringify(sdk.calls[0]!.messages)).toMatch(/do not answer from memory/);
  });

  it('reads annotations from a content block when they are not on the message', async () => {
    const sdk = fakeSdk({
      response: {
        message: {
          content: [
            { type: 'output_text', text: ANSWER, annotations: annotations(ANSWER, [[0, 74]]) },
          ],
        },
      },
    });
    const source = new PuterWebSearchSource({
      loader: async () => ({ puter: sdk.puter }) as never,
      model: 'gpt-5-nano',
    });
    expect(await source.search('q')).toHaveLength(1);
  });

  it('returns nothing, with a reason, for a model the tool is not documented for', async () => {
    const sdk = fakeSdk({ response: { message: { content: ANSWER } } });
    const source = new PuterWebSearchSource({
      loader: async () => ({ puter: sdk.puter }) as never,
      model: 'claude-sonnet-5',
    });
    expect(await source.search('q')).toEqual([]);
    // It must not have called the model at all: the tool would have been ignored and
    // the answer would have looked like an uncited response.
    expect(sdk.calls).toHaveLength(0);
    expect(source.lastReport.dropped.join(' ')).toMatch(/not one, so nothing was searched/);
  });

  it('returns nothing, with a reason, when no model is configured', async () => {
    const sdk = fakeSdk({ response: {} });
    const source = new PuterWebSearchSource({ loader: async () => ({ puter: sdk.puter }) as never, model: null });
    expect(await source.search('q')).toEqual([]);
    expect(source.lastReport.dropped.join(' ')).toMatch(/needs a model to be chosen/);
    expect(sdk.calls).toHaveLength(0);
  });

  it('reports a failed call rather than returning silence', async () => {
    const sdk = fakeSdk({ error: new Error('upstream refused') });
    const source = new PuterWebSearchSource({
      loader: async () => ({ puter: sdk.puter }) as never,
      model: 'gpt-5-nano',
    });
    await expect(source.search('q')).rejects.toThrow(/upstream refused/);
  });

  it('reports an SDK with no chat method', async () => {
    const source = new PuterWebSearchSource({
      loader: async () => ({ puter: { ai: {} } }) as never,
      model: 'gpt-5-nano',
    });
    await expect(source.search('q')).rejects.toThrow(/no ai\.chat/);
  });

  it('reports an SDK that does not expose puter at all', async () => {
    const source = new PuterWebSearchSource({ loader: async () => ({}) as never, model: 'gpt-5-nano' });
    await expect(source.search('q')).rejects.toThrow(/did not expose `puter`/);
  });

  it('recognises the models the tool is documented for', () => {
    for (const model of ['openai/gpt-5.6-luna', 'gpt-5-nano', 'o4-mini', 'chatgpt-4o-latest']) {
      expect(webSearchModelLooksSupported(model), model).toBe(true);
    }
    for (const model of ['claude-sonnet-5', 'gemini-3.5-flash', 'llama-3.3', null, '']) {
      expect(webSearchModelLooksSupported(model), String(model)).toBe(false);
    }
  });
});

describe('citation helpers', () => {
  it('accepts only http and https', () => {
    expect(isHttpUrl('https://example.org/a')).toBe(true);
    expect(isHttpUrl('http://example.org/a')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'example.org', '']) {
      expect(isHttpUrl(bad), bad).toBe(false);
    }
  });

  it('validates a cited span strictly', () => {
    const text = 'abcdefghij';
    expect(citedSpan(text, 0, 3)).toBe('abc');
    expect(citedSpan(text, 0, 0)).toBeNull();
    expect(citedSpan(text, 5, 2)).toBeNull();
    expect(citedSpan(text, -1, 3)).toBeNull();
    expect(citedSpan(text, 0, 99)).toBeNull();
    expect(citedSpan(text, 0, undefined)).toBeNull();
    expect(citedSpan(text, 1.5, 4)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('research source configuration', () => {
  it('registers Wikipedia by default and nothing else', () => {
    const sources = createResearchSources(SettingsSchema.parse({ provider_id: 'scripted' }));
    expect(sources.map((source) => source.id)).toEqual(['wikipedia']);
  });

  it('registers the web search source only when asked', () => {
    const sources = createResearchSources(
      SettingsSchema.parse({ provider_id: 'puter', research: { puter_web_search: true } }),
    );
    expect(sources.map((source) => source.id)).toEqual(['wikipedia', 'puter-web-search']);
  });

  it('can be switched off entirely', () => {
    const sources = createResearchSources(
      SettingsSchema.parse({ research: { wikipedia: false, puter_web_search: false } }),
    );
    expect(sources).toEqual([]);
  });

  it('syncing removes a source the user switched off and keeps a plugin source', () => {
    const registry = new ResearchRegistry();
    const pluginSource = { id: 'a-plugin', label: 'Plugin', search: async () => [] };
    registry.register(pluginSource);

    syncResearchSources(registry, SettingsSchema.parse({ research: { wikipedia: true } }));
    expect(registry.list().map((source) => source.id)).toContain('wikipedia');

    // Switching it off removes it on the next turn, not the next session.
    syncResearchSources(registry, SettingsSchema.parse({ research: { wikipedia: false } }));
    expect(registry.get('wikipedia')).toBeNull();
    // And a third-party plugin survives a settings change: this function manages only
    // the sources it knows about.
    expect(registry.get('a-plugin')).not.toBeNull();
  });
});

describe('findings reaching the Idea State', () => {
  it('both sources produce drafts that Core will grant evidence status', () => {
    const findings = [
      {
        claim: 'Drip irrigation reduces water use compared with sprinklers.',
        source: { title: 'Drip irrigation', locator: 'https://en.wikipedia.org/wiki/Drip_irrigation?oldid=1', publisher: 'Wikipedia (en)' },
        relevance: 'Lead section, retrieved for the question.',
        confidence: MAX_SUMMARY_CONFIDENCE,
        retrieved_at: '2026-04-01T00:00:00.000Z',
      },
    ];
    const { drafts, dropped } = findingsToEvidenceDrafts(findings);
    expect(dropped).toEqual([]);
    expect(drafts[0]!.origin).toBe('research_source');
    expect(drafts[0]!.notes).toContain('Retrieved');
  });

  it('a retrieved finding survives the run-and-convert path end to end', async () => {
    const { impl } = fakeFetch({
      body: wikiResponse([
        {
          title: 'Drip irrigation',
          fullurl: 'https://en.wikipedia.org/wiki/Drip_irrigation',
          lastrevid: 7,
          extract: 'Drip irrigation delivers water slowly to plant roots.',
        },
      ]),
    });
    const registry = new ResearchRegistry();
    registry.register(new WikipediaSource({ fetch_impl: impl }));

    const outcome = await runResearch(registry, QUESTION, { limit: 2 });
    expect(outcome.failures).toEqual([]);
    const { drafts } = findingsToEvidenceDrafts(outcome.findings);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.source.locator).toContain('oldid=7');
  });

  it('one source failing does not discard the other', async () => {
    const broken = fakeFetch({ throwError: new Error('offline') });
    const registry = new ResearchRegistry();
    registry.register(new WikipediaSource({ fetch_impl: broken.impl }));
    registry.register({
      id: 'second',
      label: 'Second',
      search: async () => [
        {
          claim: 'A claim from the second source.',
          source: { title: 'Second', locator: 'https://second.example.org/x' },
          relevance: 'r',
          confidence: 0.5,
        },
      ],
    });

    const outcome = await runResearch(registry, QUESTION);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.message).toMatch(/offline/);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.source.locator).toBe('https://second.example.org/x');
  });
});
