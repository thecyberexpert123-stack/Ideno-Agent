import type { EpistemicStatus, ItemStatus, Origin } from '../../core/schemas.js';

/**
 * The epistemic badge.
 *
 * This is the most important affordance in the interface. The whole point of
 * Ideno is that "you said this", "I am assuming this" and "a source says
 * this" never look the same, so each status gets its own colour and an
 * explanation on hover.
 */
const STATUS_META: Record<EpistemicStatus, { label: string; title: string }> = {
  known: { label: 'known', title: 'Stated by you, or directly entailed by what you said.' },
  assumed: { label: 'assumed', title: 'A working assumption. Plausible, but unverified.' },
  unknown: { label: 'unknown', title: 'Explicitly not established yet.' },
  evidence_supported: {
    label: 'evidence',
    title: 'Backed by at least one evidence record with a real source.',
  },
  model_suggestion: {
    label: 'suggested',
    title: "Ideno's own suggestion. Not a fact, and not attributable to you.",
  },
  user_decision: { label: 'your decision', title: 'A choice you made. Authoritative.' },
};

const ORIGIN_LABEL: Record<Origin, string> = {
  user: 'from you',
  model: 'from Ideno',
  research: 'from research',
  system: 'automatic',
};

export function EpistemicBadge({
  status,
  origin,
  confidence,
}: {
  status: EpistemicStatus;
  origin?: Origin;
  confidence?: number | null;
}) {
  const meta = STATUS_META[status];
  const title = origin ? `${meta.title} (${ORIGIN_LABEL[origin]})` : meta.title;
  return (
    <span className={`badge badge--${status}`} title={title}>
      {meta.label}
      {confidence !== null && confidence !== undefined ? (
        <span className="badge__confidence">{Math.round(confidence * 100)}%</span>
      ) : null}
    </span>
  );
}

const ITEM_STATUS_TITLE: Record<ItemStatus, string> = {
  active: 'Counts towards the current design.',
  superseded: 'Replaced by a newer item, kept for history.',
  invalidated: 'Something later proved this wrong or inapplicable.',
  rejected: 'You turned this down.',
};

export function ItemStatusBadge({ status, reason }: { status: ItemStatus; reason?: string }) {
  if (status === 'active') return null;
  return (
    <span className={`badge badge--state-${status}`} title={reason ?? ITEM_STATUS_TITLE[status]}>
      {status}
    </span>
  );
}
