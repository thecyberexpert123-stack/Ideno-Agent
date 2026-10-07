/**
 * The conversation surface.
 *
 * The chat is the interface, not the product, so it stays deliberately plain:
 * messages, one question card per turn, and honest notices when something failed.
 * Nothing here renders model output as markup — text is text.
 */
import type { Operation, TranscriptEntry } from '../../core/schemas/index.js';
import { button, details, el, type Child } from '../dom.js';
import { formatTime } from '../format.js';

export interface ComposerHandlers {
  draft: string;
  busy: boolean;
  hasSession: boolean;
  onDraftChange(text: string): void;
  onSend(): void;
  onOperation(operation: Operation): void;
}

export interface StartScreenHandlers {
  draft: string;
  onDraftChange(text: string): void;
  onStart(): void;
  onDemo(): void;
  providerNotice: string | null;
  providerLabel: string;
  providerReady: boolean;
  onOpenSettings(): void;
  storageWarning: string | null;
}

export function renderStartScreen(handlers: StartScreenHandlers): HTMLElement {
  const textarea = el('textarea', {
    value: handlers.draft,
    placeholder:
      'e.g. I want to build a small autonomous greenhouse. / An automatic plant watering system. / A device that …',
    ariaLabel: 'Describe your idea',
    onInput: (event) => handlers.onDraftChange((event.target as HTMLTextAreaElement).value),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handlers.onStart();
      }
    },
  });

  return el(
    'div',
    { class: 'start' },
    el('h2', { text: 'Give Ideno a rough idea' }),
    el(
      'p',
      null,
      'It does not have to be complete or well explained. Ideno turns it into a structured Idea State — goal, requirements, assumptions, constraints, unknowns, evidence, alternatives and decisions — and keeps that state as the record of the idea. You stay the decision-maker: anything Ideno infers is proposed for you to accept or reject, and every change is versioned.',
    ),
    textarea,
    el(
      'div',
      { class: 'start-actions' },
      button('Start developing', {
        class: 'btn-primary',
        disabled: handlers.draft.trim().length === 0,
        onClick: handlers.onStart,
      }),
      button('Run the labelled offline demo', {
        class: 'btn',
        title: 'Replays the five-step greenhouse scenario without calling any model',
        onClick: handlers.onDemo,
      }),
      el(
        'span',
        {
          class: `pill ${handlers.providerReady ? 'pill-ok' : 'pill-warn'}`,
          title: handlers.providerNotice ?? '',
        },
        el('span', { class: 'pill-dot' }),
        el('span', { text: handlers.providerLabel }),
      ),
      button('Settings', { class: 'btn-ghost', onClick: handlers.onOpenSettings }),
    ),
    handlers.providerNotice
      ? el('p', { text: handlers.providerNotice })
      : null,
    handlers.storageWarning ? el('p', { text: handlers.storageWarning }) : null,
    el(
      'div',
      { class: 'legend' },
      el('span', { class: 'prov prov-user_stated', text: 'Known — you stated it' }),
      el('span', { class: 'prov prov-model_inferred', text: 'Assumed — Ideno inferred it' }),
      el('span', { class: 'prov prov-unknown', text: 'Unknown — a named gap' }),
      el('span', { class: 'prov prov-evidence_supported', text: 'Supported by evidence' }),
      el('span', { class: 'prov prov-model_suggestion', text: 'Model suggestion' }),
      el('span', { class: 'prov prov-user_decision', text: 'Your decision' }),
    ),
  );
}

export function renderMessage(entry: TranscriptEntry): HTMLElement {
  if (entry.role === 'system') return renderSystemNotice(entry);

  const isUser = entry.role === 'user';
  const meta: Child[] = [
    el('span', { text: isUser ? 'You' : 'Ideno' }),
    el('span', { text: formatTime(entry.created_at) }),
  ];
  if (!isUser && entry.operation) meta.push(el('span', { class: 'chip', text: entry.operation }));
  if (!isUser && entry.classification) {
    meta.push(el('span', { class: 'chip', text: `read as: ${entry.classification.replace(/_/g, ' ')}` }));
  }

  return el(
    'div',
    { class: `message message-${entry.role}` },
    el('div', { class: 'bubble', text: entry.text }),
    el('div', { class: 'message-meta' }, meta),
    !isUser && entry.reasoning_summary
      ? details('Why', el('div', { class: 'item-detail', text: entry.reasoning_summary }))
      : null,
    entry.question ? renderQuestion(entry) : null,
  );
}

