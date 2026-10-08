import { z } from 'zod';
import type { AIRuntime } from '../ai/runtime.js';
import { IdenoError, toIdenoError } from '../core/errors.js';
import { shortId } from '../core/ids.js';
import { locateItem } from '../core/idea_state.js';
import type { ChangeSet, IdeaCase, StateOperation } from '../core/schemas.js';
import type { DraftChangeSetEntry, StateManager } from '../core/state_manager.js';
import { EPISTEMIC_RULES, IDENO_IDENTITY } from '../reasoning/prompts.js';
import type { SourceFetcher } from './types.js';

/**
 * Research: turning a source into evidence.
 *
 * The rule from the specification — "do not present an unsupported model
 * guess as research" — is enforced structurally, not by instruction:
 *
 *  1. The source is fetched first. The model only ever sees retrieved text.
 *  2. Every claim must carry an `excerpt`.
 *  3. The excerpt is checked against the fetched document. A claim whose
 *     excerpt is not actually in the source is discarded and reported.
 *
 * What survives all three is evidence with a real, named source. Nothing else
 * becomes evidence.
 */

const ExtractedClaimSchema = z.object({
  claim: z.string().trim().min(1).max(400),
  /** Verbatim supporting text copied from the document. Verified afterwards. */
  excerpt: z.string().trim().min(12).max(1000),
  relevance: z.string().trim().min(1).max(400),
  confidence: z.number().min(0).max(1),
});

const ExtractionResultSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(6).default([]),
  /** Whether the document actually answers the question that was asked. */
  answers_question: z.boolean(),
  summary: z.string().trim().max(800).default(''),
});

export interface ResearchRequest {
  readonly caseId: string;
  readonly url: string;
  /** The question being researched. Falls back to the research item's text. */
  readonly question?: string;
  /** Existing research item to attach the evidence to. */
  readonly researchItemId?: string;
  readonly providerId?: string;
  readonly signal?: AbortSignal;
}

export interface ResearchOutcome {
  readonly ideaCase: IdeaCase;
  readonly changeset: ChangeSet | null;
  readonly sourceTitle: string | null;
  readonly claimsAccepted: number;
  readonly claimsRejected: number;
  readonly warnings: string[];
  readonly answersQuestion: boolean;
  readonly summary: string;
}

export interface ResearchServiceDeps {
  readonly runtime: AIRuntime;
  readonly stateManager: StateManager;
  readonly fetcher: SourceFetcher;
  readonly maxDocumentChars?: number;
}

const DEFAULT_MAX_DOCUMENT_CHARS = 18_000;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** True when the excerpt really occurs in the retrieved document. */
export function excerptOccursIn(excerpt: string, document: string): boolean {
  const needle = normalize(excerpt);
  if (needle.length < 12) return false;
  return normalize(document).includes(needle);
}

export class ResearchService {
  readonly #runtime: AIRuntime;
  readonly #state: StateManager;
  readonly #fetcher: SourceFetcher;
  readonly #maxDocumentChars: number;

  constructor(deps: ResearchServiceDeps) {
    this.#runtime = deps.runtime;
    this.#state = deps.stateManager;
    this.#fetcher = deps.fetcher;
    this.#maxDocumentChars = deps.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS;
  }

