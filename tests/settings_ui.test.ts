// @vitest-environment jsdom
/**
 * The Settings modal: custom agent profiles, discovery, probing, and Tavily.
 *
 * The component is a pure function of its inputs, so these tests drive it the way the
 * app does — render, click, assert on what a user would read — and check the properties
 * that are easy to get wrong in a form:
 *
 *  - a discovery result is shown against the agent it belongs to, not whichever one is
 *    open now;
 *  - picking a model from a discovered list cannot blank one the user typed;
 *  - an unfinished profile is refused at save rather than stored broken;
 *  - the API key is presented as optional, because a local server needs none;
 *  - a key is never rendered as visible text.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_LABELS,
  renderSettingsModal,
  type AgentCheckState,
  type SettingsModalInput,
} from '../src/ui/components/settings.js';
import { MAX_AGENT_PROFILES, SettingsSchema, newAgentId, type Settings } from '../src/ai/settings.js';
import type { SettingsSecrets } from '../src/ai/settings_store.js';
import type { ModelInfo } from '../src/ai/provider_interface/provider.js';

function agentProfile(overrides: Partial<{ id: string; name: string; base_url: string; model: string; persist_api_key: boolean }> = {}) {
  return {
    id: overrides.id ?? 'agent_a',
    name: overrides.name ?? 'Local server',
    base_url: overrides.base_url ?? 'http://127.0.0.1:8080/v1',
    model: overrides.model ?? 'llama3.1',
    json_mode: false,
    persist_api_key: overrides.persist_api_key ?? false,
  };
}

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return SettingsSchema.parse({
    provider_id: 'openai_compatible',
    agents: [agentProfile()],
    active_agent_id: 'agent_a',
    ...overrides,
  });
}

interface Recorded {
  saved: { settings: Settings; secrets: SettingsSecrets } | null;
  discovered: { draft: Settings; secrets: SettingsSecrets; agentId: string } | null;
  probed: { draft: Settings; secrets: SettingsSecrets; agentId: string } | null;
}

function render(input: Partial<SettingsModalInput> = {}): { root: HTMLElement; recorded: Recorded } {
  const recorded: Recorded = { saved: null, discovered: null, probed: null };
  const full: SettingsModalInput = {
    settings: settingsWith(),
    apiKey: null,
    agentApiKeys: {},
    tavilyApiKey: null,
    availability: { available: true },
    providerLabel: PROVIDER_LABELS.openai_compatible,
    models: [],
    agentCheck: null,
    onSave: (settings, secrets) => {
      recorded.saved = { settings, secrets };
    },
    onClose: () => undefined,
    onSignIn: () => undefined,
    onRefreshModels: () => undefined,
    onDiscoverAgent: (draft, secrets, agentId) => {
      recorded.discovered = { draft, secrets, agentId };
    },
    onProbeAgent: (draft, secrets, agentId) => {
      recorded.probed = { draft, secrets, agentId };
    },
    notice: null,
    ...input,
  };
  const root = renderSettingsModal(full);
  document.body.replaceChildren(root);
  return { root, recorded };
}

function text(node: HTMLElement): string {
  return node.textContent ?? '';
}

function buttonsIn(root: HTMLElement, label: string | RegExp): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].filter((node) =>
    label instanceof RegExp ? label.test(node.textContent ?? '') : (node.textContent ?? '').includes(label),
  );
}

function inputsIn(root: HTMLElement, type: string): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`)];
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setValue(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('provider labels', () => {
  it('says the key is optional, because for a local server it is', () => {
    expect(PROVIDER_LABELS.openai_compatible).toMatch(/API key optional/);
  });

  it('still offers all three providers, none removed', () => {
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual(['openai_compatible', 'puter', 'scripted']);
  });
});

describe('the agent editor', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('offers to add an agent when none exist yet', () => {
    const { root } = render({ settings: SettingsSchema.parse({ provider_id: 'openai_compatible' }) });
    expect(text(root)).toContain('No agent is configured yet');
    expect(buttonsIn(root, 'Add an agent')).toHaveLength(1);
  });

  it('shows the configured agent with its base URL and model', () => {
    const { root } = render();
    expect(text(root)).toContain('Custom agent');
    const urls = inputsIn(root, 'url');
    expect(urls[0]?.value).toBe('http://127.0.0.1:8080/v1');
    expect(texts(root)).toContain('llama3.1');
  });

  it('labels the key optional and explains what happens without one', () => {
    const { root } = render();
    expect(text(root)).toContain('API key (optional)');
    expect(text(root)).toMatch(/Leave empty if the endpoint needs none/);
    expect(text(root)).toMatch(/sends no Authorization header/);
  });

  it('never renders a stored key as visible text', () => {
    const { root } = render({ agentApiKeys: { agent_a: 'sk-secret-value' } });
    const keyField = inputsIn(root, 'password').find((node) => node.value === 'sk-secret-value');
    expect(keyField).toBeTruthy();
    // The value is in a password field, and must not appear anywhere as text.
    expect(text(root)).not.toContain('sk-secret-value');
  });

  it('hides the agent editor entirely for another provider', () => {
    const { root } = render({ settings: settingsWith({ provider_id: 'puter' }) });
    // Same approach the modal already uses for the Puter and OpenAI-compatible fields:
    // build once, hide with the `hidden` attribute (display:none, out of the a11y tree).
    const title = [...root.querySelectorAll<HTMLElement>('.modal-section-title')].find(
      (node) => text(node) === 'Custom agent',
    );
    const container = title?.parentElement;
    expect(container?.hidden).toBe(true);
    expect(text(container ?? root)).toContain('Custom agent');
  });
});

function texts(root: HTMLElement): string[] {
  return [...root.querySelectorAll('input')].map((node) => (node as HTMLInputElement).value);
}

/** The container holding the whole agent editor, found by its own heading. */
function agentContainer(root: HTMLElement): HTMLElement | undefined {
  const title = [...root.querySelectorAll<HTMLElement>('.modal-section-title')].find(
    (node) => text(node) === 'Custom agent',
  );
  return title?.parentElement ?? undefined;
}

