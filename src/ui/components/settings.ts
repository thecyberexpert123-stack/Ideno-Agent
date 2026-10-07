/**
 * The Settings modal.
 *
 * A pure function of its inputs: every control either mutates a local draft or calls an
 * action, and the app re-renders. That is what makes the discovery and test buttons
 * work — their results arrive as props, not as state poked into a view object, which is
 * the bug class this component has already been bitten by once.
 *
 * ## Drafts survive a re-render
 *
 * Discovery and probing cause a re-render, and a re-render rebuilds this component's
 * draft from `input.settings`. Without help that would silently discard everything the
 * user had typed but not saved — including the base URL they were in the middle of
 * testing. So both actions hand the current draft and its secrets back to the app, which
 * stores them and returns them as the next `input`.
 *
 * ## Secrets
 *
 * Keys are never rendered back from storage into a visible field unless they are already
 * in memory, and the persistence opt-in is stated in terms every time: anything written
 * to `localStorage` is readable by every script on the same origin.
 */
import type { Settings, ProviderId, AgentProfile } from '../../ai/settings.js';
import { MAX_AGENT_PROFILES, SettingsSchema, activeAgent, newAgentId } from '../../ai/settings.js';
import type { SettingsSecrets } from '../../ai/settings_store.js';
import { webSearchModelLooksSupported } from '../../ai/research/puter_web_search.js';
import type { ModelInfo, ProviderAvailability } from '../../ai/provider_interface/provider.js';
import { button, el } from '../dom.js';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  puter: 'Puter.js (no API key — your Puter account pays)',
  openai_compatible: 'Custom agent — any OpenAI-compatible endpoint (API key optional)',
  scripted: 'Scripted offline demo (no model calls)',
};

/**
 * The outcome of the last discovery or probe, as displayed.
 *
 * Carried as a prop rather than held here so that a re-render cannot lose it and so the
 * app can show a spinner while the request is in flight.
 */
export interface AgentCheckState {
  /** Which profile the result belongs to, so it is not shown against the wrong agent. */
  agentId: string;
  kind: 'discover' | 'probe';
  busy: boolean;
  ok: boolean;
  /** Models found, when `kind` is `discover` and it succeeded. */
  models: ModelInfo[];
  /** What to tell the user. Never contains a key. */
  message: string;
  /** Which model a probe was sent to. */
  model?: string;
  /** What the model replied, when `kind` is `probe` and it succeeded. */
  reply?: string;
  latencyMs?: number;
}

export interface SettingsModalInput {
  settings: Settings;
  /** Legacy single-endpoint key. Still honoured; folded into the active agent on save. */
  apiKey: string | null;
  /** Persisted or in-memory keys for each agent profile, by id. */
  agentApiKeys: Record<string, string>;
  tavilyApiKey: string | null;
  availability: ProviderAvailability | null;
  providerLabel: string;
  /** Models listed by the Puter provider. */
  models: ModelInfo[];
  /** Result of the last discovery or probe, if any. */
  agentCheck: AgentCheckState | null;
  onSave(settings: Settings, secrets: SettingsSecrets): void;
  onClose(): void;
  onSignIn(): void;
  onRefreshModels(): void;
  /** Hands the draft back so unsaved edits survive the re-render this triggers. */
  onDiscoverAgent(draft: Settings, secrets: SettingsSecrets, agentId: string): void;
  onProbeAgent(draft: Settings, secrets: SettingsSecrets, agentId: string): void;
  notice: string | null;
}

