/**
 * Settings modal.
 *
 * Provider choice lives here and nowhere else in the UI, which is the visible half
 * of the rule that Ideno Core never mentions a provider. The one secret in the
 * system — an API key for an OpenAI-compatible endpoint — is handled with its
 * trade-off stated on screen rather than hidden in documentation.
 */
import { SettingsSchema, type ProviderId, type Settings } from '../../ai/settings.js';
import { webSearchModelLooksSupported } from '../../ai/research/puter_web_search.js';
import type { ModelInfo, ProviderAvailability } from '../../ai/provider_interface/provider.js';
import { button, el } from '../dom.js';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  puter: 'Puter.js (no API key — your Puter account pays)',
  openai_compatible: 'OpenAI-compatible endpoint (API key)',
  scripted: 'Scripted offline demo (no model calls)',
};

export interface SettingsModalInput {
  settings: Settings;
  apiKey: string | null;
  availability: ProviderAvailability | null;
  providerLabel: string;
  models: ModelInfo[];
  onSave(settings: Settings, apiKey: string | null): void;
  onClose(): void;
  onSignIn(): void;
  onRefreshModels(): void;
  notice: string | null;
}

export function renderSettingsModal(input: SettingsModalInput): HTMLElement {
  const draft: Settings = structuredClone(input.settings);
  let apiKey = input.apiKey ?? '';
  let error: string | null = null;

  const backdrop = el('div', {
    class: 'modal-backdrop',
    role: 'dialog',
    ariaLabel: 'Ideno settings',
    onClick: (event) => {
      if (event.target === backdrop) input.onClose();
    },
  });

  const errorLine = el('div', { class: 'review-note' });

  const puterModelField = el('div', { class: 'field' });
  const openaiFields = el('div', null);

  const rebuildProviderFields = (): void => {
    puterModelField.replaceChildren(
      el('label', { text: 'Model' }),
      input.models.length > 0
        ? selectFromModels(draft.puter_model, input.models, (value) => {
            draft.puter_model = value || null;
          })
        : el('input', {
            type: 'text',
            value: draft.puter_model ?? '',
            placeholder: 'Leave empty for the provider default',
            onInput: (event) => {
              draft.puter_model = (event.target as HTMLInputElement).value.trim() || null;
            },
          }),
      el('div', {
        class: 'field-hint',
        text:
          input.models.length > 0
            ? 'Listed by the provider just now.'
            : 'Ideno could not list models from this provider, so type an id — or leave it empty to use the provider default.',
      }),
    );

    openaiFields.replaceChildren(
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Base URL' }),
        el('input', {
          type: 'url',
          value: draft.openai.base_url,
          placeholder: 'https://api.openai.com/v1',
          onInput: (event) => {
            draft.openai.base_url = (event.target as HTMLInputElement).value.trim();
          },
        }),
        el('div', {
          class: 'field-hint',
          text: 'Anything speaking the OpenAI chat completions protocol. Plain http is only accepted for loopback hosts.',
        }),
      ),
      el(
        'div',
        { class: 'field-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Model id' }),
          el('input', {
            type: 'text',
            value: draft.openai.model,
            placeholder: 'gpt-4o-mini',
            onInput: (event) => {
              draft.openai.model = (event.target as HTMLInputElement).value.trim();
            },
          }),
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'API key' }),
          el('input', {
            type: 'password',
            value: apiKey,
            placeholder: draft.openai.persist_api_key ? '' : 'Held in memory only',
            onInput: (event) => {
              apiKey = (event.target as HTMLInputElement).value;
            },
          }),
        ),
      ),
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          onInput: (event) => {
            draft.openai.json_mode = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', {
          text: 'This endpoint supports response_format: json_object (Ideno validates the output either way).',
        }),
      ),
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          onInput: (event) => {
            draft.openai.persist_api_key = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', {
          text: 'Remember the key in this browser. Anything stored here is readable by every script on this origin — leave this off unless it is your own machine.',
        }),
      ),
    );

    // Set checkbox states after rebuilding, since new elements start unchecked.
    const checkboxes = openaiFields.querySelectorAll('input[type="checkbox"]');
    if (checkboxes[0]) (checkboxes[0] as HTMLInputElement).checked = draft.openai.json_mode;
    if (checkboxes[1]) (checkboxes[1] as HTMLInputElement).checked = draft.openai.persist_api_key;

    puterModelField.hidden = draft.provider_id !== 'puter';
    openaiFields.hidden = draft.provider_id !== 'openai_compatible';
  };

  rebuildProviderFields();

  const save = (): void => {
    const parsed = SettingsSchema.safeParse(draft);
    if (!parsed.success) {
      error = `Settings are not valid: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`;
      errorLine.textContent = error;
      errorLine.hidden = false;
      return;
    }
    input.onSave(parsed.data, draft.openai.persist_api_key ? apiKey : null);
  };

  const modal = el(
    'div',
    { class: 'modal' },
    el('h2', { text: 'Settings' }),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'AI provider' }),
      el(
        'select',
        {
          onChange: (event) => {
            draft.provider_id = (event.target as HTMLSelectElement).value as ProviderId;
            rebuildProviderFields();
          },
        },
        (Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) =>
          el('option', { value: id, text: PROVIDER_LABELS[id] }),
        ),
      ),
      el('div', {
        class: 'field-hint',
        text: 'Ideno Core never contains provider-specific logic; adapters live in src/ai/providers/.',
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'Provider status' }),
      el(
        'div',
        { class: 'pill-wrap' },
        el(
          'span',
          { class: `pill ${input.availability?.available ? 'pill-ok' : 'pill-warn'}` },
          el('span', { class: 'pill-dot' }),
          el('span', {
            text: input.availability?.available
              ? `${input.providerLabel} is ready`
              : `${input.providerLabel}: ${input.availability?.reason ?? 'not checked yet'}`,
          }),
        ),
        input.availability?.action === 'sign_in'
          ? button('Sign in', { class: 'btn-sm', onClick: input.onSignIn })
          : null,
        draft.provider_id === 'puter'
          ? button('Refresh model list', { class: 'btn-sm', onClick: input.onRefreshModels })
          : null,
      ),
    ),
    puterModelField,
    openaiFields,
    draft.provider_id === 'scripted'
      ? el('div', {
          class: 'field-hint',
          text: 'The scripted provider replays the five-step greenhouse scenario. It never calls a model, and every turn it produces is labelled in the conversation.',
        })
      : null,
    el('div', { class: 'modal-section-title', text: 'How Ideno works with you' }),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'Review policy' }),
      el(
        'select',
        {
          onChange: (event) => {
            draft.review_mode = (event.target as HTMLSelectElement).value as Settings['review_mode'];
          },
        },
        el('option', { value: 'assisted', text: 'Assisted — apply what you said, queue what Ideno inferred' }),
        el('option', { value: 'strict', text: 'Strict — queue every change Ideno proposes' }),
      ),
      el('div', {
        class: 'field-hint',
        text: 'Changes you make directly (your own decisions, evidence you supply) are never queued: asking you to approve your own click is not governance.',
      }),
    ),
    el(
      'div',
      { class: 'field-row' },
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Temperature' }),
        el('input', {
          type: 'number',
          value: String(draft.temperature),
          onInput: (event) => {
            draft.temperature = Number((event.target as HTMLInputElement).value);
          },
        }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Timeout (ms)' }),
        el('input', {
          type: 'number',
          value: String(draft.timeout_ms),
          onInput: (event) => {
            draft.timeout_ms = Number((event.target as HTMLInputElement).value);
          },
        }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Transcript turns in context' }),
        el('input', {
          type: 'number',
          value: String(draft.context_transcript_turns),
          onInput: (event) => {
            draft.context_transcript_turns = Number((event.target as HTMLInputElement).value);
          },
        }),
        el('div', {
          class: 'field-hint',
          text: 'The Idea State is always sent in full; this bounds how much raw conversation accompanies it.',
        }),
      ),
    ),
    el('div', { class: 'modal-section-title', text: 'Research' }),
    el(
      'div',
      { class: 'field' },
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          onChange: (event) => {
            draft.research.wikipedia = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', { text: 'Look things up on Wikipedia when Ideno runs a research turn' }),
      ),
      el('div', {
        class: 'field-hint',
        text:
          'Sends the research question to en.wikipedia.org, anonymously (origin=*), with no account and no key. ' +
          'Only the lead section of each article is read, so findings are recorded at reduced confidence and say so. ' +
          'Nothing is recorded without a title and a link you can follow.',
      }),
    ),
    el(
      'div',
      { class: 'field' },
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          onChange: (event) => {
            draft.research.puter_web_search = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', { text: 'Also use Puter web search (OpenAI-routed models only)' }),
      ),
      el('div', {
        class: 'field-hint',
        text: webSearchHint(draft),
      }),
    ),
    el('div', {
      class: 'field-hint',
      text:
        'Either source can return nothing, and that is reported rather than filled in. Ideno never records a citation it did not retrieve: an answer with no citation behind it is stored as a model suggestion, not as evidence.',
    }),
    input.notice ? el('div', { class: 'banner', text: input.notice }) : null,
    errorLine,
    el(
      'div',
      { class: 'modal-actions' },
      button('Cancel', { class: 'btn-ghost', onClick: input.onClose }),
      button('Save settings', { class: 'btn-primary', onClick: save }),
    ),
  );

  // Checkboxes are rebuilt with the draft's current values: a freshly created input
  // is unchecked regardless of what the setting says.
  const researchBoxes = [...modal.querySelectorAll<HTMLInputElement>('.checkbox input[type="checkbox"]')].slice(-2);
  if (researchBoxes[0]) researchBoxes[0].checked = draft.research.wikipedia;
  if (researchBoxes[1]) researchBoxes[1].checked = draft.research.puter_web_search;

  // Reflect the current selection in the two selects.
  const selects = modal.querySelectorAll('select');
  if (selects[0]) (selects[0] as HTMLSelectElement).value = draft.provider_id;
  if (selects[1]) (selects[1] as HTMLSelectElement).value = draft.review_mode;
  errorLine.hidden = true;

  backdrop.appendChild(modal);
  return backdrop;
}

