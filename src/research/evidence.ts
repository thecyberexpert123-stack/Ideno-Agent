/**
 * Research and evidence.
 *
 * The rule this module exists to enforce: **a model's recollection is not
 * research.** Evidence enters the Idea State from exactly two places — a source
 * the human supplies, or a source returned by a registered `ResearchSource`
 * (the extension point a future Research Plugin implements). Anything else is
 * stored as a model suggestion and labelled as unverified everywhere it appears.
 *
 * v0.1 ships no automated source on purpose. Puter's documented `chat()` options
 * include a `web_search` tool for OpenAI models, but the citation payload it
 * returns is not specified in a way Ideno could attribute per claim, and shipping
 * a source that could not be verified would put fabricated citations into the
 * state. The interface, the registry and the evidence pipeline are complete, so
 * adding a real source is additive.
 */
import type {
  EvidenceOrigin,
  IdeaCaseBody,
  ResearchItem,
} from '../core/schemas/index.js';
import { itemLabel, type AnyItem, type CollectionName } from '../core/idea_state/collections.js';

export interface ResearchFinding {
  claim: string;
  source: { title: string; locator: string; publisher?: string | null };
  relevance: string;
  /** How much this finding supports the claim, in [0, 1]. */
  confidence: number;
  /** When the source was retrieved, ISO-8601. */
  retrieved_at?: string;
}

export interface ResearchSearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

/**
 * A source of external findings. Implementations must return only findings they
 * actually retrieved, with a locator a human can follow.
 */
export interface ResearchSource {
  readonly id: string;
  readonly label: string;
  search(query: string, options?: ResearchSearchOptions): Promise<ResearchFinding[]>;
}

export class ResearchRegistry {
  #sources = new Map<string, ResearchSource>();

  register(source: ResearchSource): void {
    if (this.#sources.has(source.id)) {
      throw new Error(`A research source with id "${source.id}" is already registered.`);
    }
    this.#sources.set(source.id, source);
  }

  unregister(id: string): boolean {
    return this.#sources.delete(id);
  }

  list(): ResearchSource[] {
    return [...this.#sources.values()];
  }

  get(id: string): ResearchSource | null {
    return this.#sources.get(id) ?? null;
  }

  get empty(): boolean {
    return this.#sources.size === 0;
  }
}

/**
 * Runs every registered source for a research question and converts the findings
 * into evidence drafts. Returns findings per source so a failure in one source
 * does not discard the others.
 */
export async function runResearch(
  registry: ResearchRegistry,
  item: ResearchItem,
  options: ResearchSearchOptions = {},
): Promise<{ findings: ResearchFinding[]; failures: { source_id: string; message: string }[] }> {
  const findings: ResearchFinding[] = [];
  const failures: { source_id: string; message: string }[] = [];

  for (const source of registry.list()) {
    try {
      const results = await source.search(item.question, options);
      findings.push(...results);
    } catch (error) {
      failures.push({
        source_id: source.id,
        message: error instanceof Error ? error.message : 'The research source failed.',
      });
    }
  }

  return { findings, failures };
}

/**
 * Converts retrieved findings into evidence drafts. Origin is
 * `research_source`, which is what lets Core grant them `evidence_supported`
 * provenance; a locator is mandatory, and a finding without one is dropped and
 * reported rather than quietly weakened.
 */
export function findingsToEvidenceDrafts(findings: ResearchFinding[]): {
  drafts: {
    claim: string;
    source: { title: string; locator: string; publisher: string | null };
    relevance: string;
    confidence: number;
    origin: EvidenceOrigin;
    notes: string | null;
  }[];
  dropped: string[];
} {
  const drafts: ReturnType<typeof findingsToEvidenceDrafts>['drafts'] = [];
  const dropped: string[] = [];

  for (const finding of findings) {
    const locator = finding.source.locator?.trim();
    const title = finding.source.title?.trim();
    if (!locator || !title) {
      dropped.push(`A finding about "${truncate(finding.claim)}" named no usable source and was discarded.`);
      continue;
    }
    drafts.push({
      claim: finding.claim,
      source: { title, locator, publisher: finding.source.publisher ?? null },
      relevance: finding.relevance,
      confidence: clampConfidence(finding.confidence),
      origin: 'research_source',
      notes: finding.retrieved_at ? `Retrieved ${finding.retrieved_at}` : null,
    });
  }

  return { drafts, dropped };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Evidence gap analysis
// ---------------------------------------------------------------------------

export interface UnsupportedClaim {
  id: string;
  collection: CollectionName;
  label: string;
  provenance: string;
}

export interface EvidenceGap {
  /** Live items resting on inference or suggestion rather than evidence. */
  unsupported: UnsupportedClaim[];
  /** Open research questions, highest priority first. */
  open_research: ResearchItem[];
  /** Evidence already on file, so the UI can show what *is* grounded. */
  evidence_count: number;
}

/**
 * Collections whose items are *assertions* about the idea. Unknowns, research
 * questions and open questions are gaps rather than claims, evidence is the
 * grounding itself, and rejected approaches are history — none of them can be
 * "unsupported", so they are not scanned.
 */
const CLAIM_COLLECTIONS: CollectionName[] = [
  'requirements',
  'assumptions',
  'constraints',
  'alternatives',
  'decisions',
  'findings',
];

const GROUNDED_PROVENANCE = new Set(['user_stated', 'evidence_supported', 'user_decision']);

/**
 * Answers "what is this idea resting on that nobody has checked?" — for the UI,
 * and as context for the research operation.
 */
export function analyzeEvidenceGap(body: IdeaCaseBody): EvidenceGap {
  const unsupported: UnsupportedClaim[] = [];

  for (const collection of CLAIM_COLLECTIONS) {
    for (const item of body[collection] as AnyItem[]) {
      if (isClosedish(item)) continue;
      const provenance = (item as unknown as { provenance?: string }).provenance ?? '';
      if (GROUNDED_PROVENANCE.has(provenance)) continue;
      unsupported.push({
        id: item.id,
        collection,
        label: itemLabel(collection, item),
        provenance,
      });
    }
  }

  const priorityRank = { high: 3, medium: 2, low: 1 } as const;
  const openResearch = body.research_items
    .filter((item) => item.status === 'open' || item.status === 'in_progress')
    .slice()
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority]);

  return {
    unsupported,
    open_research: openResearch,
    evidence_count: body.evidence.filter((item) => item.status === 'accepted').length,
  };
}

function isClosedish(item: AnyItem): boolean {
  const status = (item as unknown as { status?: string }).status;
  if (!status) return false;
  return [
    'dropped',
    'invalidated',
    'rejected',
    'superseded',
    'reversed',
    'withdrawn',
    'dismissed',
    'abandoned',
    'retracted',
    'answered',
  ].includes(status);
}