export function renderSettingsModal(input: SettingsModalInput): HTMLElement {
  const draft: Settings = structuredClone(input.settings);
  const keys: Record<string, string> = { ...input.agentApiKeys };
  let tavilyKey = input.tavilyApiKey ?? '';

  const errorLine = el('div', { class: 'review-note' });
  const puterModelField = el('div', { class: 'field' });
  const agentFields = el('div', null);

  /** The profile being edited, or null when there are none yet. */
  const currentAgent = (): AgentProfile | null => activeAgent(draft);

  const keyFor = (agent: AgentProfile | null): string | null =>
    agent ? keys[agent.id] ?? null : null;

  const secrets = (): SettingsSecrets => ({
    agentApiKeys: { ...keys },
    tavilyApiKey: draft.persist_tavily_api_key ? tavilyKey || null : null,
  });

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

    agentFields.replaceChildren(...renderAgentSection());

    puterModelField.hidden = draft.provider_id !== 'puter';
    agentFields.hidden = draft.provider_id !== 'openai_compatible';
  };

  /**
   * The custom-agent editor: a profile picker plus the fields of the selected profile.
   *
   * Returns a list rather than one element so the section can be empty when no profiles
   * exist yet, and say what to do about it.
   */
  function renderAgentSection(): HTMLElement[] {
    const agent = currentAgent();
    const check = input.agentCheck;
    const checkMatches = check && agent && check.agentId === agent.id ? check : null;

    if (draft.agents.length === 0) {
      return [
        el('div', { class: 'modal-section-title', text: 'Custom agent' }),
        el('div', {
          class: 'field-hint',
          text:
            'No agent is configured yet. Add one to point Ideno at any endpoint that speaks the ' +
            'OpenAI chat completions protocol — OpenAI itself, OpenRouter, Azure OpenAI, vLLM, ' +
            'LM Studio, or a local llama.cpp or Ollama server.',
        }),
        button('Add an agent', {
          class: 'btn-sm',
          onClick: () => {
            addAgent();
            rebuildProviderFields();
          },
        }),
      ];
    }

    if (!agent) return [];

    // Models discovered for this profile. A select is offered only when discovery
    // succeeded, matching how the Puter model field behaves — and the current value is
    // kept as an option even when the endpoint did not list it, so selecting a model
    // cannot silently erase one the user typed.
    const discovered = checkMatches?.kind === 'discover' && checkMatches.ok ? checkMatches.models : [];

    return [
      el('div', { class: 'modal-section-title', text: 'Custom agent' }),
      el(
        'div',
        { class: 'field-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Agent' }),
          agentSelect(agent.id, (value) => {
            draft.active_agent_id = value;
            rebuildProviderFields();
          }),
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Name' }),
          el('input', {
            type: 'text',
            value: agent.name,
            placeholder: 'Local llama.cpp',
            onInput: (event) => {
              agent.name = (event.target as HTMLInputElement).value.slice(0, 80);
            },
          }),
        ),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Base URL' }),
        el('input', {
          type: 'url',
          value: agent.base_url,
          placeholder: 'https://api.openai.com/v1',
          onInput: (event) => {
            agent.base_url = (event.target as HTMLInputElement).value.trim();
          },
        }),
        el('div', {
          class: 'field-hint',
          text:
            'Include the version path if the endpoint needs one (…/v1). Plain http is accepted only for ' +
            'loopback hosts, so a key can reach a local server but never the open internet.',
        }),
      ),
      el(
        'div',
        { class: 'field-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Model id' }),
          discovered.length > 0
            ? modelSelect(agent.model, discovered, (value) => {
                agent.model = value;
              })
            : el('input', {
                type: 'text',
                value: agent.model,
                placeholder: 'gpt-4o-mini',
                onInput: (event) => {
                  agent.model = (event.target as HTMLInputElement).value.trim();
                },
              }),
          el('div', {
            class: 'field-hint',
            text:
              discovered.length > 0
                ? `Listed by ${agent.base_url || 'that endpoint'} just now.`
                : 'Type an id, or use “Find models” to ask the endpoint what it serves.',
          }),
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'API key (optional)' }),
          el('input', {
            type: 'password',
            value: keyFor(agent) ?? '',
            placeholder: agent.persist_api_key ? '' : 'Held in memory only',
            onInput: (event) => {
              const value = (event.target as HTMLInputElement).value;
              if (value) keys[agent.id] = value;
              else delete keys[agent.id];
            },
          }),
          el('div', {
            class: 'field-hint',
            text:
              'Leave empty if the endpoint needs none — a local model server usually does not. ' +
              'Ideno sends no Authorization header at all in that case.',
          }),
        ),
      ),
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: agent.json_mode,
          onInput: (event) => {
            agent.json_mode = (event.target as HTMLInputElement).checked;
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
          checked: agent.persist_api_key,
          onInput: (event) => {
            agent.persist_api_key = (event.target as HTMLInputElement).checked;
            // Turning persistence off must drop the key from the stored set at once,
            // not merely stop writing it next time.
            if (!agent.persist_api_key) delete keys[agent.id];
            rebuildProviderFields();
          },
        }),
        el('span', {
          text:
            'Remember this key in the browser. Anything stored here is readable by every script on ' +
            'this origin — leave this off unless it is your own machine.',
        }),
      ),
      el(
        'div',
        { class: 'pill-wrap' },
        button(checkMatches?.kind === 'discover' && checkMatches.busy ? 'Finding models…' : 'Find models', {
          class: 'btn-sm',
          disabled: checkMatches?.busy === true || !agent.base_url,
          onClick: () => input.onDiscoverAgent(structuredClone(draft), secrets(), agent.id),
        }),
        button(checkMatches?.kind === 'probe' && checkMatches.busy ? 'Testing…' : 'Send a test message', {
          class: 'btn-sm',
          disabled: checkMatches?.busy === true || !agent.base_url || !agent.model,
          onClick: () => input.onProbeAgent(structuredClone(draft), secrets(), agent.id),
        }),
        draft.agents.length > 1
          ? button('Remove agent', {
              class: 'btn-sm btn-ghost',
              onClick: () => {
                removeAgent(agent.id);
                rebuildProviderFields();
              },
            })
          : null,
        draft.agents.length < MAX_AGENT_PROFILES
          ? button('Add another', {
              class: 'btn-sm btn-ghost',
              onClick: () => {
                addAgent();
                rebuildProviderFields();
              },
            })
          : null,
      ),
      el('div', {
        class: 'field-hint',
        text:
          '“Find models” asks the endpoint what it serves and costs nothing. “Send a test message” makes one ' +
          'real completion request, which spends a request on that account — it is the only way to prove the ' +
          'model answers, not just that the key is accepted.',
      }),
      checkMatches ? renderCheckResult(checkMatches) : null,
    ].filter((node): node is HTMLElement => node !== null);
  }

  function renderCheckResult(check: AgentCheckState): HTMLElement {
    if (check.busy) {
      return el('div', { class: 'banner', text: check.kind === 'discover' ? 'Asking the endpoint…' : 'Sending a test message…' });
    }
    if (!check.ok) {
      return el('div', { class: 'review-note', text: check.message });
    }
    if (check.kind === 'discover') {
      return el(
        'div',
        { class: 'banner' },
        el('span', {
          text: `${check.models.length} model${check.models.length === 1 ? '' : 's'} listed by that endpoint. Pick one above.`,
        }),
      );
    }
    return el(
      'div',
      { class: 'banner' },
      el('span', {
        text:
          `${check.model ?? 'That model'} answered in ${check.latencyMs ?? 0} ms.` +
          (check.reply ? ` It said: “${check.reply}”` : ''),
      }),
    );
  }

  function agentSelect(currentId: string, onChange: (value: string) => void): HTMLSelectElement {
    const select = el(
      'select',
      { onChange: (event) => onChange((event.target as HTMLSelectElement).value) },
      draft.agents.map((profile) =>
        el('option', {
          value: profile.id,
          text: profile.base_url ? `${profile.name} — ${profile.base_url}` : profile.name,
        }),
      ),
    ) as HTMLSelectElement;
    select.value = currentId;
    return select;
  }

  /** A model picker that keeps the current value even when the endpoint did not list it. */
  function modelSelect(
    current: string,
    models: ModelInfo[],
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const listed = models.some((model) => model.id === current);
    const select = el(
      'select',
      { onChange: (event) => onChange((event.target as HTMLSelectElement).value) },
      // Preserved explicitly: without it, choosing from the list would blank a model id
      // the user had typed and the endpoint had not advertised.
      current && !listed ? el('option', { value: current, text: `${current} (not listed)` }) : null,
      models.map((model) =>
        el('option', {
          value: model.id,
          text: model.context_window
            ? `${model.label} · ${Math.round(model.context_window / 1000)}k ctx`
            : model.label,
        }),
      ),
    ) as HTMLSelectElement;
    select.value = current;
    if (select.value !== current) select.value = models[0]?.id ?? '';
    return select;
  }

  function addAgent(): void {
    if (draft.agents.length >= MAX_AGENT_PROFILES) return;
    const id = newAgentId();
    draft.agents.push({
      id,
      name: `Agent ${draft.agents.length + 1}`,
      base_url: '',
      model: '',
      json_mode: false,
      persist_api_key: false,
    });
    draft.active_agent_id = id;
  }

  function removeAgent(id: string): void {
    // Refuses to remove the last profile: an empty list would leave the provider with no
    // configuration at all, and "remove this agent" is not the same request as "stop
    // being able to use a custom endpoint".
    if (draft.agents.length <= 1) return;
    const index = draft.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return;
    draft.agents.splice(index, 1);
    delete keys[id];
    if (draft.active_agent_id === id) {
      draft.active_agent_id = draft.agents[Math.max(0, index - 1)]?.id ?? draft.agents[0]?.id ?? null;
    }
  }

  rebuildProviderFields();

  const save = (): void => {
    // A profile with a name but no base URL is an unfinished thought, not a
    // configuration. Refusing to save it is kinder than saving something that cannot
    // work and reporting the failure later, mid-turn.
    const incomplete = draft.agents.filter((agent) => !agent.base_url.trim());
    if (draft.provider_id === 'openai_compatible' && incomplete.length > 0) {
      errorLine.textContent =
        incomplete.length === draft.agents.length
          ? 'Add a base URL for that agent, or switch to another provider.'
          : `Remove the unfinished agent${incomplete.length === 1 ? '' : 's'} or give ${incomplete.length === 1 ? 'it' : 'them'} a base URL.`;
      errorLine.hidden = false;
      return;
    }

    const parsed = SettingsSchema.safeParse(draft);
    if (!parsed.success) {
      errorLine.textContent = `Settings are not valid: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`;
      errorLine.hidden = false;
      return;
    }
    errorLine.hidden = true;
    input.onSave(parsed.data, secrets());
  };

  const modal = el(
    'div',
    { class: 'modal' },
    el('h2', { text: 'Settings' }),
    el(
      'div',
      { class: 'field' },
      el('label', { text: 'AI provider' }),
      providerSelect(draft.provider_id, (value) => {
        draft.provider_id = value;
        rebuildProviderFields();
      }),
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
    agentFields,
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
      reviewSelect(draft.review_mode, (value) => {
        draft.review_mode = value;
      }),
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
          checked: draft.research.wikipedia,
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
          checked: draft.research.puter_web_search,
          onChange: (event) => {
            draft.research.puter_web_search = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', { text: 'Also use Puter web search (OpenAI-routed models only)' }),
      ),
      el('div', { class: 'field-hint', text: webSearchHint(draft) }),
    ),
    el(
      'div',
      { class: 'field' },
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: draft.research.tavily,
          onChange: (event) => {
            draft.research.tavily = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', { text: 'Also search the web with Tavily (needs a Tavily API key)' }),
      ),
      el('div', { class: 'field-hint', text: tavilyHint(draft, tavilyKey) }),
      el(
        'div',
        { class: 'field-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Tavily API key' }),
          el('input', {
            type: 'password',
            value: tavilyKey,
            placeholder: draft.persist_tavily_api_key ? 'tvly-…' : 'Held in memory only',
            onInput: (event) => {
              tavilyKey = (event.target as HTMLInputElement).value;
            },
          }),
        ),
      ),
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: draft.persist_tavily_api_key,
          onChange: (event) => {
            // The key itself stays in the field either way; `secrets()` is what decides
            // whether it may be written to storage. Turning persistence off therefore
            // takes effect on save, without blanking what the user typed.
            draft.persist_tavily_api_key = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', {
          text:
            'Remember the Tavily key in the browser, with the same trade-off as an agent key: readable by ' +
            'every script on this origin. Off by default.',
        }),
      ),
      el('div', {
        class: 'field-hint',
        text:
          'Tavily sends each research question to api.tavily.com and bills your account per search. Only results ' +
          'with a title and a link are recorded, at reduced confidence, and Ideno never asks Tavily for a ' +
          'synthesised answer — an unattributed summary is a model suggestion, not evidence.',
      }),
    ),
    el('div', {
      class: 'field-hint',
      text:
        'Any source can return nothing, and that is reported rather than filled in. Ideno never records a ' +
        'citation it did not retrieve: an answer with no citation behind it is stored as a model suggestion, ' +
        'not as evidence.',
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

  const backdrop = el('div', {
    class: 'modal-backdrop',
    role: 'dialog',
    ariaLabel: 'Ideno settings',
    onClick: (event) => {
      if (event.target === backdrop) input.onClose();
    },
  });
  errorLine.hidden = true;
  backdrop.appendChild(modal);
  return backdrop;
}

function providerSelect(current: ProviderId, onChange: (value: ProviderId) => void): HTMLSelectElement {
  const select = el(
    'select',
    { onChange: (event) => onChange((event.target as HTMLSelectElement).value as ProviderId) },
    (Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) =>
      el('option', { value: id, text: PROVIDER_LABELS[id] }),
    ),
  ) as HTMLSelectElement;
  select.value = current;
  return select;
}

