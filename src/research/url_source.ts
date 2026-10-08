import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { IdenoError } from '../core/errors.js';
import type { SourceDocument, SourceFetchOptions, SourceFetcher } from './types.js';

/**
 * Fetches a web page and extracts its readable text.
 *
 * Security notes — this endpoint takes a URL from the client and makes the
 * *server* request it, which is a server-side request forgery primitive if
 * left open. Mitigations implemented here:
 *
 *  - only http(s), no file:, gopher:, data: …
 *  - DNS is resolved up front and every resolved address is checked against
 *    loopback, private, link-local, unique-local and reserved ranges
 *  - redirects are followed manually, re-validating the destination each hop
 *  - response size and time are capped
 *  - only textual content types are accepted
 *
 * A TOCTOU gap remains between the DNS check and the connection (DNS
 * rebinding). Closing it needs a custom agent pinned to the resolved address;
 * that is noted as a known limitation rather than silently ignored.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml', 'text/markdown'];

export interface UrlSourceFetcherOptions {
  readonly userAgent?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests. Defaults to DNS resolution. */
  readonly resolveHost?: (hostname: string) => Promise<string[]>;
  /** Permits private addresses. Only enabled by the test suite. */
  readonly allowPrivateAddresses?: boolean;
}

export class UrlSourceFetcher implements SourceFetcher {
  readonly id = 'http';
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #resolveHost: (hostname: string) => Promise<string[]>;
  readonly #allowPrivate: boolean;

  constructor(options: UrlSourceFetcherOptions = {}) {
    this.#userAgent = options.userAgent ?? 'Ideno/0.1 (+https://github.com/)';
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#resolveHost = options.resolveHost ?? defaultResolveHost;
    this.#allowPrivate = options.allowPrivateAddresses ?? false;
  }

  async fetch(url: string, options: SourceFetchOptions = {}): Promise<SourceDocument> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const target = await this.#validate(current);
        const response = await this.#request(target, controller.signal);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new IdenoError('research_failed', `${current} redirected without a destination.`);
          }
          current = new URL(location, target).toString();
          continue;
        }

        if (!response.ok) {
          throw new IdenoError(
            'research_failed',
            `${current} responded with HTTP ${response.status}.`,
            { retryable: response.status >= 500 },
          );
        }

        return await readDocument(response, url, current, maxBytes);
      }
      throw new IdenoError('research_failed', `${url} exceeded ${MAX_REDIRECTS} redirects.`);
    } catch (error) {
      if (error instanceof IdenoError) throw error;
      if (controller.signal.aborted) {
        throw new IdenoError('research_failed', `Fetching ${url} timed out after ${timeoutMs} ms.`, {
          retryable: true,
        });
      }
      throw new IdenoError('research_failed', `Could not fetch ${url}.`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: string, signal: AbortSignal): Promise<Response> {
    return this.#fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'user-agent': this.#userAgent,
      },
    });
  }

  async #validate(rawUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new IdenoError('bad_request', `"${rawUrl}" is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new IdenoError('bad_request', 'Only http and https sources can be fetched.');
    }
    if (this.#allowPrivate) return parsed.toString();

    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
    const addresses = isIP(hostname) ? [hostname] : await this.#resolveHost(hostname);
    if (addresses.length === 0) {
      throw new IdenoError('research_failed', `Could not resolve ${parsed.hostname}.`);
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw new IdenoError(
          'bad_request',
          `Refusing to fetch ${parsed.hostname}: it resolves to a private or loopback address.`,
        );
      }
    }
    return parsed.toString();
  }
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch (error) {
    throw new IdenoError('research_failed', `Could not resolve ${hostname}.`, { cause: error });
  }
}

/** Loopback, private, link-local, CGNAT, unique-local and reserved ranges. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a = 0, b = 0] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fe80')) return true;
    if (/^f[cd][0-9a-f]{2}:/u.test(normalized)) return true;
    // IPv4-mapped addresses such as ::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

async function readDocument(
  response: Response,
  requestedUrl: string,
  finalUrl: string,
  maxBytes: number,
): Promise<SourceDocument> {
  const contentType = (response.headers.get('content-type') ?? 'text/plain').split(';')[0]?.trim() ?? '';
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new IdenoError(
      'research_failed',
      `${finalUrl} returned "${contentType}", which Ideno cannot read as a source.`,
    );
  }

  const buffer = await readCapped(response, maxBytes);
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(buffer.bytes);
  const isHtml = contentType === 'text/html' || contentType === 'application/xhtml+xml';

  return {
    url: requestedUrl,
    finalUrl,
    title: isHtml ? extractTitle(raw) : null,
    text: isHtml ? extractText(raw) : raw.trim(),
    retrievedAt: new Date().toISOString(),
    contentType,
    truncated: buffer.truncated,
  };
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > maxBytes
      ? { bytes: buffer.slice(0, maxBytes), truncated: true }
      : { bytes: buffer, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

const BLOCK_ELEMENTS = /<\/(p|div|section|article|h[1-6]|li|tr|br)>/giu;

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).replace(/\s+/gu, ' ').trim() : '';
  return title.length > 0 ? title.slice(0, 300) : null;
}

/**
 * Minimal HTML-to-text extraction.
 *
 * A full readability implementation is out of scope for v0.1; this removes
 * non-content elements and preserves block boundaries, which is enough for a
 * model to quote from accurately.
 */
export function extractText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
      .replace(BLOCK_ELEMENTS, '\n')
      .replace(/<[^>]+>/gu, ' '),
  )
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (NAMED_ENTITIES[key]) return NAMED_ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}
