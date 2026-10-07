/**
 * The Idea State panel.
 *
 * This is the product's main surface: the conversation is how you talk to Ideno,
 * this is what Ideno actually holds. Two rules shaped it:
 *
 *  - Provenance is always visible. A requirement the user stated and one Ideno
 *    inferred look different, because they are different things.
 *  - Proposed items appear in place, in their own section, styled as proposals
 *    with Accept / Reject. The state visibly develops without anything the model
 *    invented quietly becoming fact.
 */
import type {
  Alternative,
  ChangeRecord,
  Evidence,
  Finding,
  IdeaCase,
  OpenQuestion,
  RejectedApproach,
  ResearchItem,
} from '../../core/schemas/index.js';
import { CHANGE_KIND_LABELS, IDEA_PHASE_LABELS } from '../../core/schemas/index.js';
import {
  ADD_KIND_TO_COLLECTION,
} from '../../core/state_manager/apply.js';
import {
  COLLECTION_LABELS,
  findItem,
  isClosed,
  itemDetail,
  itemLabel,
  type AnyItem,
  type CollectionName,
} from '../../core/idea_state/collections.js';
import { computeStats } from '../../core/idea_state/selectors.js';
import { button, el, type Child } from '../dom.js';
import { findingKindLabel, provenanceLabel, provenanceShort, safeUrl, statusLabel } from '../format.js';

export interface EvidenceInput {
  claim: string;
  source_title: string;
  source_locator: string;
  relevance: string;
  confidence: number;
}

export interface StatePanelActions {
  onAcceptChange(changeId: string): void;
  onRejectChange(changeId: string): void;
  onSelectAlternative(alternativeId: string): void;
  onResolveUnknown(unknownId: string, resolution: string): void;
  /**
   * Evidence the human supplies themselves. This is the only route to
   * `evidence_supported` provenance when no research source is registered, and it
   * is the honest one: a person naming a source they actually consulted.
   */
  onAddEvidence(input: EvidenceInput): void;
}

/** Order the sections appear in: what the idea must do, then what it rests on. */
const DISPLAY_ORDER: CollectionName[] = [
  'requirements',
  'constraints',
  'assumptions',
  'unknowns',
  'alternatives',
  'decisions',
  'evidence',
  'findings',
  'research_items',
  'open_questions',
  'rejected_approaches',
];

export function renderStatePanel(
  idea: IdeaCase | null,
  pending: ChangeRecord[],
  actions: StatePanelActions,
): HTMLElement {
  if (!idea) {
    return el(
      'div',
      { class: 'empty-line' },
      'Nothing structured yet. Describe an idea on the left and Ideno will build its state here.',
    );
  }

  const stats = computeStats(idea);
  return el(
    'div',
    null,
    renderGoal(idea, pending, actions),
    DISPLAY_ORDER.map((collection) => renderSection(collection, idea, pending, actions)),
    pending.length === 0
      ? null
      : el(
          'div',
          { class: 'empty-line' },
          `${pending.length} proposed change${pending.length === 1 ? '' : 's'} shown inline above, waiting for your decision.`,
        ),
    stats.model_contributed > 0
      ? el(
          'div',
          { class: 'empty-line' },
          `${stats.model_contributed} item${stats.model_contributed === 1 ? '' : 's'} in this state came from Ideno, not from you. They are marked.`,
        )
      : null,
  );
}

function renderGoal(idea: IdeaCase, pending: ChangeRecord[], actions: StatePanelActions): HTMLElement {
  const proposedIntent = pending.find((record) => record.kind === 'intent_revised');
  const proposedTitle = pending.find((record) => record.kind === 'title_revised');

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('span', { text: 'Goal' }),
      el('span', { class: 'chip chip-phase', text: IDEA_PHASE_LABELS[idea.current_state] }),
      el('span', { class: 'section-count', text: idea.title }),
    ),
    el('div', { class: 'goal-text', text: idea.current_intent }),
    proposedIntent
      ? proposalRow(
          'Ideno proposes restating the goal as',
          String(proposedIntent.draft),
          proposedIntent,
          actions,
        )
      : null,
    proposedTitle
      ? proposalRow('Proposed title', String(proposedTitle.draft), proposedTitle, actions)
      : null,
    el(
      'div',
      { class: 'goal-original' },
      el('span', { text: 'Original words: ' }),
      idea.original_idea,
    ),
  );
}