function reviewSelect(
  current: Settings['review_mode'],
  onChange: (value: Settings['review_mode']) => void,
): HTMLSelectElement {
  const select = el(
    'select',
    {
      onChange: (event) => onChange((event.target as HTMLSelectElement).value as Settings['review_mode']),
    },
    el('option', { value: 'assisted', text: 'Assisted — apply what you said, queue what Ideno inferred' }),
    el('option', { value: 'strict', text: 'Strict — queue every change Ideno proposes' }),
  ) as HTMLSelectElement;
  select.value = current;
  return select;
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
 * What the Puter web-search toggle can actually do with the current settings.
 *
 * States the preconditions rather than letting the user discover them by getting nothing
 * back: the tool is documented for OpenAI-routed models on Puter, so with any other
 * provider or model it would silently produce no findings.
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

/**
 * Whether Tavily can do anything with the current settings.
 *
 * Naming the missing piece is the difference between a toggle that appears broken and one
 * that says what it needs.
 */
function tavilyHint(draft: Settings, key: string): string {
  if (!draft.research.tavily) return 'Off. Switching it on needs a Tavily API key from app.tavily.com.';
  if (!key.trim()) {
    return 'On, but no key is set — Tavily will not be consulted until you add one. Nothing fails loudly: the source simply is not registered.';
  }
  return 'On. Each research turn sends its questions to Tavily and bills your account per search.';
}
