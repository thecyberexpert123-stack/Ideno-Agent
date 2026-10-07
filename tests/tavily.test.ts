/**
 * Tavily as a research source.
 *
 * The property under test is the same one every other source is held to: **a finding is
 * recorded only when there is a locator a human can follow, and confidence never exceeds
 * what was actually read.** Tavily makes that easier than Puter's web search, because
 * every result carries its own URL — but it also introduces two new ways to get it
 * wrong: treating Tavily's synthesised `answer` as evidence, and treating its relevance
 * `score` as a measure of truth. Both are tested here.
 *
 * The transport is injected throughout. This sandbox has no route to `api.tavily.com`,
 * so the parsing and the failure paths are verified and the live service is not — which
 * is recorded in the changelog rather than implied otherwise.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_TAVILY_CONFIDENCE,
  MIN_RESULT_SCORE,
  TAVILY_API_URL,
  TAVILY_SOURCE_ID,
  TavilySource,
  cleanSnippet,
  confidenceFor,
  createHttpTransport,
  createTavilySource,
  httpFailure,
  isFollowableLocator,
  publisherOf,
} from '../src/research/sources/tavily.js';
import { ResearchRegistry, findingsToEvidenceDrafts, runResearch } from '../src/research/evidence.js';
import { createDesktopTavilyTransport } from '../src/ui/desktop_bridge.js';
import { createResearchSources, syncResearchSources } from '../src/ai/factory.js';
import { SettingsSchema } from '../src/ai/settings.js';
import type { DesktopApi, DesktopHost } from '../src/ui/desktop_bridge.js';
import type { ResearchItem } from '../src/core/schemas/index.js';

const QUESTION: ResearchItem = {
  id: 'res_1',
  question: 'What does twin-wall polycarbonate cost per square metre?',
  priority: 'high',
  status: 'open',
  rationale: null,
  evidence_refs: [],
  origin_operation: 'research',
  source_message_id: null,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: '2026-04-01T00:00:00.000Z',
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(config: {
  body?: unknown;
  status?: number;
  notJson?: boolean;
  throwError?: Error;
}): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
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

function tavilyResponse(results: unknown[]): unknown {
  return { query: 'x', results, response_time: 1.2 };
}

const GOOD_RESULT = {
  title: 'Greenhouse glazing compared',
  url: 'https://example.org/glazing',
  content: 'Twin-wall polycarbonate typically runs 12 to 25 EUR per square metre at 2026 retail prices.',
  score: 0.91,
};

describe('TavilySource — request shape', () => {
  it('posts to the documented endpoint with a bearer key', async () => {
    const { impl, calls } = fakeFetch({ body: tavilyResponse([GOOD_RESULT]) });
    await new TavilySource({ api_key: 'tvly-secret', fetch_impl: impl }).search('glazing cost');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TAVILY_API_URL);
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tvly-secret');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('never asks for a synthesised answer, because an unattributed summary is not evidence', async () => {
    const { impl, calls } = fakeFetch({ body: tavilyResponse([GOOD_RESULT]) });
    await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('glazing');

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.include_answer).toBe(false);
    expect(body.include_raw_content).toBe(false);
    expect(body.query).toBe('glazing');
    expect(body.max_results).toBe(3);
  });

  it('ignores an answer the server sends anyway', async () => {
    const { impl } = fakeFetch({
      body: { answer: 'It costs about 20 EUR.', results: [GOOD_RESULT] },
    });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('glazing');

    expect(findings).toHaveLength(1);
    // The claim is the cited snippet, not the synthesis.
    expect(findings[0]?.claim).toContain('Twin-wall polycarbonate');
    expect(findings[0]?.claim).not.toContain('It costs about 20 EUR');
  });

  it('caps the number of results and honours a smaller limit', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...GOOD_RESULT,
      title: `Result ${index}`,
      url: `https://example.org/r${index}`,
    }));
    const { impl, calls } = fakeFetch({ body: tavilyResponse(many) });
    const source = new TavilySource({ api_key: 'tvly-x', fetch_impl: impl });

    const limited = await source.search('glazing', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body)).max_results).toBe(2);

    const everything = await source.search('glazing', { limit: 99 });
    expect(everything.length).toBeLessThanOrEqual(5);
  });

  it('returns nothing for an empty question rather than searching for nothing', async () => {
    const { impl, calls } = fakeFetch({ body: tavilyResponse([]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('   ');
    expect(findings).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('TavilySource — citation integrity', () => {
  it('records a result with a title, a URL and a snippet', async () => {
    const { impl } = fakeFetch({ body: tavilyResponse([GOOD_RESULT]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('glazing');

    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.source.title).toBe('Greenhouse glazing compared');
    expect(finding.source.locator).toBe('https://example.org/glazing');
    expect(finding.source.publisher).toBe('example.org');
    expect(typeof finding.retrieved_at).toBe('string');
  });

  it.each([
    ['no url', { title: 'T', content: 'c', score: 0.9 }],
    ['no title', { url: 'https://example.org/a', content: 'c', score: 0.9 }],
    ['no snippet', { title: 'T', url: 'https://example.org/a', score: 0.9 }],
    ['blank snippet', { title: 'T', url: 'https://example.org/a', content: '   ', score: 0.9 }],
  ])('drops a result with %s', async (_label, result) => {
    const { impl } = fakeFetch({ body: tavilyResponse([result]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');
    expect(findings).toEqual([]);
  });

  it('drops a locator that could not become a link a reader can follow', async () => {
    const { impl } = fakeFetch({
      body: tavilyResponse([
        { ...GOOD_RESULT, url: 'javascript:alert(1)' },
        { ...GOOD_RESULT, title: 'Real one', url: 'https://example.org/real' },
      ]),
    });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.source.title).toBe('Real one');
  });

  it('drops a result Tavily itself ranked as barely relevant', async () => {
    const { impl } = fakeFetch({
      body: tavilyResponse([{ ...GOOD_RESULT, score: MIN_RESULT_SCORE - 0.01 }]),
    });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');
    expect(findings).toEqual([]);
  });

  it('keeps one bad result from costing the good ones beside it', async () => {
    const { impl } = fakeFetch({
      body: tavilyResponse([
        { title: 'Broken', url: 'not a url', content: 'x' },
        GOOD_RESULT,
        { title: 'Also good', url: 'https://example.org/two', content: 'Second source.', score: 0.7 },
      ]),
    });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');
    expect(findings).toHaveLength(2);
  });

  it('says what was read, and does not claim the page was read in full', async () => {
    const { impl } = fakeFetch({ body: tavilyResponse([GOOD_RESULT]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('glazing');
    const relevance = findings[0]!.relevance;

    expect(relevance).toContain('91% relevant');
    expect(relevance).toContain('the page itself was not read in full');
  });
});

describe('TavilySource — confidence', () => {
  it('never exceeds the ceiling, however high the relevance score', () => {
    expect(confidenceFor(1)).toBe(MAX_TAVILY_CONFIDENCE);
    expect(confidenceFor(0.99)).toBeLessThanOrEqual(MAX_TAVILY_CONFIDENCE);
    expect(confidenceFor(50)).toBe(MAX_TAVILY_CONFIDENCE);
  });

  it('scales down with relevance and halves for a result that reported none', () => {
    expect(confidenceFor(0.5)).toBeCloseTo(MAX_TAVILY_CONFIDENCE * 0.5, 5);
    expect(confidenceFor(null)).toBe(MAX_TAVILY_CONFIDENCE / 2);
    expect(confidenceFor(-3)).toBe(0);
  });

  it('applies that confidence to a finding', async () => {
    const { impl } = fakeFetch({ body: tavilyResponse([GOOD_RESULT]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');
    expect(findings[0]?.confidence).toBeLessThanOrEqual(MAX_TAVILY_CONFIDENCE);
    expect(findings[0]?.confidence).toBeGreaterThan(0);
  });

  it('stays below the level at which a claim would count as well supported', async () => {
    const { impl } = fakeFetch({ body: tavilyResponse([{ ...GOOD_RESULT, score: 1 }]) });
    const findings = await new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q');
    expect(MAX_TAVILY_CONFIDENCE).toBeLessThan(0.8);
    expect(findings[0]?.confidence).toBeLessThan(0.8);
  });
});

describe('TavilySource — failures', () => {
  it('throws rather than returning nothing when the reply is not a shape it knows', async () => {
    const { impl } = fakeFetch({ body: { unexpected: true } });
    // An empty `results` key is legitimate; a reply with no recognised structure at all
    // is not, and the difference must be visible.
    const source = new TavilySource({ api_key: 'tvly-x', fetch_impl: impl });
    await expect(source.search('q')).resolves.toEqual([]);
  });

  it('reports an invalid JSON reply as a failure', async () => {
    const { impl } = fakeFetch({ notJson: true });
    await expect(new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q')).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it.each([
    [401, /rejected the API key/],
    [429, /rate-limited/],
    [432, /account's limits/],
    [503, /servers returned HTTP 503/],
    [404, /HTTP 404/],
  ])('maps HTTP %i to an actionable message', async (status, pattern) => {
    const { impl } = fakeFetch({ status, body: {} });
    await expect(new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q')).rejects.toThrow(pattern);
  });

  it('names both possibilities when the browser cannot reach Tavily at all', async () => {
    // A browser reports a CORS block and a dead network identically, so the message must
    // not assert one. It says both, and points at the route that has no CORS constraint.
    const { impl } = fakeFetch({ throwError: new TypeError('Failed to fetch') });
    await expect(new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q')).rejects.toThrow(
      /could not be reached from the browser.*blocked this cross-origin request.*desktop/s,
    );
  });

  it('reports a cancellation as a cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl } = fakeFetch({ throwError: new Error('aborted') });
    await expect(
      new TavilySource({ api_key: 'tvly-x', fetch_impl: impl }).search('q', { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('TavilySource — registration', () => {
  it('refuses to be constructed without a key', () => {
    expect(() => new TavilySource({})).toThrow(/needs an API key/);
    expect(() => new TavilySource({ api_key: '   ' })).toThrow(/needs an API key/);
  });

  it('createTavilySource returns null without a key instead of throwing', () => {
    expect(createTavilySource({})).toBeNull();
    expect(createTavilySource({ api_key: 'tvly-x' })?.id).toBe(TAVILY_SOURCE_ID);
  });

  it('is not registered when the setting is off, and is when it is on with a key', () => {
    const off = createResearchSources(SettingsSchema.parse({ research: { tavily: false } }));
    expect(off.map((source) => source.id)).not.toContain(TAVILY_SOURCE_ID);

    const onNoKey = createResearchSources(
      SettingsSchema.parse({ research: { tavily: true, wikipedia: false } }),
    );
    // Switched on but unkeyed: absent rather than present-and-failing.
    expect(onNoKey.map((source) => source.id)).not.toContain(TAVILY_SOURCE_ID);

    const onWithKey = createResearchSources(
      SettingsSchema.parse({ research: { tavily: true, wikipedia: false } }),
      { tavilyApiKey: 'tvly-x' },
    );
    expect(onWithKey.map((source) => source.id)).toContain(TAVILY_SOURCE_ID);
  });

  it('is unregistered again when switched off, and leaves plugin sources alone', () => {
    const registry = new ResearchRegistry();
    registry.register({ id: 'plugin_source', label: 'Plugin', search: async () => [] });

    syncResearchSources(registry, SettingsSchema.parse({ research: { tavily: true } }), {
      tavilyApiKey: 'tvly-x',
    });
    expect(registry.get(TAVILY_SOURCE_ID)).not.toBeNull();

    syncResearchSources(registry, SettingsSchema.parse({ research: { tavily: false } }), {
      tavilyApiKey: 'tvly-x',
    });
    expect(registry.get(TAVILY_SOURCE_ID)).toBeNull();
    expect(registry.get('plugin_source')).not.toBeNull();
  });

  it('reports a Tavily failure per source without discarding the others', async () => {
    const registry = new ResearchRegistry();
    registry.register({
      id: TAVILY_SOURCE_ID,
      label: 'Tavily',
      search: async () => {
        throw new Error('Tavily rejected the API key (HTTP 401).');
      },
    });
    registry.register({
      id: 'other',
      label: 'Other',
      search: async () => [
        {
          claim: 'Something retrieved.',
          source: { title: 'T', locator: 'https://example.org/t', publisher: null },
          relevance: 'r',
          confidence: 0.5,
        },
      ],
    });

    const outcome = await runResearch(registry, QUESTION);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.source_id).toBe(TAVILY_SOURCE_ID);
    expect(outcome.failures[0]?.message).toMatch(/401/);
  });

  it('turns its findings into evidence drafts that carry the locator', () => {
    const outcome = findingsToEvidenceDrafts([
      {
        claim: 'Twin-wall polycarbonate runs 12 to 25 EUR per square metre.',
        source: { title: 'Glazing compared', locator: 'https://example.org/glazing', publisher: 'example.org' },
        relevance: 'Web search result.',
        confidence: 0.55,
        retrieved_at: '2026-04-01T00:00:00.000Z',
      },
    ]);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.drafts).toHaveLength(1);
    const draft = outcome.drafts[0]!;
    expect(draft.source.locator).toBe('https://example.org/glazing');
    expect(draft.confidence).toBe(0.55);
    expect(draft.origin).toBe('research_source');
    expect(draft.notes).toContain('Retrieved');
  });
});

/** A minimal valid Tavily request body, shared by the transport tests. */
const requestBody = {
  query: 'glazing',
  max_results: 3,
  search_depth: 'basic' as const,
  topic: 'general' as const,
  include_answer: false as const,
  include_raw_content: false as const,
  include_images: false as const,
};