function renderSection(
  collection: CollectionName,
  idea: IdeaCase,
  pending: ChangeRecord[],
  actions: StatePanelActions,
): HTMLElement {
  const items = idea[collection] as AnyItem[];
  const proposals = proposalsFor(collection, idea, pending, actions);
  const openCount = items.filter((item) => !isClosed(item)).length;

  const countText =
    items.length === 0
      ? proposals.length > 0
        ? `${proposals.length} proposed`
        : ''
      : `${openCount} open · ${items.length} total${proposals.length > 0 ? ` · ${proposals.length} proposed` : ''}`;

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('span', { text: COLLECTION_LABELS[collection] }),
      countText ? el('span', { class: 'section-count', text: countText }) : null,
      collection === 'evidence'
        ? el('div', { class: 'review-actions' }, evidenceForm(actions))
        : null,
    ),
    el(
      'div',
      { class: 'section-body' },
      items.length === 0 && proposals.length === 0
        ? el('div', { class: 'empty-line', text: 'None recorded.' })
        : null,
      items.map((item) => renderItemRow(collection, item, idea, actions)),
      proposals,
    ),
  );
}

function renderItemRow(
  collection: CollectionName,
  item: AnyItem,
  idea: IdeaCase,
  actions: StatePanelActions,
): HTMLElement {
  const closed = isClosed(item);
  const provenance = (item as unknown as { provenance?: string }).provenance ?? 'model_suggestion';

  return el(
    'div',
    { class: closed ? 'item item-closed' : 'item' },
    el(
      'div',
      { class: 'item-main' },
      el('span', {
        class: `prov prov-${provenance}`,
        text: provenanceShort(provenance),
        title: provenanceLabel(provenance),
      }),
      el('span', { class: 'item-text', text: itemLabel(collection, item) }),
    ),
    el('div', { class: 'item-meta' }, ...metaChips(collection, item, idea)),
    detailLine(collection, item),
    collection === 'alternatives' && (item as Alternative).status !== 'selected'
      ? el(
          'div',
          { class: 'item-meta' },
          button('Select this approach', {
            class: 'btn-sm',
            title: 'Record this as your decision',
            onClick: () => actions.onSelectAlternative(item.id),
          }),
        )
      : null,
    collection === 'unknowns' && !closed
      ? resolveControl(item.id, actions)
      : null,
  );
}

