/**
 * Structured context assembly.
 *
 * The model receives a compact, id-carrying digest of the Idea State plus a
 * bounded window of the conversation — not an uncontrolled transcript dump. That
 * matters for three reasons:
 *
 *  1. The Idea State is the source of truth, so it is what the model reads.
 *  2. Ids in the digest are the only ids the model may reference; anything else
 *     gets pruned by `buildChangeRecords`, so grounding starts here.
 *  3. A bounded prompt keeps cost and latency predictable as an idea grows.
 *
 * Keys are abbreviated to save tokens, and the legend that explains them is part
 * of the prompt (see `CONTEXT_LEGEND`).
 */
import type {
  ChangeRecord,
  IdeaCaseBody,
  TranscriptEntry,
} from '../core/schemas/index.js';
import { CHANGE_KIND_LABELS } from '../core/schemas/index.js';
import { COLLECTIONS, itemLabel, type AnyItem, type CollectionName } from '../core/idea_state/collections.js';
import { computeStats, rankUnknowns } from '../core/idea_state/selectors.js';

export const CONTEXT_LEGEND = `Context format: the idea state is JSON with abbreviated keys.
id = item id (the only ids you may reference), t = text, p = provenance,
s = status, a = affected areas, e = evidence ids referenced, n = notes,
r = related ids, src = evidence source. Per collection one extra field is sent:
kd = requirement kind, cf = assumption confidence, cat = constraint category,
imp = unknown impact, pri = research priority, tgt = question target,
sev = finding severity, nm = alternative name, by = who decided.
Items in "pending_review" have been proposed but NOT yet accepted by the human;
do not re-propose them, and do not treat them as part of the agreed state.`;

export interface DigestOptions {
  /** Hard character budget for the state digest. */
  max_chars?: number;
  /** Per-item text truncation at the most detailed level. */
  text_limit?: number;
}

const DEFAULT_MAX_CHARS = 12_000;

/**
 * Degradation levels, applied in order until the digest fits the budget. Each
 * level keeps ids and provenance — those are what grounding depends on — and
 * gives up detail first.
 */
const LEVELS = [
  { text: 400, includeClosed: true, includeNotes: true },
  { text: 160, includeClosed: false, includeNotes: true },
  { text: 90, includeClosed: false, includeNotes: false },
] as const;

export function buildStateDigest(body: IdeaCaseBody, options: DigestOptions = {}): string {
  const maxChars = options.max_chars ?? DEFAULT_MAX_CHARS;
  const textLimit = options.text_limit ?? LEVELS[0].text;

  let digest = '';
  for (const level of LEVELS) {
    digest = renderDigest(body, { ...level, text: Math.min(level.text, textLimit) });
    if (digest.length <= maxChars) return digest;
  }

  // Even the leanest digest can overflow a pathological state. Truncate on a
  // line boundary and say so, rather than sending invalid JSON to the model.
  if (digest.length > maxChars) {
    const cut = digest.slice(0, maxChars);
    const lastBreak = cut.lastIndexOf('\n');
    return `${cut.slice(0, lastBreak > 0 ? lastBreak : maxChars)}\n… truncated to fit the context budget`;
  }
  return digest;
}

interface RenderLevel {
  text: number;
  includeClosed: boolean;
  includeNotes: boolean;
}

function renderDigest(body: IdeaCaseBody, level: RenderLevel): string {
  const stats = computeStats(body);
  const out: Record<string, unknown> = {
    phase: stats.phase,
    title: body.title,
    goal: clip(body.current_intent, level.text),
    original_idea: clip(body.original_idea, level.text),
    selected_alternative_id: body.selected_alternative_id,
    open_high_impact_unknowns: stats.open_high_impact_unknowns,
    open_critical_findings: stats.open_critical_findings,
  };

  for (const collection of COLLECTIONS) {
    const items = body[collection] as AnyItem[];
    const rendered = items
      .filter((item) => level.includeClosed || !isClosedItem(item))
      .map((item) => renderItem(collection, item, level));
    if (rendered.length > 0) out[collection] = rendered;
  }

  // Ranked separately so the model can see what matters most without recomputing.
  const ranked = rankUnknowns(body).slice(0, 5).map((item) => item.id);
  if (ranked.length > 0) out.highest_impact_unknown_ids = ranked;

  return JSON.stringify(out, null, 1);
}

/**
 * One extra field worth sending per collection, with an abbreviation that cannot
 * collide with `id` / `t` / `p` / `s`.
 */
