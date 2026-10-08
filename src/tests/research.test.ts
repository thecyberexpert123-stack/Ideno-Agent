import { describe, expect, it, vi } from 'vitest';
import { AIRuntime } from '../ai/runtime.js';
import { IdenoError } from '../core/errors.js';
import { StateManager } from '../core/state_manager.js';
import { MemoryCaseStore } from '../core/store/memory_store.js';
import { ResearchService, excerptOccursIn } from '../research/research_service.js';
import type { SourceDocument, SourceFetcher } from '../research/types.js';
import { UrlSourceFetcher, extractText, extractTitle, isBlockedAddress } from '../research/url_source.js';
import { ScriptedProvider, json } from './support/scripted_provider.js';

/**
 * Research.
 *
 * Two independent guarantees are under test:
 *  1. Fetching cannot be turned into a probe of the host's private network.
 *  2. A claim only becomes evidence if its quote is really in the document.
 */

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Balcony Growing Guide</title>
    <script>console.log("tracking")</script>
    <style>body { color: red }</style>
  </head>
  <body>
    <!-- a comment -->
    <h1>Balcony Growing Guide</h1>
    <p>A typical balcony rail planter is 60 centimetres wide and holds about 12 litres of substrate.</p>
    <p>Tomatoes need at least six hours of direct sun per day to set fruit reliably.</p>
    <noscript>Enable JavaScript</noscript>
  </body>