function metaChips(collection: CollectionName, item: AnyItem, idea: IdeaCase): Child[] {
  const record = item as unknown as Record<string, unknown>;
  const chips: Child[] = [];

  const chip = (text: string, className = ''): Child =>
    text ? el('span', { class: `chip ${className}`.trim(), text }) : null;

  const status = typeof record.status === 'string' ? record.status : null;
  if (status && !(status === 'open' || status === 'active' || status === 'proposed')) {
    chips.push(chip(statusLabel(status), 'chip-status-closed'));
  }

  switch (collection) {
    case 'requirements':
      chips.push(chip(String(record.priority ?? ''), ''));
      if (record.kind !== 'explicit') chips.push(chip(String(record.kind ?? '')));
      break;
    case 'constraints':
      chips.push(chip(String(record.category ?? '')));
      chips.push(chip(record.hard === true ? 'hard' : 'soft'));
      break;
    case 'assumptions':
      if (typeof record.confidence === 'number') {
        chips.push(chip(`${Math.round(record.confidence * 100)}% confidence`));
      }
      chips.push(chip(`if false: ${String(record.if_false_impact ?? '')}`, 'chip-impact-high'));
      break;
    case 'unknowns':
      chips.push(chip(`${String(record.impact ?? '')} impact`, record.impact === 'high' ? 'chip-impact-high' : ''));
      break;
    case 'evidence': {
      const evidence = item as Evidence;
      chips.push(chip(evidence.origin.replace(/_/g, ' ')));
      chips.push(chip(`${Math.round(evidence.confidence * 100)}% confidence`));
      break;
    }
    case 'alternatives': {
      const alternative = item as Alternative;
      chips.push(chip(`${alternative.pros.length} pros · ${alternative.cons.length} cons`));
      if (alternative.spec) {
        chips.push(
          chip(`${alternative.spec.objects.length} objects · ${alternative.spec.connections.length} links`),
        );
      }
      if (alternative.addresses.length > 0) {
        chips.push(chip(`addresses ${alternative.addresses.length} recorded item(s)`));
      }
      if (idea.selected_alternative_id === alternative.id) chips.push(chip('selected', 'chip-phase'));
      break;
    }
    case 'decisions':
      chips.push(chip(record.decided_by === 'user' ? 'you decided' : 'Ideno proposed'));
      break;
    case 'findings': {
      const finding = item as Finding;
      chips.push(chip(findingKindLabel(finding.kind)));
      chips.push(chip(finding.severity, `chip-severity-${finding.severity}`));
      break;
    }
    case 'research_items':
      chips.push(chip(`${String((item as ResearchItem).priority)} priority`));
      break;
    case 'open_questions': {
      const question = item as OpenQuestion;
      chips.push(chip(question.target === 'user' ? 'for you' : 'needs research'));
      chips.push(chip(`${question.impact} impact`));
      break;
    }
    case 'rejected_approaches': {
      const rejected = item as RejectedApproach;
      chips.push(chip(rejected.rejected_by === 'user' ? 'you rejected' : 'Ideno discounted'));
      break;
    }
    default:
      break;
  }

  const evidenceRefs = Array.isArray(record.evidence_refs) ? (record.evidence_refs as string[]) : [];
  if (evidenceRefs.length > 0) chips.push(chip(`${evidenceRefs.length} citation(s)`));

  return chips;
}

function detailLine(collection: CollectionName, item: AnyItem): Child {
  const parts: Child[] = [];

  if (collection === 'evidence') {
    const evidence = item as Evidence;
    const url = safeUrl(evidence.source.locator);
    parts.push(
      el(
        'div',
        { class: 'item-detail' },
        url
          ? el('a', { href: url, text: evidence.source.title, title: evidence.source.locator })
          : el('span', { text: `${evidence.source.title} — ${evidence.source.locator}` }),
        evidence.source.publisher ? ` (${evidence.source.publisher})` : '',
      ),
    );
    parts.push(el('div', { class: 'item-detail', text: `Relevance: ${evidence.relevance}` }));
  }

  if (collection === 'alternatives') {
    const alternative = item as Alternative;
    parts.push(el('div', { class: 'item-detail', text: alternative.summary }));
    if (alternative.pros.length > 0 || alternative.cons.length > 0) {
      parts.push(
        el(
          'div',
          { class: 'item-detail' },
          alternative.pros.length > 0 ? el('div', null, `+ ${alternative.pros.join('  ·  ')}`) : null,
          alternative.cons.length > 0 ? el('div', null, `− ${alternative.cons.join('  ·  ')}`) : null,
        ),
      );
    }
  }

  if (collection === 'unknowns') {
    const areas = (item as unknown as { affected_areas: string[] }).affected_areas;
    if (areas.length > 0) parts.push(el('div', { class: 'item-detail', text: `Blocks: ${areas.join(', ')}` }));
    const resolution = (item as unknown as { resolution: string | null }).resolution;
    if (resolution) parts.push(el('div', { class: 'item-detail', text: `Resolved: ${resolution}` }));
  }

  const detail = itemDetail(collection, item);
  if (detail && collection !== 'evidence' && collection !== 'alternatives' && collection !== 'unknowns') {
    parts.push(el('div', { class: 'item-detail', text: detail }));
  }

  return parts.length > 0 ? el('div', null, parts) : null;
}