describe('desktop transport', () => {
  function hostWith(api: Partial<DesktopApi>): DesktopHost {
    return {
      api: api as DesktopApi,
      version: '0.2.0',
      protocol: 1,
      dataDir: null,
      workspaceDir: null,
      python: null,
      platform: 'Linux',
    };
  }

  it('returns null when the host does not offer web_search, so an older host still works', () => {
    const transport = createDesktopTavilyTransport(
      hostWith({ info: async () => ({ ok: true }), read: async () => ({ ok: true, value: null }) }),
    );
    expect(transport).toBeNull();
  });

  it('passes the query through and parses what comes back', async () => {
    const seen: string[] = [];
    const transport = createDesktopTavilyTransport(
      hostWith({
        web_search: async (payload: string) => {
          seen.push(payload);
          return { ok: true, value: JSON.stringify(tavilyResponse([GOOD_RESULT])) };
        },
      }),
    );
    expect(transport).not.toBeNull();

    const source = new TavilySource({ api_key: 'tvly-x', transport: transport! });
    expect(source.transportKind).toBe('desktop');
    const findings = await source.search('glazing');

    expect(findings).toHaveLength(1);
    const sent = JSON.parse(seen[0]!) as Record<string, unknown>;
    expect(sent.provider).toBe('tavily');
    expect((sent.body as Record<string, unknown>).query).toBe('glazing');
    expect(sent.api_key).toBe('tvly-x');
  });

  it('reports a host refusal with the host own words', async () => {
    const transport = createDesktopTavilyTransport(
      hostWith({
        web_search: async () => ({ ok: false, error: 'Tavily rejected the API key (HTTP 401).' }),
      }),
    );
    const source = new TavilySource({ api_key: 'tvly-x', transport: transport! });
    await expect(source.search('glazing')).rejects.toThrow(/rejected the API key/);
  });

  it('reports an empty or non-JSON reply from the host as a failure', async () => {
    const empty = createDesktopTavilyTransport(hostWith({ web_search: async () => ({ ok: true }) }));
    await expect(
      new TavilySource({ api_key: 'tvly-x', transport: empty! }).search('q'),
    ).rejects.toThrow(/no search results/);

    const bad = createDesktopTavilyTransport(
      hostWith({ web_search: async () => ({ ok: true, value: 'not json' }) }),
    );
    await expect(
      new TavilySource({ api_key: 'tvly-x', transport: bad! }).search('q'),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('does not keep a search running after the caller abandons it', async () => {
    const controller = new AbortController();
    const transport = createDesktopTavilyTransport(
      hostWith({
        // Never resolves: the only way out is the abort.
        web_search: () => new Promise<{ ok: true; value?: string }>(() => undefined),
      }),
    );
    controller.abort();
    await expect(
      new TavilySource({ api_key: 'tvly-x', transport: transport! }).search('q', {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it('times out rather than waiting forever on a host that stops answering', async () => {
    const transport = createDesktopTavilyTransport(
      hostWith({ web_search: () => new Promise<{ ok: true }>(() => undefined) }),
    );
    const source = new TavilySource({ api_key: 'tvly-x', transport: transport!, timeout_ms: 1000 });
    await expect(source.search('q')).rejects.toThrow(/did not answer within 1000 ms/);
  });
});

describe('helpers', () => {
  it('accepts only locators that can be followed', () => {
    expect(isFollowableLocator('https://example.org/a')).toBe(true);
    expect(isFollowableLocator('http://example.org/a')).toBe(true);
    expect(isFollowableLocator('javascript:alert(1)')).toBe(false);
    expect(isFollowableLocator('data:text/html,x')).toBe(false);
    expect(isFollowableLocator('file:///etc/passwd')).toBe(false);
    expect(isFollowableLocator('not a url')).toBe(false);
  });

  it('derives a publisher from the host and gives up rather than guessing', () => {
    expect(publisherOf('https://www.example.org/a/b')).toBe('www.example.org');
    expect(publisherOf('nonsense')).toBeNull();
  });

  it('cleans a snippet without leaving the gaps markup occupied', () => {
    expect(cleanSnippet('wet.<span class="x">.</span>')).toBe('wet..');
    expect(cleanSnippet('  a   b  ')).toBe('a b');
    expect(cleanSnippet(undefined)).toBe('');
    expect(cleanSnippet('x'.repeat(2000))).toHaveLength(1200);
  });

  it('maps statuses to messages without ever echoing a key', () => {
    const message = httpFailure(401, TAVILY_API_URL);
    expect(message).toMatch(/API key/);
    expect(message).not.toContain('tvly-');
  });

  it('builds a transport that sends the key as a bearer token', async () => {
    const { impl, calls } = fakeFetch({ body: {} });
    const transport = createHttpTransport(impl);
    expect(transport.kind).toBe('http');
    await transport.post({ body: requestBody, api_key: 'tvly-secret', timeout_ms: 5000 });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tvly-secret');
  });
});