function selectFromModels(
  current: string | null,
  models: ModelInfo[],
  onChange: (value: string) => void,
): HTMLSelectElement {
  const select = el(
    'select',
    { onChange: (event) => onChange((event.target as HTMLSelectElement).value) },
    el('option', { value: '', text: 'Provider default' }),
    models.map((model) =>
      el('option', {
        value: model.id,
        text: model.context_window ? `${model.label} · ${Math.round(model.context_window / 1000)}k ctx` : model.label,
      }),
    ),
  ) as HTMLSelectElement;
  select.value = current ?? '';
  if (select.value !== (current ?? '')) select.value = '';
  return select;
}

/**
 * What the web-search toggle can actually do with the current settings.
 *
 * States the preconditions rather than letting the user discover them by getting
 * nothing back: the tool is documented for OpenAI-routed models on Puter, so with any
 * other provider or model it would silently produce no findings.
 */
function webSearchHint(draft: Settings): string {
  if (draft.provider_id !== 'puter') {
    return 'Only available with the Puter provider, and only for models Puter routes to OpenAI. Your Puter account pays for these calls.';
  }
  if (!webSearchModelLooksSupported(draft.puter_model)) {
    return 'Needs an OpenAI-routed model (gpt-…, o…, or openai/…). No model is selected yet, or the one selected is not routed to OpenAI, so this would return nothing.';
  }
  return `Will search with ${draft.puter_model}. Your Puter account pays for these calls, and only cited statements are recorded.`;
}