function resolveControl(unknownId: string, actions: StatePanelActions): HTMLElement {
  const holder = el('div', { class: 'item-meta' });
  const showForm = (): void => {
    const input = el('input', {
      type: 'text',
      placeholder: 'What settled it?',
      class: '',
    }) as HTMLInputElement;
    const save = button('Save', {
      class: 'btn-sm btn-primary',
      onClick: () => {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        actions.onResolveUnknown(unknownId, value);
      },
    });
    const cancel = button('Cancel', { class: 'btn-sm btn-ghost', onClick: () => showButton() });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click();
      if (event.key === 'Escape') cancel.click();
    });
    holder.replaceChildren(input, save, cancel);
    input.focus();
  };
  const showButton = (): void => {
    holder.replaceChildren(
      button('Mark resolved', { class: 'btn-sm', onClick: showForm }),
    );
  };
  showButton();
  return holder;
}

/**
 * The proposals that belong in one section: additions to that collection, plus
 * updates and invalidations aimed at items already in it.
 */
/**
 * The proposals that belong in one section: additions to that collection, plus
 * updates and invalidations aimed at items already in it. Each renders with its
 * own Accept / Reject so the decision can be made where the item will live.
 */
function proposalsFor(
  collection: CollectionName,
  idea: IdeaCase,
  pending: ChangeRecord[],
  actions: StatePanelActions,
): HTMLElement[] {
  const rows: HTMLElement[] = [];

  for (const record of pending) {
    const target = ADD_KIND_TO_COLLECTION[record.kind];
    if (target === collection) {
      rows.push(proposalItemRow(collection, record, actions));
      continue;
    }
    if (record.kind === 'item_updated' || record.kind === 'item_invalidated') {
      const located = findItem(idea, record.resolved_item_id ?? '');
      if (located && located.collection === collection) {
        rows.push(proposalItemRow(collection, record, actions));
      }
    }
  }

  return rows;
}

function proposalItemRow(
  collection: CollectionName,
  record: ChangeRecord,
  actions: StatePanelActions,
): HTMLElement {
  const draft = record.draft as Record<string, unknown>;
  const invalidation = record.kind === 'item_invalidated';
  const text = invalidation
    ? `Invalidate: ${String(draft.reason ?? '')}`
    : record.kind === 'item_updated'
      ? `Update: ${String(draft.text ?? draft.status ?? 'fields')}`
      : draftText(collection, draft);

  return el(
    'div',
    { class: 'item item-proposed' },
    el(
      'div',
      { class: 'item-main' },
      el('span', {
        class: `prov prov-${record.provenance}`,
        text: 'Proposed',
        title: provenanceLabel(record.provenance),
      }),
      el('span', { class: 'item-text', text }),
    ),
    el(
      'div',
      { class: 'item-meta' },
      el('span', { class: 'chip', text: CHANGE_KIND_LABELS[record.kind] }),
      invalidation ? el('span', { class: 'chip chip-severity-major', text: 'supersedes recorded state' }) : null,
    ),
    affectedLine(record),
    reviewButtons(record, actions),
  );
}

