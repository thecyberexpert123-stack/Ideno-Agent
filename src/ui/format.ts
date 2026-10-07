/**
 * Small presentation helpers shared by the UI components.
 *
 * Anything here must stay pure and side-effect free: the components decide
 * structure, this decides wording.
 */
import type { Provenance } from '../core/schemas/index.js';
import { PROVENANCE_LABELS } from '../core/schemas/index.js';

/** Short provenance word for a chip; the full sentence goes in the tooltip. */
export const PROVENANCE_SHORT: Record<Provenance, string> = {
  user_stated: 'Known',
  model_inferred: 'Assumed',
  unknown: 'Unknown',
  evidence_supported: 'Evidenced',
  model_suggestion: 'Suggested',
  user_decision: 'Your decision',
};

export function provenanceLabel(provenance: string): string {
  return PROVENANCE_LABELS[provenance as Provenance] ?? provenance;
}

export function provenanceShort(provenance: string): string {
  return PROVENANCE_SHORT[provenance as Provenance] ?? provenance;
}

/** Human-readable status wording, since the enums are machine words. */
const STATUS_LABELS: Record<string, string> = {
  open: 'open',
  satisfied: 'satisfied',
  conflicted: 'conflicted',
  dropped: 'dropped',
  active: 'active',
  confirmed: 'confirmed',
  invalidated: 'invalidated',
  relaxed: 'relaxed',
  violated: 'violated',
  resolved: 'resolved',
  deferred: 'deferred',
  accepted: 'accepted',
  disputed: 'disputed',
  retracted: 'retracted',
  in_progress: 'in progress',
  answered: 'answered',
  abandoned: 'abandoned',
  proposed: 'proposed',
  selected: 'selected',
  rejected: 'rejected',
  parked: 'parked',
  superseded: 'superseded',
  reversed: 'reversed',
  unasked: 'not asked',
  asked: 'asked',
  withdrawn: 'withdrawn',
  acknowledged: 'acknowledged',
  dismissed: 'dismissed',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

const KIND_LABELS: Record<string, string> = {
  contradiction: 'Contradiction',
  risk: 'Risk',
  hidden_dependency: 'Hidden dependency',
  limitation: 'Limitation',
  failure_point: 'Failure point',
  missing_requirement: 'Missing requirement',
};

export function findingKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Only http(s) locators become links.
 *
 * Evidence sources come from a model or from user input, so rendering one
 * straight into an `href` would allow a `javascript:` URL to execute in the app's
 * origin. Anything else is shown as plain text.
 */
export function safeUrl(locator: string): string | null {
  const trimmed = locator.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Wraps long text for the review cards without losing the middle silently. */
export function truncateMiddle(text: string, max = 240): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}