const EXTRA_FIELD: Partial<Record<CollectionName, { field: string; short: string }>> = {
  requirements: { field: 'kind', short: 'kd' },
  assumptions: { field: 'confidence', short: 'cf' },
  constraints: { field: 'category', short: 'cat' },
  unknowns: { field: 'impact', short: 'imp' },
  research_items: { field: 'priority', short: 'pri' },
  open_questions: { field: 'target', short: 'tgt' },
  findings: { field: 'severity', short: 'sev' },
  alternatives: { field: 'name', short: 'nm' },
  decisions: { field: 'decided_by', short: 'by' },
};

function renderItem(
  collection: CollectionName,
  item: AnyItem,
  level: RenderLevel,
): Record<string, unknown> {
  const record = item as unknown as Record<string, unknown>;
  const rendered: Record<string, unknown> = {
    id: item.id,
    t: clip(itemLabel(collection, item), level.text),
  };
  if (typeof record.provenance === 'string') rendered.p = record.provenance;
  if (typeof record.status === 'string') rendered.s = record.status;

  const extra = EXTRA_FIELD[collection];
  if (extra && record[extra.field] !== undefined) rendered[extra.short] = record[extra.field];

  if (Array.isArray(record.evidence_refs) && record.evidence_refs.length > 0) rendered.e = record.evidence_refs;
  if (Array.isArray(record.affected_areas) && record.affected_areas.length > 0) {
    rendered.a = record.affected_areas;
  }
  if (Array.isArray(record.related_ids) && record.related_ids.length > 0) rendered.r = record.related_ids;
  if (level.includeNotes && typeof record.notes === 'string' && record.notes) {
    rendered.n = clip(record.notes, 120);
  }
  if (collection === 'evidence' && record.source) {
    rendered.src = record.source;
  }
  return rendered;
}

function isClosedItem(item: AnyItem): boolean {
  const status = (item as unknown as { status?: string }).status;
  if (!status) return false;
  return [
    'dropped',
    'invalidated',
    'resolved',
    'retracted',
    'abandoned',
    'rejected',
    'superseded',
    'reversed',
    'withdrawn',
    'dismissed',
    'answered',
    'satisfied',
  ].includes(status);
}

/**
 * The most recent conversation turns, oldest first. System entries are kept
 * because they carry failure information the model should not repeat.
 */
export function buildTranscriptWindow(
  transcript: TranscriptEntry[],
  turns: number,
  charLimit = 900,
): { role: 'user' | 'assistant'; content: string }[] {
  if (turns <= 0) return [];
  // Named `recent`, not `window`: shadowing the global `window` in a module that
  // must stay DOM-free is an accident waiting to happen.
  const recent = transcript.slice(-turns);
  return recent.map((entry) => ({
    role: entry.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: clip(
      entry.role === 'system' ? `[system] ${entry.text}` : entry.text,
      charLimit,
    ),
  }));
}

/** Queued changes, so the model does not propose the same thing twice. */
export function buildPendingDigest(pending: ChangeRecord[], limit = 24): string {
  if (pending.length === 0) return '[]';
  const entries = pending.slice(-limit).map((record) => ({
    id: record.id,
    change: CHANGE_KIND_LABELS[record.kind],
    detail: clip(draftLabel(record), 160),
    provenance: record.provenance,
  }));
  return JSON.stringify(entries, null, 1);
}

function draftLabel(record: ChangeRecord): string {
  const draft = record.draft as Record<string, unknown> | string | null;
  if (typeof draft === 'string') return draft;
  if (!draft || typeof draft !== 'object') return '';
  for (const key of ['text', 'claim', 'question', 'name', 'reason', 'decision']) {
    const value = draft[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  if (typeof draft.reason === 'string') return draft.reason;
  return record.kind;
}

/** Assembles the user-side prompt for one operation call. */
export function assembleUserPrompt(parts: {
  state_digest: string;
  pending_digest: string;
  instruction: string;
  user_message?: string;
}): string {
  const sections = [
    '## CURRENT IDEA STATE',
    parts.state_digest,
    '',
    '## PENDING REVIEW (proposed, not accepted)',
    parts.pending_digest,
    '',
    '## YOUR TASK THIS TURN',
    parts.instruction,
  ];
  if (parts.user_message !== undefined) {
    sections.push('', '## THE HUMAN\'S LATEST MESSAGE', parts.user_message);
  }
  return sections.join('\n');
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