  async research(request: ResearchRequest): Promise<ResearchOutcome> {
    const ideaCase = await this.#state.getCase(request.caseId);

    const researchItem = request.researchItemId
      ? locateItem(ideaCase, request.researchItemId)
      : null;
    if (request.researchItemId && (!researchItem || researchItem.collection !== 'research_items')) {
      throw new IdenoError('not_found', `Research item ${request.researchItemId} was not found.`);
    }

    const question =
      request.question?.trim() ||
      (researchItem && 'question' in researchItem.item ? researchItem.item.question : '') ||
      ideaCase.current_intent ||
      ideaCase.title;

    const warnings: string[] = [];

    let document;
    try {
      const options = request.signal ? { signal: request.signal } : {};
      document = await this.#fetcher.fetch(request.url, options);
    } catch (error) {
      const failure = toIdenoError(error);
      if (request.researchItemId) {
        await this.#markResearchFailed(request.caseId, request.researchItemId, failure.message);
      }
      throw failure;
    }

    if (document.text.trim().length < 50) {
      const message = `${request.url} contained no readable text.`;
      if (request.researchItemId) {
        await this.#markResearchFailed(request.caseId, request.researchItemId, message);
      }
      throw new IdenoError('research_failed', message);
    }

    const body = document.text.slice(0, this.#maxDocumentChars);
    if (document.text.length > body.length || document.truncated) {
      warnings.push('The source was longer than Ideno reads; only the beginning was used.');
    }

    let extraction;
    try {
      const result = await this.#runtime.completeStructured({
        schema: ExtractionResultSchema,
        schemaName: 'ideno_research_extraction',
        system: `${IDENO_IDENTITY}

${EPISTEMIC_RULES}

TASK — EXTRACT EVIDENCE FROM A SOURCE.

You are given one retrieved document and the question it is meant to help
answer. Extract only claims the document itself states.

For every claim you MUST copy an \`excerpt\` verbatim from the document. The
excerpt is checked against the document afterwards; a claim whose excerpt is
not found is discarded. Do not paraphrase in the excerpt, do not combine
sentences from different places, and do not add anything the document does
not say.

If the document does not answer the question, say so with answers_question
false and return no claims. That is a correct and useful result.`,
        user: [
          `# QUESTION\n${question}`,
          `# SOURCE\nurl: ${document.finalUrl}\ntitle: ${document.title ?? '(none)'}`,
          `# DOCUMENT\n${body}`,
        ].join('\n\n'),
        temperature: 0,
        purpose: 'research_extract',
        ...(request.providerId === undefined ? {} : { providerId: request.providerId }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      extraction = result.value;
    } catch (error) {
      const failure = toIdenoError(error);
      if (request.researchItemId) {
        await this.#markResearchFailed(request.caseId, request.researchItemId, failure.message);
      }
      throw failure;
    }

    const verified = extraction.claims.filter((claim) => excerptOccursIn(claim.excerpt, document.text));
    const rejected = extraction.claims.length - verified.length;
    if (rejected > 0) {
      warnings.push(
        `${rejected} claim(s) were discarded because their quoted excerpt is not in the source.`,
      );
    }

    const entries: DraftChangeSetEntry[] = verified.map((claim, index) => {
      const operation: StateOperation = {
        op: 'add',
        collection: 'evidence',
        ref: `r${index + 1}`,
        item: {
          text: claim.claim,
          epistemic_status: 'evidence_supported',
          confidence: claim.confidence,
          claim: claim.claim,
          relevance: claim.relevance,
          excerpt: claim.excerpt,
          ...(request.researchItemId ? { research_item_id: request.researchItemId } : {}),
          source: {
            type: 'url',
            url: document.finalUrl,
            ...(document.title ? { title: document.title } : {}),
            retrieved_at: document.retrievedAt,
            fetched_by_ideno: true,
          },
        },
      };
      return {
        id: shortId('op'),
        operation,
        label: claim.claim,
        affected_areas: [],
        affected_item_ids: request.researchItemId ? [request.researchItemId] : [],
      };
    });

    if (request.researchItemId) {
      entries.push({
        id: shortId('op'),
        operation: {
          op: 'update',
          target_id: request.researchItemId,
          changes: {
            research_status: verified.length > 0 && extraction.answers_question ? 'answered' : 'open',
          },
          reason:
            verified.length > 0
              ? `${verified.length} supported claim(s) found at ${document.finalUrl}`
              : `${document.finalUrl} did not answer this`,
        },
        label:
          verified.length > 0
            ? `Research answered by ${document.finalUrl}`
            : `No supported answer at ${document.finalUrl}`,
        affected_areas: [],
        affected_item_ids: [request.researchItemId],
      });
    }

    if (entries.length === 0) {
      return {
        ideaCase,
        changeset: null,
        sourceTitle: document.title,
        claimsAccepted: 0,
        claimsRejected: rejected,
        warnings,
        answersQuestion: false,
        summary: extraction.summary || 'The source produced no verifiable claims.',
      };
    }

    const created = await this.#state.addChangeSet(request.caseId, {
      source: 'research',
      summary: `${verified.length} evidence record(s) from ${document.title ?? document.finalUrl}`,
      reasoning_summary: extraction.summary,
      entries,
      turnId: null,
      warnings,
    });

    return {
      ideaCase: created.ideaCase,
      changeset: created.changeset,
      sourceTitle: document.title,
      claimsAccepted: verified.length,
      claimsRejected: rejected,
      warnings,
      answersQuestion: extraction.answers_question && verified.length > 0,
      summary: extraction.summary,
    };
  }

  /** Records a failed attempt on the research item without touching evidence. */
  async #markResearchFailed(caseId: string, researchItemId: string, message: string): Promise<void> {
    await this.#state.store
      .update(caseId, (current) => {
        const item = current.research_items.find((entry) => entry.id === researchItemId);
        if (item) {
          item.research_status = 'failed';
          item.error = message.slice(0, 1000);
          item.last_attempt_at = new Date().toISOString();
          item.updated_at = item.last_attempt_at;
        }
        return current;
      })
      .catch(() => undefined);
  }
}