describe('adding, switching and removing agents', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('adds a profile and makes it the active one', () => {
    const { root } = render();
    click(buttonsIn(root, 'Add another')[0]!);
    // A fresh profile is selected, so its base URL field is empty and ready to fill in.
    expect(inputsIn(root, 'url')[0]?.value).toBe('');
  });

  it('refuses to remove the last profile, so the provider is never left unconfigurable', () => {
    const { root } = render();
    expect(buttonsIn(root, 'Remove agent')).toHaveLength(0);
  });

  it('removes one of several and keeps a valid selection', () => {
    const { root } = render({
      settings: settingsWith({
        agents: [agentProfile({ id: 'a' }), agentProfile({ id: 'b', name: 'Second', base_url: 'https://b.test/v1' })],
        active_agent_id: 'b',
      }),
    });
    expect(buttonsIn(root, 'Remove agent')).toHaveLength(1);
    click(buttonsIn(root, 'Remove agent')[0]!);
    expect(inputsIn(root, 'url')[0]?.value).toBe('http://127.0.0.1:8080/v1');
  });

  it('stops offering new profiles at the cap', () => {
    const many = Array.from({ length: MAX_AGENT_PROFILES }, (_, index) =>
      agentProfile({ id: `a${index}`, name: `Agent ${index}` }),
    );
    const { root } = render({ settings: settingsWith({ agents: many, active_agent_id: 'a0' }) });
    expect(buttonsIn(root, 'Add another')).toHaveLength(0);
  });

  it('switching profile shows that profile own fields', () => {
    const { root } = render({
      settings: settingsWith({
        agents: [
          agentProfile({ id: 'a', base_url: 'https://a.test/v1', model: 'model-a' }),
          agentProfile({ id: 'b', name: 'Second', base_url: 'https://b.test/v1', model: 'model-b' }),
        ],
        active_agent_id: 'a',
      }),
    });
    expect(inputsIn(root, 'url')[0]?.value).toBe('https://a.test/v1');

    // The provider picker comes first in the modal, so the agent picker has to be
    // identified by what it offers rather than by position.
    const picker = [...root.querySelectorAll<HTMLSelectElement>('select')].find((node) =>
      [...node.options].some((option) => option.value === 'b'),
    )!;
    expect(picker).toBeTruthy();

    picker.value = 'b';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(inputsIn(root, 'url')[0]?.value).toBe('https://b.test/v1');

    // Scoped to the agent section: the first text input in the modal is the workspace name.
    const agentSection = agentContainer(root)!;
    const nameField = [...agentSection.querySelectorAll<HTMLInputElement>('input[type="text"]')][0];
    expect(nameField?.value).toBe('Second');
  });
});

