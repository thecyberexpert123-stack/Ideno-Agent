/**
 * The review queue.
 *
 * This is where human authority is exercised. Each card states what Ideno
 * proposes, why, what it would affect, and how it was grounded — then waits.
 * The layout follows the shape of the change itself rather than the shape of a
 * chat message, because the decision being made is about the state, not about
 * conversation.
 */
import type { ChangeRecord, IdeaCase } from '../../core/schemas/index.js';
import { CHANGE_KIND_LABELS } from '../../core/schemas/index.js';
import { findItem, itemLabel } from '../../core/idea_state/collections.js';
import { button, el, type Child } from '../dom.js';
import { provenanceLabel, provenanceShort, truncateMiddle } from '../format.js';
import { reviewButtons, type StatePanelActions } from './state_panel.js';

export interface ReviewActions extends StatePanelActions {
  onAcceptAll(): void;
  onRejectAll(): void;
}

export function renderReviewQueue(
  pending: ChangeRecord[],
  resolved: ChangeRecord[],
  idea: IdeaCase | null,
  actions: ReviewActions,
): HTMLElement {
  if (pending.length === 0 && resolved.length === 0) {
    return el(
      'div',
      { class: 'empty-line' },
      'Nothing is waiting for you. When Ideno infers something — an assumption, a constraint it thinks you implied, a critique finding — it appears here for you to accept or reject before it becomes part of the idea.',
    );
  }

  return el(
    'div',
    null,
    pending.length > 0
      ? el(
          'div',
          { class: 'section' },
          el(
            'div',
            { class: 'section-head' },
            el('span', { text: 'Awaiting your decision' }),
            el('span', { class: 'badge', text: String(pending.length) }),
            el(
              'span',
              { class: 'review-actions' },
              button('Accept all', { class: 'btn-sm btn-primary', onClick: actions.onAcceptAll }),
              button('Reject all', { class: 'btn-sm btn-danger', onClick: actions.onRejectAll }),
            ),
          ),
          el('div', { class: 'section-body' }, pending.map((record) => renderCard(record, idea, actions))),
        )
      : el('div', { class: 'empty-line', text: 'Nothing is waiting for your decision.' }),
    resolved.length > 0
      ? el(
          'section',
          { class: 'section' },
          el(
            'div',
            { class: 'section-head' },
            el('span', { text: 'Recently decided' }),
            el('span', { class: 'section-count', text: String(resolved.length) }),
          ),
          el('div', { class: 'section-body' }, resolved.map((record) => renderResolved(record))),
        )
      : null,
  );
}

function renderCard(record: ChangeRecord, idea: IdeaCase | null, actions: ReviewActions): HTMLElement {
  return el(
    'div',
    { class: 'review-card' },
    el(
      'div',
      { class: 'review-kind' },
      el('span', { text: CHANGE_KIND_LABELS[record.kind] }),
      el('span', {
        class: `prov prov-${record.provenance}`,
        text: provenanceShort(record.provenance),
        title: provenanceLabel(record.provenance),
      }),
    ),
    el('div', { class: 'review-text', text: quotedDraft(record) }),
    affectedBlock(record, idea),
    record.rationale ? el('div', { class: 'review-rationale', text: record.rationale }) : null,
    record.integrity_note
      ? el('div', { class: 'review-note', text: `Integrity note: ${record.integrity_note}` })
      : null,
    reviewButtons(record, actions),
  );
}

function quotedDraft(record: ChangeRecord): string {
  const draft = record.draft;
  if (typeof draft === 'string') return draft ? `“${truncateMiddle(draft)}”` : '(cleared)';
  if (draft === null) return '(selection cleared)';
  const object = draft as Record<string, unknown>;
  for (const key of ['text', 'claim', 'question', 'name', 'reason']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return `“${truncateMiddle(value)}”`;
  }
  if (typeof object.status === 'string') return `set status to “${object.status}”`;
  if (typeof object.id === 'string') return `modify item ${object.id}`;
  return record.kind;
}

function affectedBlock(record: ChangeRecord, idea: IdeaCase | null): Child {
  const areas = record.affects.areas;
  const ids = record.affects.item_ids;
  if (areas.length === 0 && ids.length === 0) return null;

  const entries: Child[] = areas.map((area) => el('li', null, area));
  if (idea) {
    for (const id of ids) {
      const located = findItem(idea, id);
      if (located) entries.push(el('li', null, itemLabel(located.collection, located.item)));
    }
  }

  return el('div', { class: 'review-affected' }, 'Affected:', el('ul', null, entries));
}

function renderResolved(record: ChangeRecord): HTMLElement {
  const accepted = record.status === 'accepted' || record.status === 'auto_accepted';
  return el(
    'div',
    { class: 'review-card review-resolved' },
    el(
      'div',
      { class: 'review-kind' },
      el('span', { text: CHANGE_KIND_LABELS[record.kind] }),
      el('span', {
        class: accepted ? 'chip' : 'chip chip-severity-major',
        text: record.status.replace(/_/g, ' '),
      }),
    ),
    el('div', { class: 'review-text', text: quotedDraft(record) }),
    record.rejection_reason
      ? el('div', { class: 'review-note', text: record.rejection_reason })
      : null,
  );
}