function draftText(collection: CollectionName, draft: Record<string, unknown>): string {
  for (const key of ['text', 'claim', 'question', 'name', 'reason']) {
    const value = draft[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return COLLECTION_LABELS[collection];
}

function affectedLine(record: ChangeRecord): Child {
  const areas = record.affects.areas;
  if (areas.length === 0) return null;
  return el(
    'div',
    { class: 'review-affected' },
    'Affects: ',
    el('span', { text: areas.join(' · ') }),
  );
}

function proposalRow(
  label: string,
  text: string,
  record: ChangeRecord,
  actions: StatePanelActions,
): HTMLElement {
  return el(
    'div',
    { class: 'item item-proposed' },
    el('div', { class: 'item-detail', text: label }),
    el('div', { class: 'item-text', text }),
    affectedLine(record),
    reviewButtons(record, actions),
  );
}

/**
 * Inline "add your own evidence" form. Kept in the Evidence section head because
 * that is where a user looks when they notice a claim has no source behind it.
 */
function evidenceForm(actions: StatePanelActions): HTMLElement {
  const host = el('div');
  const fields = {
    claim: el('input', { type: 'text', placeholder: 'The claim, stated precisely' }) as HTMLInputElement,
    title: el('input', { type: 'text', placeholder: 'Source title' }) as HTMLInputElement,
    locator: el('input', { type: 'text', placeholder: 'URL, DOI or citation' }) as HTMLInputElement,
    relevance: el('input', { type: 'text', placeholder: 'Why it matters to this idea' }) as HTMLInputElement,
    confidence: el('input', { type: 'number', value: '0.7' }) as HTMLInputElement,
  };
  fields.confidence.min = '0';
  fields.confidence.max = '1';
  fields.confidence.step = '0.05';

  const error = el('div', { class: 'review-note' });
  error.hidden = true;

  const close = (): void => {
    host.replaceChildren(openButton());
  };

  const submit = (): void => {
    const confidence = Number(fields.confidence.value);
    const missing = [
      ['claim', fields.claim.value],
      ['source title', fields.title.value],
      ['source locator', fields.locator.value],
      ['relevance', fields.relevance.value],
    ].filter(([, value]) => !String(value).trim());

    if (missing.length > 0) {
      error.textContent = `A source needs ${missing.map(([name]) => name).join(', ')}. An unsourced claim is a suggestion, not evidence.`;
      error.hidden = false;
      return;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      error.textContent = 'Confidence must be between 0 and 1.';
      error.hidden = false;
      return;
    }

    actions.onAddEvidence({
      claim: fields.claim.value.trim(),
      source_title: fields.title.value.trim(),
      source_locator: fields.locator.value.trim(),
      relevance: fields.relevance.value.trim(),
      confidence,
    });
    close();
  };

  function openButton(): HTMLElement {
    return button('Add evidence', {
      class: 'btn-sm',
      title: 'Record a source you have actually consulted',
      onClick: () => host.replaceChildren(form()),
    });
  }

  function form(): HTMLElement {
    const row = (label: string, input: HTMLInputElement, hint?: string): HTMLElement =>
      el(
        'div',
        { class: 'field' },
        el('label', { text: label }),
        input,
        hint ? el('div', { class: 'field-hint', text: hint }) : null,
      );

    for (const input of Object.values(fields)) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
        if (event.key === 'Escape') close();
      });
    }

    return el(
      'div',
      { class: 'review-card' },
      row('Claim', fields.claim),
      row('Source title', fields.title),
      row(
        'Source locator',
        fields.locator,
        'Only http(s) locators become links; anything else is stored as text.',
      ),
      row('Relevance', fields.relevance),
      row('Confidence (0–1)', fields.confidence),
      error,
      el(
        'div',
        { class: 'review-actions' },
        button('Save as evidence', { class: 'btn-sm btn-primary', onClick: submit }),
        button('Cancel', { class: 'btn-sm btn-ghost', onClick: close }),
      ),
    );
  }

  host.replaceChildren(openButton());
  return host;
}

/** Accept / Reject, shared with the review queue so both behave identically. */
export function reviewButtons(record: ChangeRecord, actions: StatePanelActions): HTMLElement {
  return el(
    'div',
    { class: 'review-actions' },
    button('Accept', {
      class: 'btn-sm btn-primary',
      onClick: () => actions.onAcceptChange(record.id),
    }),
    button('Reject', {
      class: 'btn-sm btn-danger',
      onClick: () => actions.onRejectChange(record.id),
    }),
  );
}