describe('discovery and probing', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('offers both, and says which one costs money', () => {
    const { root } = render();
    expect(buttonsIn(root, 'Find models')).toHaveLength(1);
    expect(buttonsIn(root, 'Send a test message')).toHaveLength(1);
    expect(text(root)).toMatch(/costs nothing/);
    expect(text(root)).toMatch(/spends a request on that account/);
  });

  it('disables both until there is a base URL to ask', () => {
    const { root } = render({
      settings: settingsWith({ agents: [agentProfile({ base_url: '' })] }),
    });
    expect(buttonsIn(root, 'Find models')[0]?.disabled).toBe(true);
    expect(buttonsIn(root, 'Send a test message')[0]?.disabled).toBe(true);
  });

  it('disables the test until a model is chosen', () => {
    const { root } = render({
      settings: settingsWith({ agents: [agentProfile({ model: '' })] }),
    });
    expect(buttonsIn(root, 'Find models')[0]?.disabled).toBe(false);
    expect(buttonsIn(root, 'Send a test message')[0]?.disabled).toBe(true);
  });

  it('hands the draft back so unsaved edits survive the re-render', () => {
    const { root, recorded } = render();
    setValue(inputsIn(root, 'url')[0]!, 'https://typed-but-not-saved.test/v1');
    click(buttonsIn(root, 'Find models')[0]!);

    expect(recorded.discovered).not.toBeNull();
    expect(recorded.discovered?.agentId).toBe('agent_a');
    // The whole point: the app re-renders from this draft, so what was typed is not lost.
    expect(recorded.discovered?.draft.agents[0]?.base_url).toBe('https://typed-but-not-saved.test/v1');
  });

  it('sends the key the user typed, even though it was never saved', () => {
    const { root, recorded } = render();
    const keyField = inputsIn(root, 'password')[0]!;
    setValue(keyField, 'sk-just-typed');
    click(buttonsIn(root, 'Send a test message')[0]!);

    expect(recorded.probed?.secrets.agentApiKeys?.agent_a).toBe('sk-just-typed');
  });

  it('shows how many models an endpoint listed', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'discover',
      busy: false,
      ok: true,
      models: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] as ModelInfo[],
      message: '',
    };
    const { root } = render({ agentCheck: check });
    expect(text(root)).toContain('2 models listed by that endpoint');
  });

  it('offers the discovered models as a picker', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'discover',
      busy: false,
      ok: true,
      models: [
        { id: 'discovered-one', label: 'discovered-one' },
        { id: 'discovered-two', label: 'discovered-two' },
      ] as ModelInfo[],
      message: '',
    };
    const { root } = render({ agentCheck: check });
    const options = [...root.querySelectorAll('option')].map((node) => node.textContent ?? '');
    expect(options).toContain('discovered-one');
    expect(options).toContain('discovered-two');
  });

  it('keeps a typed model selectable even when the endpoint did not list it', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'discover',
      busy: false,
      ok: true,
      models: [{ id: 'other-model', label: 'other-model' }] as ModelInfo[],
      message: '',
    };
    const { root } = render({ agentCheck: check });
    const options = [...root.querySelectorAll('option')].map((node) => node.textContent ?? '');
    // Without this, choosing from the list would silently blank the user's model id.
    expect(options.some((option) => option.includes('llama3.1'))).toBe(true);
    expect(options.some((option) => option.includes('not listed'))).toBe(true);
  });

  it('does not show one agent result against a different agent', () => {
    const check: AgentCheckState = {
      agentId: 'some_other_agent',
      kind: 'discover',
      busy: false,
      ok: true,
      models: [{ id: 'x', label: 'x' }] as ModelInfo[],
      message: '',
    };
    const { root } = render({ agentCheck: check });
    expect(text(root)).not.toContain('listed by that endpoint');
  });

  it('reports a failed lookup in the endpoint own words', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'discover',
      busy: false,
      ok: false,
      models: [],
      message: 'https://api.example.com/v1/models does not implement a model list (HTTP 404).',
    };
    const { root } = render({ agentCheck: check });
    expect(text(root)).toContain('does not implement a model list');
  });

  it('says a probe is running rather than looking frozen', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'probe',
      busy: true,
      ok: false,
      models: [],
      message: '',
    };
    const { root } = render({ agentCheck: check });
    expect(text(root)).toContain('Sending a test message…');
    // Both buttons are disabled while a check is in flight, so a second click cannot
    // start a duplicate request against a paid endpoint.
    expect(buttonsIn(root, 'Testing…')[0]?.disabled).toBe(true);
    expect(buttonsIn(root, 'Find models')[0]?.disabled).toBe(true);
  });

  it('reports what the model answered and how long it took', () => {
    const check: AgentCheckState = {
      agentId: 'agent_a',
      kind: 'probe',
      busy: false,
      ok: true,
      models: [],
      message: '',
      model: 'llama3.1',
      reply: 'ready',
      latencyMs: 412,
    };
    const { root } = render({ agentCheck: check });
    expect(text(root)).toContain('llama3.1 answered in 412 ms');
    expect(text(root)).toContain('ready');
  });
});