function renderQuestion(entry: TranscriptEntry): HTMLElement {
  const question = entry.question;
  if (!question) return el('span');
  return el(
    'div',
    { class: 'question-card' },
    el('div', { class: 'question-card-label', text: `One question · ${question.impact} impact` }),
    el('div', { text: question.text }),
    el('div', { class: 'question-card-why', text: question.why_it_matters }),
  );
}

function renderSystemNotice(entry: TranscriptEntry): HTMLElement {
  return el(
    'div',
    { class: `message message-system ${entry.error_code ? 'message-error' : ''}` },
    el(
      'div',
      { class: 'bubble' },
      entry.text,
      entry.raw_text
        ? details('Show the unusable model response', el('pre', { class: 'code', text: entry.raw_text }))
        : null,
    ),
    el(
      'div',
      { class: 'message-meta' },
      el('span', { text: entry.error_code ? `Ideno · ${entry.error_code}` : 'Ideno' }),
      el('span', { text: formatTime(entry.created_at) }),
    ),
  );
}

/**
 * The "Ideno is working" indicator.
 *
 * `preview` is what the model has produced so far when the provider streams. It is
 * rendered as a separate, visibly provisional line: a partial response is not a
 * reply, and showing it in the same voice as one would misrepresent both.
 */
export function renderThinking(detail: string, preview?: string | null): HTMLElement {
  return el(
    'div',
    { class: 'thinking', role: 'status', ariaLabel: 'Ideno is working' },
    el('span', { class: 'spinner' }),
    el('span', { text: detail }),
    preview
      ? el('span', {
          class: 'thinking-preview',
          text: preview,
          title: 'Still arriving, and not yet validated. Nothing has been changed.',
        })
      : null,
  );
}

export function renderComposer(handlers: ComposerHandlers): HTMLElement {
  const textarea = el('textarea', {
    value: handlers.draft,
    placeholder: handlers.hasSession
      ? 'Add information, change your mind, ask for alternatives, or decide…'
      : 'Describe the idea to begin…',
    ariaLabel: 'Message Ideno',
    disabled: handlers.busy,
    onInput: (event) => handlers.onDraftChange((event.target as HTMLTextAreaElement).value),
    onKeyDown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handlers.onSend();
      }
    },
  });

  const operationButtons: Child[] = handlers.hasSession
    ? [
        button('Critique', {
          class: 'btn-sm',
          disabled: handlers.busy,
          title: 'Pressure-test the idea as it currently stands',
          onClick: () => handlers.onOperation('critique'),
        }),
        button('Alternatives', {
          class: 'btn-sm',
          disabled: handlers.busy,
          title: 'Widen the design space',
          onClick: () => handlers.onOperation('explore'),
        }),
        button('Research review', {
          class: 'btn-sm',
          disabled: handlers.busy,
          title: 'Separate what is known from what is assumed',
          onClick: () => handlers.onOperation('research'),
        }),
      ]
    : [];

  return el(
    'form',
    {
      class: 'composer',
      onSubmit: (event) => {
        event.preventDefault();
        handlers.onSend();
      },
    },
    operationButtons.length > 0
      ? el('div', { class: 'composer-hint' }, el('span', { text: 'Ask Ideno to:' }), operationButtons)
      : null,
    el(
      'div',
      { class: 'composer-row' },
      textarea,
      button(handlers.busy ? 'Working…' : 'Send', {
        class: 'btn-primary',
        type: 'submit',
        disabled: handlers.busy || handlers.draft.trim().length === 0,
      }),
    ),
    el(
      'div',
      { class: 'composer-hint' },
      el('span', { text: 'Enter sends · Shift+Enter adds a line' }),
      el('span', { text: 'Ideno asks at most one question per turn, and only when it would change the design.' }),
    ),
  );
}