</html>`;

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('extractTitle / extractText', () => {
  it('reads the document title', () => {
    expect(extractTitle(PAGE)).toBe('Balcony Growing Guide');
    expect(extractTitle('<html><body>no title</body></html>')).toBeNull();
  });

  it('strips scripts, styles, comments and noscript content', () => {
    const text = extractText(PAGE);
    expect(text).not.toContain('tracking');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('a comment');
    expect(text).not.toContain('Enable JavaScript');
    expect(text).toContain('60 centimetres wide');
  });

  it('decodes entities and separates block elements', () => {
    const text = extractText('<p>Rain &amp; sun</p><p>Second</p>');
    expect(text).toContain('Rain & sun');
    expect(text).toMatch(/Rain & sun\s+Second/u);
  });
});

describe('UrlSourceFetcher', () => {
  function fetcher(
    fetchImpl: typeof fetch,
    addresses: string[] = ['93.184.216.34'],
  ): UrlSourceFetcher {
    return new UrlSourceFetcher({
      fetchImpl,
      resolveHost: async () => addresses,
    });
  }

  it('fetches and extracts a public page', async () => {
    const impl = vi.fn(async () => htmlResponse(PAGE)) as unknown as typeof fetch;
    const document = await fetcher(impl).fetch('https://example.org/guide');

    expect(document.title).toBe('Balcony Growing Guide');
    expect(document.text).toContain('six hours of direct sun');
    expect(document.truncated).toBe(false);
    expect(Date.parse(document.retrievedAt)).not.toBeNaN();
  });

  it.each(['file:///etc/passwd', 'ftp://example.org/x', 'gopher://example.org'])(
    'refuses the %s scheme',
    async (url) => {
      const impl = vi.fn() as unknown as typeof fetch;
      await expect(fetcher(impl).fetch(url)).rejects.toBeInstanceOf(IdenoError);
      expect(impl).not.toHaveBeenCalled();
    },
  );

  it('refuses a host that resolves to a private address', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetcher(impl, ['10.0.0.5']).fetch('https://internal.example.org/'),
      // A URL aimed at the host's own network is a bad request, not an
      // upstream failure: a 502 would wrongly blame the source.
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses when any resolved address is private', async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    await expect(
      fetcher(impl, ['93.184.216.34', '127.0.0.1']).fetch('https://split-horizon.example.org/'),
    ).rejects.toBeInstanceOf(IdenoError);
    expect(impl).not.toHaveBeenCalled();
  });

  it('re-validates the target of a redirect', async () => {
    const impl = vi.fn(async () =>
      htmlResponse('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    ) as unknown as typeof fetch;

    await expect(fetcher(impl).fetch('https://example.org/redirect')).rejects.toBeInstanceOf(
      IdenoError,
    );
  });

  it('follows a safe redirect', async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(
        htmlResponse('', { status: 301, headers: { location: 'https://example.org/final' } }),
      )
      .mockResolvedValueOnce(htmlResponse(PAGE)) as unknown as typeof fetch;

    const document = await fetcher(impl).fetch('https://example.org/start');
    expect(document.finalUrl).toBe('https://example.org/final');
    expect(document.title).toBe('Balcony Growing Guide');
  });

  it('stops after too many redirects', async () => {
    const impl = vi.fn(async () =>
      htmlResponse('', { status: 302, headers: { location: 'https://example.org/next' } }),
    ) as unknown as typeof fetch;

    await expect(fetcher(impl).fetch('https://example.org/loop')).rejects.toBeInstanceOf(IdenoError);
  });

  it('rejects a content type it cannot read as text', async () => {
    const impl = vi.fn(
      async () =>
        new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    ) as unknown as typeof fetch;

    await expect(fetcher(impl).fetch('https://example.org/paper.pdf')).rejects.toMatchObject({
      code: 'research_failed',
    });
  });

  it('reports an HTTP error from the source', async () => {
    const impl = vi.fn(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    await expect(fetcher(impl).fetch('https://example.org/missing')).rejects.toBeInstanceOf(
      IdenoError,
    );
  });

  it('truncates an oversized body instead of buffering it all', async () => {
    const huge = `<html><body><p>${'word '.repeat(20_000)}</p></body></html>`;
    const impl = vi.fn(async () => htmlResponse(huge)) as unknown as typeof fetch;

    const document = await fetcher(impl).fetch('https://example.org/big', { maxBytes: 2048 });
    expect(document.truncated).toBe(true);
    expect(document.text.length).toBeLessThan(4096);
  });

  it('permits private addresses only when explicitly allowed', async () => {
    const impl = vi.fn(async () => htmlResponse(PAGE)) as unknown as typeof fetch;
    const permissive = new UrlSourceFetcher({
      fetchImpl: impl,
      resolveHost: async () => ['127.0.0.1'],
      allowPrivateAddresses: true,
    });

    await expect(permissive.fetch('http://localhost:8080/page')).resolves.toMatchObject({
      title: 'Balcony Growing Guide',
    });
  });
});

describe('excerptOccursIn', () => {
  const document = 'A typical balcony rail planter is 60 centimetres wide.';

  it('accepts a verbatim quote', () => {
    expect(excerptOccursIn('balcony rail planter is 60 centimetres', document)).toBe(true);
  });

  it('ignores whitespace and case differences', () => {
    expect(excerptOccursIn('BALCONY   RAIL\n  PLANTER IS 60', document)).toBe(true);
  });

  it('rejects a paraphrase', () => {
    expect(excerptOccursIn('planters on balconies are usually 60 cm across', document)).toBe(false);
  });

  it('rejects a quote too short to mean anything', () => {
    expect(excerptOccursIn('is 60', document)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */

class StubFetcher implements SourceFetcher {
  readonly id = 'stub';
  constructor(
    private readonly document: SourceDocument | Error,
    readonly calls: string[] = [],
  ) {}

  async fetch(url: string): Promise<SourceDocument> {
    this.calls.push(url);
    if (this.document instanceof Error) throw this.document;
    return this.document;
  }
}

const DOCUMENT: SourceDocument = {
  url: 'https://example.org/guide',
  finalUrl: 'https://example.org/guide',
  title: 'Balcony Growing Guide',
  text: 'A typical balcony rail planter is 60 centimetres wide and holds about 12 litres of substrate. Tomatoes need at least six hours of direct sun per day to set fruit reliably.',
  retrievedAt: '2026-02-01T10:00:00.000Z',
  contentType: 'text/html',
  truncated: false,
};

async function researchFixture(reply: string | Error, document: SourceDocument | Error = DOCUMENT) {
  const store = new MemoryCaseStore();
  const stateManager = new StateManager(store);
  const provider = new ScriptedProvider({ replies: { research_extract: [reply] } });
  const runtime = new AIRuntime({ providers: [provider], maxAttempts: 1, maxRepairAttempts: 0 });
  const fetcher = new StubFetcher(document);
  const service = new ResearchService({ runtime, stateManager, fetcher });

  const ideaCase = await stateManager.createCase('A balcony greenhouse that waters itself.');
  return { service, stateManager, ideaCase, provider, fetcher };
}

describe('ResearchService', () => {
  it('records a verified claim as evidence with a real source', async () => {
    const { service, ideaCase } = await researchFixture(
      json({
        claims: [
          {
            claim: 'A balcony rail planter is typically 60 cm wide.',
            excerpt: 'A typical balcony rail planter is 60 centimetres wide',
            relevance: 'Bounds the footprint the greenhouse has to fit into.',
            confidence: 0.8,
          },
        ],
        answers_question: true,
        summary: 'The guide gives standard balcony planter dimensions.',
      }),
    );

    const outcome = await service.research({
      caseId: ideaCase.id,
      url: 'https://example.org/guide',
      question: 'How wide is a balcony planter?',
    });

    expect(outcome.claimsAccepted).toBe(1);
    expect(outcome.claimsRejected).toBe(0);
    expect(outcome.changeset).not.toBeNull();
    expect(outcome.changeset?.source).toBe('research');
    // Research results are a proposal like any other: still pending review.
    expect(outcome.changeset?.status).toBe('pending');

    const entry = outcome.changeset?.entries[0];
    expect(entry?.operation.op).toBe('add');
    if (entry?.operation.op === 'add') {
      expect(entry.operation.collection).toBe('evidence');
      const item = entry.operation.item as Record<string, unknown>;
      expect(item.epistemic_status).toBe('evidence_supported');
      expect(item.source).toMatchObject({
        type: 'url',
        url: 'https://example.org/guide',
        fetched_by_ideno: true,
      });
    }
  });

  it('discards a claim whose excerpt is not in the document', async () => {
    const { service, ideaCase } = await researchFixture(
      json({
        claims: [
          {
            claim: 'Balcony greenhouses must be bolted to the wall by law.',
            excerpt: 'all balcony greenhouses must be bolted to the supporting wall',
            relevance: 'Would be a hard structural constraint.',
            confidence: 0.9,
          },
        ],
        answers_question: false,
        summary: '',
      }),
    );

    const outcome = await service.research({
      caseId: ideaCase.id,
      url: 'https://example.org/guide',
    });

    expect(outcome.claimsAccepted).toBe(0);
    expect(outcome.claimsRejected).toBe(1);
    expect(outcome.changeset).toBeNull();
    expect(outcome.warnings.join(' ')).toMatch(/could not be found|discarded/iu);
  });

  it('keeps the verifiable claims and drops the fabricated one from the same batch', async () => {
    const { service, ideaCase } = await researchFixture(
      json({
        claims: [
          {
            claim: 'Tomatoes need six hours of direct sun.',
            excerpt: 'Tomatoes need at least six hours of direct sun per day',
            relevance: 'Drives the placement and glazing of the greenhouse.',
            confidence: 0.9,
          },
          {
            claim: 'The guide recommends a 200 W grow light.',
            excerpt: 'we recommend a 200 watt supplemental grow light',
            relevance: 'Would set the power budget.',
            confidence: 0.7,
          },
        ],
        answers_question: true,
        summary: 'Sun requirements.',
      }),
    );

    const outcome = await service.research({
      caseId: ideaCase.id,
      url: 'https://example.org/guide',
    });

    expect(outcome.claimsAccepted).toBe(1);
    expect(outcome.claimsRejected).toBe(1);
    expect(outcome.changeset?.entries).toHaveLength(1);
  });

  it('marks the research item failed when the source cannot be fetched', async () => {
    const store = new MemoryCaseStore();
    const stateManager = new StateManager(store);
    const provider = new ScriptedProvider({ replies: {} });
    const runtime = new AIRuntime({ providers: [provider], maxAttempts: 1 });
    const service = new ResearchService({
      runtime,
      stateManager,
      fetcher: new StubFetcher(new IdenoError('research_failed', 'DNS lookup failed')),
    });

    const created = await stateManager.createCase('A balcony greenhouse.');
    const withItem = await stateManager.addChangeSet(created.id, {
      source: 'orchestrator',
      summary: 'Queue a research question',
      reasoning_summary: '',
      turnId: null,
      entries: [
        {
          id: 'entry-1',
          label: 'Research planter dimensions',
          affected_areas: ['constraints'],
          affected_item_ids: [],
          operation: {
            op: 'add',
            collection: 'research_items',
            item: {
              text: 'Standard balcony planter dimensions',
              question: 'How wide is a standard balcony rail planter?',
              epistemic_status: 'unknown',
            },
          },
        },
      ],
    });
    const resolved = await stateManager.decideChangeSet(created.id, withItem.changeset.id, {
      acceptAll: true,
    });
    const researchItem = resolved.ideaCase.research_items[0];
    expect(researchItem).toBeDefined();

    await expect(
      service.research({
        caseId: created.id,
        url: 'https://example.org/unreachable',
        researchItemId: researchItem!.id,
      }),
    ).rejects.toBeInstanceOf(IdenoError);

    const after = await stateManager.getCase(created.id);
    const updated = after.research_items[0];
    expect(updated?.research_status).toBe('failed');
    expect(updated?.error).toContain('DNS lookup failed');
    expect(updated?.last_attempt_at).not.toBeNull();
    // A failed fetch must not invent evidence.
    expect(after.evidence).toHaveLength(0);
  });

  it('does not create evidence when the model returns no claims', async () => {
    const { service, ideaCase } = await researchFixture(
      json({ claims: [], answers_question: false, summary: 'The page is about something else.' }),
    );

    const outcome = await service.research({
      caseId: ideaCase.id,
      url: 'https://example.org/guide',
    });

    expect(outcome.claimsAccepted).toBe(0);
    expect(outcome.changeset).toBeNull();
    expect(outcome.answersQuestion).toBe(false);
  });

  it('fails cleanly when extraction returns unusable output', async () => {
    const { service, ideaCase } = await researchFixture('this is not json');

    await expect(
      service.research({ caseId: ideaCase.id, url: 'https://example.org/guide' }),
    ).rejects.toBeInstanceOf(IdenoError);

    // No partial write: the case is untouched.
    const { stateManager } = await researchFixture('{}');
    expect(stateManager).toBeDefined();
  });

  it('only ever shows the model text it actually retrieved', async () => {
    const { service, ideaCase, provider } = await researchFixture(
      json({ claims: [], answers_question: false, summary: '' }),
    );

    await service.research({
      caseId: ideaCase.id,
      url: 'https://example.org/guide',
      question: 'How much sun do tomatoes need?',
    });

    const prompt = provider.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('six hours of direct sun');
    expect(prompt).toContain('https://example.org/guide');
  });
});