describe('saving', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('refuses to save a profile with no base URL, and says what to do', () => {
    const { root, recorded } = render({
      settings: settingsWith({ agents: [agentProfile({ base_url: '' })] }),
    });
    click(buttonsIn(root, 'Save settings')[0]!);

    expect(recorded.saved).toBeNull();
    expect(text(root)).toMatch(/Add a base URL for that agent, or switch to another provider/);
  });

  it('names the unfinished profile when others beside it are complete', () => {
    const { root, recorded } = render({
      settings: settingsWith({
        agents: [agentProfile({ id: 'a' }), agentProfile({ id: 'b', name: 'Half finished', base_url: '' })],
      }),
    });
    click(buttonsIn(root, 'Save settings')[0]!);
    expect(recorded.saved).toBeNull();
    expect(text(root)).toMatch(/Remove the unfinished agent/);
  });

  it('saves a complete profile along with its key', () => {
    const { root, recorded } = render();
    setValue(inputsIn(root, 'password')[0]!, 'sk-to-store');
    click(buttonsIn(root, 'Save settings')[0]!);

    expect(recorded.saved).not.toBeNull();
    expect(recorded.saved?.settings.agents[0]?.base_url).toBe('http://127.0.0.1:8080/v1');
    expect(recorded.saved?.secrets.agentApiKeys?.agent_a).toBe('sk-to-store');
  });

  it('drops the key from what is saved when persistence is switched off', () => {
    const { root, recorded } = render({
      agentApiKeys: { agent_a: 'sk-was-stored' },
      settings: settingsWith({ agents: [agentProfile({ persist_api_key: true })] }),
    });
    const persist = inputsIn(root, 'checkbox').find((node) =>
      (node.parentElement?.textContent ?? '').includes('Remember this key'),
    )!;
    expect(persist.checked).toBe(true);

    persist.checked = false;
    persist.dispatchEvent(new Event('input', { bubbles: true }));
    click(buttonsIn(root, 'Save settings')[0]!);

    expect(recorded.saved?.secrets.agentApiKeys?.agent_a).toBeUndefined();
  });

  it('states the trade-off of persisting a key every time it is offered', () => {
    const { root } = render();
    expect(text(root)).toMatch(/readable by every script on this origin/);
  });
});

describe('Tavily settings', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('is off by default and says what it needs', () => {
    const { root } = render();
    expect(text(root)).toContain('Also search the web with Tavily');
    expect(text(root)).toMatch(/Off\. Switching it on needs a Tavily API key/);
  });

  it('says plainly that it will do nothing without a key', () => {
    const { root } = render({
      settings: settingsWith({ research: { wikipedia: true, puter_web_search: false, tavily: true } }),
    });
    expect(text(root)).toMatch(/no key is set/);
    expect(text(root)).toMatch(/the source simply is not registered/);
  });

  it('offers a key field and a persistence opt-in with the same warning', () => {
    const { root } = render({
      settings: settingsWith({ research: { wikipedia: true, puter_web_search: false, tavily: true } }),
    });
    expect(text(root)).toContain('Tavily API key');
    expect(text(root)).toMatch(/Remember the Tavily key in the browser/);
    expect(text(root)).toMatch(/bills your account per search/);
  });

  it('never asks Tavily for a synthesised answer, and says why', () => {
    const { root } = render();
    expect(text(root)).toMatch(/never asks Tavily for a synthesised answer/);
    expect(text(root)).toMatch(/model suggestion, not evidence/);
  });

  it('passes the Tavily key through on save only when persistence is opted into', () => {
    const { root, recorded } = render({
      settings: settingsWith({ research: { wikipedia: true, puter_web_search: false, tavily: true } }),
    });
    const keyField = inputsIn(root, 'password').find((node) =>
      (node.parentElement?.textContent ?? '').includes('Tavily API key'),
    )!;
    setValue(keyField, 'tvly-typed');
    click(buttonsIn(root, 'Save settings')[0]!);

    // Not persisted, so the secret is not handed to storage — it stays in memory.
    expect(recorded.saved?.secrets.tavilyApiKey).toBeNull();
    expect(recorded.saved?.settings.research.tavily).toBe(true);
  });

  it('hands the key over when the user opted into storing it', () => {
    const { root, recorded } = render({
      settings: settingsWith({
        research: { wikipedia: true, puter_web_search: false, tavily: true },
        persist_tavily_api_key: true,
      }),
    });
    const keyField = inputsIn(root, 'password').find((node) =>
      (node.parentElement?.textContent ?? '').includes('Tavily API key'),
    )!;
    setValue(keyField, 'tvly-typed');
    click(buttonsIn(root, 'Save settings')[0]!);

    expect(recorded.saved?.secrets.tavilyApiKey).toBe('tvly-typed');
  });
});

describe('the research toggles as a group', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('renders all three with their own persistence, not each other', () => {
    const { root, recorded } = render({
      settings: settingsWith({
        research: { wikipedia: false, puter_web_search: true, tavily: true },
      }),
      tavilyApiKey: 'tvly-stored',
    });

    const boxes = inputsIn(root, 'checkbox').filter((node) => {
      const label = node.closest('label')?.textContent ?? '';
      // The Tavily key has its own persistence checkbox, whose label also names Tavily,
      // so the three source toggles have to be matched on their own wording.
      return /^(Look things up|Also use Puter web search|Also search the web)/.test(label);
    });
    expect(boxes).toHaveLength(3);
    const [wikipedia, puter, tavily] = boxes as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    expect(wikipedia.checked).toBe(false);
    expect(puter.checked).toBe(true);
    expect(tavily.checked).toBe(true);

    // Toggling one must not disturb the others — the failure mode that indexing
    // checkboxes by position produces.
    wikipedia.checked = true;
    wikipedia.dispatchEvent(new Event('change', { bubbles: true }));
    click(buttonsIn(root, 'Save settings')[0]!);

    expect(recorded.saved?.settings.research).toEqual({
      wikipedia: true,
      puter_web_search: true,
      tavily: true,
    });
  });

  it('restates that any source may return nothing', () => {
    const { root } = render();
    expect(text(root)).toMatch(/Any source can return nothing, and that is reported rather than filled in/);
  });
});

describe('agent ids', () => {
  it('are distinct enough that two agents added in one session cannot collide', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAgentId()));
    expect(ids.size).toBe(200);
  });
});
