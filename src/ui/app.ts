/**
 * The Ideno application shell.
 *
 * Wiring, and only wiring. Every decision about the idea lives in the State
 * Manager, the Orchestrator and the reasoning modules; this file owns the DOM,
 * the settings, and the small amount of UI state (which tab is open, what is
 * typed in the composer, whether a turn is running).
 *
 * Rendering strategy: the shell is built once, then individual containers are
 * updated. The conversation grows incrementally so scroll position and focus
 * survive; the panels re-render wholesale because they are derived views of the
 * state and are cheap to rebuild.
 */
import {
  IDEA_PHASE_LABELS,
  WORKSPACE_SCHEMA_VERSION,
  type IdeaCase,
  type Operation,
  type TranscriptEntry,
} from '../core/schemas/index.js';
import { SettingsSchema, type Settings } from '../ai/settings.js';
import { loadSettings, saveSettings, type SettingsSecrets } from '../ai/settings_store.js';
import { activeAgent } from '../ai/settings.js';
import { discoverModels, probeAgent } from '../ai/discovery.js';
import { StateManager, type StateEvent } from '../core/state_manager/state_manager.js';
import { createDefaultStore, type Store } from '../core/state_manager/store.js';
import {
  createDesktopTavilyTransport,
  initDesktopStore,
  type DesktopHost,
  type DesktopStore,
} from './desktop_bridge.js';
import { Orchestrator, type OrchestratorEvent } from '../core/orchestrator/orchestrator.js';
import { applySettings, createAIRuntime, syncResearchSources, type ProviderBundle } from '../ai/factory.js';
import type { ModelInfo, ProviderAvailability } from '../ai/provider_interface/provider.js';
import { ResearchRegistry } from '../research/evidence.js';
import { PluginRegistry, type RendererHandle } from '../plugins/registry.js';
import { createThreePlugin } from '../plugins/renderers/three.js';
import { projectCanonicalScene } from '../render/canonical.js';
import { DEMO_MESSAGES, greenhouseResponder } from '../demo/greenhouse.js';
import { button, clear, el, render, type Child } from './dom.js';
import { renderComposer, renderMessage, renderStartScreen, renderThinking } from './components/conversation.js';
import { renderReviewQueue } from './components/review.js';
import {
  renderStatePanel,
  type EvidenceInput,
  type StatePanelActions,
} from './components/state_panel.js';
import { renderVersions, type VersionViewState } from './components/versions.js';
import { renderWorkspaceModal } from './components/workspace.js';
import { renderSpec, type SpecViewer } from './components/spec.js';
import { PROVIDER_LABELS, renderSettingsModal, type AgentCheckState } from './components/settings.js';

/**
 * How long a burst of mutations is collected into one write.
 *
 * Long enough to cover the several state changes a single turn produces, short
 * enough that the window a crash could lose is not worth mentioning. See
 * `StateManager` for the measurement behind this.
 */
export const PERSIST_COALESCE_MS = 400;

type Tab = 'state' | 'review' | 'history' | 'spec';

const TABS: { id: Tab; label: string }[] = [
  { id: 'state', label: 'Idea State' },
  { id: 'review', label: 'Review' },
  { id: 'history', label: 'History' },
  { id: 'spec', label: 'Spec' },
];

const DEMO_DELAY_MS = 350;

export class IdenoApp {
  #mount: HTMLElement;
  #store: Store;
  #storageWarning: string | null = null;
  /** Set when running inside the Python desktop host, null in a plain browser. */
  #desktopHost: DesktopHost | null = null;
  #desktopStore: DesktopStore | null = null;
  #settings: Settings;
  #apiKey: string | null;
  /** Keys for each custom agent profile, by id. In memory unless persistence was opted into. */
  #agentApiKeys: Record<string, string> = {};
  #tavilyApiKey: string | null = null;
  /** Result of the last agent discovery or probe, shown in Settings. */
  #agentCheck: AgentCheckState | null = null;
  /**
   * Unsaved Settings edits, kept across a re-render.
   *
   * Discovery and probing re-render the modal, and the modal rebuilds its draft from
   * what it is given. Without this, testing a base URL you had just typed would discard
   * it — the field would come back empty and the result would refer to nothing.
   */
  #settingsDraft: {
    settings: Settings;
    agentApiKeys: Record<string, string>;
    tavilyApiKey: string | null;
  } | null = null;
  #state: StateManager;
  #research = new ResearchRegistry();
  #plugins: PluginRegistry;
  #bundle: ProviderBundle;
  #orchestrator: Orchestrator;

  // UI state
  #tab: Tab = 'state';
  #versionView: VersionViewState = { selectedVersionId: null, compareBranchId: null };
  #workspaceOpen = false;
  #draft = '';
  #busy = false;
  #thinking: string | null = null;
  /**
   * What the model is forming, from a partial response.
   *
   * Kept separate from `#thinking` because they are different statements: one says
   * what Ideno is doing ("Reading the current idea state…"), the other reports what
   * the model has produced so far and is explicitly a proposal.
   */
  #preview: string | null = null;
  #availability: ProviderAvailability | null = null;
  #models: ModelInfo[] = [];
  #notice: string | null = null;
  #settingsOpen = false;
  /** True while the scripted demo is replaying, before its session exists. */
  #demoRunning = false;

  // The 3D view. The mount is created once and *moved* into the panel on each render,
  // because panels are re-rendered wholesale and a WebGL context cannot survive being
  // rebuilt every time: browsers cap live contexts, and the failure presents as a
  // blank canvas with no error to explain it.
  #viewerEnabled = false;
  #viewerMount: HTMLElement | null = null;
  #viewerHandle: RendererHandle | null = null;
  #viewerKey: string | null = null;

  // DOM containers, created once by #buildShell.
  #topbar!: HTMLElement;
  #noticeEl!: HTMLElement;
  #left!: HTMLElement;
  #conversation!: HTMLElement;
  #composerHost!: HTMLElement;
  #right!: HTMLElement;
  #modalHost!: HTMLElement;
  #composer: { textarea: HTMLTextAreaElement | null; send: HTMLButtonElement | null } = {
    textarea: null,
    send: null,
  };
  #startButton: HTMLButtonElement | null = null;
  #flushOnHide: () => void;

  constructor(mount: HTMLElement) {
    this.#mount = mount;
    this.#flushOnHide = () => {
      this.#state.flush();
    };

    const selection = createDefaultStore();
    this.#store = selection.store;
    this.#storageWarning = selection.persistent ? null : (selection.reason ?? null);

    const loaded = loadSettings(this.#store);
    this.#settings = loaded.settings;
    this.#apiKey = loaded.apiKey;
    this.#agentApiKeys = loaded.agentApiKeys;
    this.#tavilyApiKey = loaded.tavilyApiKey;
    if (loaded.warning) this.#notice = loaded.warning;

    this.#state = new StateManager({
      store: this.#store,
      persist: true,
      // A save serialises the whole idea record, version snapshots included, so
      // saving once per mutation makes a long session measurably slow (5.5 s of
      // repeated serialisation across 400 changes, against ~0.6 s coalesced).
      // `flush()` below closes the window on the way out.
      coalesceMs: PERSIST_COALESCE_MS,
    });
    this.#plugins = new PluginRegistry({ state: this.#state, research: this.#research });
    this.#syncResearchSources();
    // Registering the 3D renderer costs nothing: Three.js is imported only when the
    // view is actually opened, so it stays out of the main bundle and is never
    // downloaded by someone who does not use it.
    this.#plugins.register(createThreePlugin());
    this.#bundle = createAIRuntime(this.#settings, {
      scripted: { responses: greenhouseResponder(this.#state) },
      agentApiKey: this.#activeAgentKey(),
    });
    this.#orchestrator = new Orchestrator({
      runtime: this.#bundle.runtime,
      state: this.#state,
      getSettings: () => this.#settings,
      research: this.#research,
      onEvent: (event) => this.#onOrchestratorEvent(event),
    });

    this.#state.subscribe((event) => this.#onStateEvent(event));
  }

  /**
   * Detaches the shell. Flushes anything the coalesced writer is still holding and
   * removes the page-hide listener, so an embedding page (or a test) can tear an
   * app down without leaking a listener or losing the last few mutations.
   *
   * Returns a promise that resolves once the desktop host has answered every
   * mirrored write. In a browser it resolves immediately.
   */
  async dispose(): Promise<void> {
    this.#disposeViewer();
    this.#state.flush();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.#flushOnHide);
    if (this.#desktopStore) await this.#desktopStore.whenSettled();
  }

  /** The desktop host Ideno is running inside, when there is one. */
  get desktopHost(): DesktopHost | null {
    return this.#desktopHost;
  }

  /**
   * Upgrades persistence to the desktop host's files when one is present.
   *
   * Runs before anything is read, so there is exactly one storage location per run
   * and no question about which copy is authoritative. A browser session takes the
   * same path and simply finds no host: this is not a second build of the app.
   */
  async #adoptDesktopStorage(): Promise<void> {
    let desktop: DesktopStore | null = null;
    try {
      desktop = await initDesktopStore({
        onFailure: (message) => {
          this.#storageWarning = message;
          this.#renderNotice();
        },
      });
    } catch {
      // No host, or one that could not be spoken to. Browser storage is a complete
      // fallback, so this is not an error worth interrupting the boot for.
      return;
    }
    if (!desktop) return;

    this.#desktopStore = desktop;
    this.#desktopHost = desktop.host;
    this.#storageWarning = null;
    this.#store = desktop;
    this.#state.setStore(desktop);

    // Settings move with the store: on the desktop they belong in the same place as
    // the ideas, not in a browser profile the user cannot find.
    const loaded = loadSettings(desktop);
    this.#settings = loaded.settings;
    this.#apiKey = loaded.apiKey;
    this.#agentApiKeys = loaded.agentApiKeys;
    this.#tavilyApiKey = loaded.tavilyApiKey;
    if (loaded.warning) this.#notice = loaded.warning;
    applySettings(this.#bundle, this.#settings, this.#activeAgentKey());
    // The constructor registered sources from the *default* settings, because on the
    // desktop the real ones are not readable until now. Without this a user who
    // switched Wikipedia off would have it consulted anyway until they next opened
    // Settings — a preference that appears saved and is not.
    this.#syncResearchSources();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    this.#buildShell();

    // `pagehide` rather than `beforeunload`: it fires on navigation and on a tab
    // being backgrounded for discard, and it is the event the platform actually
    // guarantees on mobile and in embedded web engines.
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.#flushOnHide);

    await this.#adoptDesktopStorage();

    const outcome = this.#state.loadPersisted();
    switch (outcome.status) {
      case 'loaded':
        break;
      case 'empty':
        break;
      case 'corrupt':
        this.#notice = `Your saved workspace could not be read (${outcome.reason}). Starting a fresh session; the stored data was left untouched.`;
        break;
      case 'unsupported_version':
        this.#notice = `That workspace was written in format v${outcome.found}; this build reads v${WORKSPACE_SCHEMA_VERSION}. Starting a fresh session; the stored data was left untouched.`;
        break;
      case 'storage_error':
        this.#notice = `Browser storage could not be read (${outcome.reason}). Starting a fresh session in memory.`;
        break;
    }
    if (this.#storageWarning) {
      this.#notice = this.#notice ? `${this.#notice} ${this.#storageWarning}` : this.#storageWarning;
    }

    await this.#plugins.activateAll();
    this.#render();
    await this.#refreshProvider();
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  #buildShell(): void {
    this.#topbar = el('header', { class: 'topbar' });
    this.#noticeEl = el('div', { class: 'banner', role: 'status' });
    this.#conversation = el('div', {
      class: 'conversation',
      role: 'log',
      ariaLabel: 'Conversation with Ideno',
    });
    this.#composerHost = el('div');
    this.#left = el('main', { class: 'pane pane-left' });
    this.#right = el('aside', { class: 'pane pane-right', ariaLabel: 'Idea State' });
    this.#modalHost = el('div');

    render(
      this.#mount,
      this.#topbar,
      this.#noticeEl,
      el('div', { class: 'layout' }, this.#left, this.#right),
      this.#modalHost,
    );
    this.#renderNotice();
  }

  #render(): void {
    this.#renderNotice();
    this.#renderTopbar();
    this.#renderLeft();
    this.#renderRight();
    this.#renderModal();
  }

  #renderNotice(): void {
    if (!this.#notice) {
      this.#noticeEl.hidden = true;
      this.#noticeEl.textContent = '';
      return;
    }
    this.#noticeEl.hidden = false;
    render(
      this.#noticeEl,
      el('span', { text: this.#notice }),
      el(
        'span',
        { class: 'banner-actions' },
        button('Dismiss', {
          class: 'btn-sm btn-ghost',
          onClick: () => {
            this.#notice = null;
            this.#renderNotice();
          },
        }),
      ),
    );
  }

  #renderTopbar(): void {
    const idea = this.#state.idea;
    const pending = this.#state.pendingChanges().length;
    const ready = this.#availability?.available === true;
    const providerShort = PROVIDER_LABELS[this.#settings.provider_id].split(' (')[0] ?? 'Provider';

    render(
      this.#topbar,
      el(
        'div',
        { class: 'brand' },
        el('span', { class: 'brand-mark' }),
        el('span', null, 'Ideno'),
        el('span', { class: 'brand-sub', text: 'idea development' }),
      ),
      el(
        'div',
        { class: 'topbar-title' },
        el('h1', { text: idea?.title ?? 'No idea yet' }),
        idea
          ? el(
              'div',
              { class: 'message-meta' },
              el('span', { class: 'chip chip-phase', text: IDEA_PHASE_LABELS[idea.current_state] }),
              el('span', {
                class: 'chip',
                text: this.#branchSummary(),
                title: 'Versions are a tree: a branch is a timeline, and forking one copies nothing.',
              }),
              el('span', { text: `${idea.requirements.length} requirements` }),
              el('span', { text: `${idea.constraints.length} constraints` }),
              el('span', { text: `${idea.alternatives.length} alternatives` }),
            )
          : null,
      ),
      el(
        'div',
        { class: 'topbar-actions' },
        el(
          'span',
          {
            class: ready ? 'pill pill-ok' : 'pill pill-warn',
            title: this.#availability?.reason ?? 'Not checked yet',
          },
          el('span', { class: 'pill-dot' }),
          el('span', { text: providerShort }),
        ),
        pending > 0
          ? button(`Review ${pending}`, {
              class: 'btn-sm',
              title: 'Proposed changes awaiting your decision',
              onClick: () => {
                this.#tab = 'review';
                this.#renderRight();
              },
            })
          : null,
        idea
          ? button('Export', {
              class: 'btn-ghost btn-sm',
              title: 'Download the workspace as JSON',
              onClick: () => this.#exportWorkspace(),
            })
          : null,
        idea
          ? button('Import', {
              class: 'btn-ghost btn-sm',
              title: 'Load a workspace JSON file',
              onClick: () => this.#importWorkspace(),
            })
          : null,
        button('Workspace', {
          class: 'btn-ghost btn-sm',
          title: this.#workspaceButtonTitle(),
          onClick: () => this.#openWorkspace(),
        }),
        idea
          ? button('New idea', {
              class: 'btn-ghost btn-sm',
              title: 'Start another idea. This one stays in your workspace.',
              onClick: () => this.#newIdea(),
            })
          : null,
        button('Settings', { class: 'btn-ghost btn-sm', onClick: () => this.#openSettings() }),
      ),
    );
  }

  #renderLeft(): void {
    // During the demo the session does not exist until the first turn runs, but
    // the conversation must stay attached so the replay is visible as it happens.
    if (!this.#state.hasSession && !this.#demoRunning) {
      render(
        this.#left,
        renderStartScreen({
          draft: this.#draft,
          // Updating the button in place keeps the caret where the user left it;
          // re-rendering the whole start screen on every keystroke would not.
          onDraftChange: (text) => {
            this.#draft = text;
            this.#syncStartState();
          },
          onStart: () => void this.#send(),
          onDemo: () => void this.#startDemo(),
          providerNotice: this.#availability?.available === false ? (this.#availability.reason ?? null) : null,
          providerLabel: PROVIDER_LABELS[this.#settings.provider_id],
          providerReady: this.#availability?.available === true,
          onOpenSettings: () => this.#openSettings(),
          storageWarning: this.#storageWarning,
        }),
      );
      this.#composer = { textarea: null, send: null };
      this.#startButton =
        [...this.#left.querySelectorAll('button')].find((node) => node.textContent === 'Start developing') ?? null;
      this.#syncStartState();
      return;
    }

    if (!this.#left.contains(this.#conversation)) {
      render(this.#left, this.#conversation, this.#composerHost);
    }
    this.#syncConversation();
    this.#renderComposer();
  }

  /**
   * Appends only what is not on screen yet.
   *
   * The DOM is the counter: deriving "how many have I rendered" from the element
   * itself removes a whole class of desync bugs (a detached conversation, a
   * replaced session, a re-attached pane) that a separate index variable invites.
   */
  #syncConversation(): void {
    const transcript = this.#state.transcript();
    const rendered = this.#conversation.querySelectorAll('.message').length;

    if (rendered > transcript.length) {
      // The session was replaced or a workspace imported: start over.
      clear(this.#conversation);
    }
    for (const entry of transcript.slice(Math.min(rendered, transcript.length))) {
      this.#conversation.appendChild(renderMessage(entry));
    }

    const thinking = this.#conversation.querySelector('.thinking');
    if (this.#thinking) {
      const children = this.#thinkingChildren();
      if (thinking) {
        thinking.replaceChildren(...children);
      } else {
        this.#conversation.appendChild(renderThinking(this.#thinking, this.#preview));
      }
    } else {
      thinking?.remove();
    }

    this.#conversation.scrollTop = this.#conversation.scrollHeight;
  }

  /**
   * The thinking indicator's contents, rebuilt whenever the preview changes.
   *
   * The preview is marked as a proposal in the wording and in its own element, so a
   * response that is still arriving is never mistaken for a change that has been
   * made. Everything here is text; nothing is parsed as markup.
   */
  #thinkingChildren(): HTMLElement[] {
    const children = [el('span', { class: 'spinner' }), el('span', { text: this.#thinking ?? '' })];
    if (this.#preview) {
      children.push(
        el('span', {
          class: 'thinking-preview',
          text: this.#preview,
          title: 'Still arriving, and not yet validated. Nothing has been changed.',
        }),
      );
    }
    return children;
  }

  #renderComposer(): void {
    render(
      this.#composerHost,
      renderComposer({
        draft: this.#draft,
        busy: this.#busy,
        hasSession: this.#state.hasSession,
        onDraftChange: (text) => {
          this.#draft = text;
          this.#syncComposerState();
        },
        onSend: () => void this.#send(),
        onOperation: (operation) => void this.#runOperation(operation),
      }),
    );
    this.#composer = {
      textarea: this.#composerHost.querySelector('textarea'),
      send: this.#composerHost.querySelector('button[type="submit"]'),
    };
    if (!this.#busy) this.#composer.textarea?.focus();
  }

  #syncStartState(): void {
    if (this.#startButton) this.#startButton.disabled = this.#draft.trim().length === 0;
  }

  /** Updates the composer in place, so typing never loses focus or caret. */
  #syncComposerState(): void {
    const { textarea, send } = this.#composer;
    if (send) {
      send.disabled = this.#busy || this.#draft.trim().length === 0;
      send.textContent = this.#busy ? 'Working…' : 'Send';
    }
    if (textarea) textarea.disabled = this.#busy;
  }

  #renderRight(): void {
    const pending = this.#state.pendingChanges().length;

    const tabs = el(
      'div',
      { class: 'tabs', role: 'tablist' },
      TABS.map((tab) =>
        el(
          'button',
          {
            class: 'tab',
            role: 'tab',
            ariaSelected: this.#tab === tab.id,
            onClick: () => {
              this.#tab = tab.id;
              this.#renderRight();
            },
          },
          el('span', { text: tab.label }),
          tab.id === 'review' && pending > 0 ? el('span', { class: 'badge', text: String(pending) }) : null,
        ),
      ),
    );

    const panel = el('div', { class: 'panel', role: 'tabpanel' });
    render(panel, this.#panelContent());
    render(this.#right, tabs, panel);
    if (this.#tab === 'spec' && this.#viewerEnabled) this.#syncViewer(this.#state.idea);
  }

  #panelContent(): Child {
    const idea = this.#state.idea;
    const actions = this.#panelActions();

    switch (this.#tab) {
      case 'state':
        return renderStatePanel(idea, this.#state.pendingChanges(), actions);
      case 'review': {
        const resolved = this.#state
          .changeLog()
          .filter((record) => record.status !== 'pending')
          .slice(-12)
          .reverse();
        return renderReviewQueue(this.#state.pendingChanges(), resolved, idea, {
          ...actions,
          onAcceptAll: () => this.#acceptAll(),
          onRejectAll: () => this.#rejectAll(),
        });
      }
      case 'history':
        return renderVersions(idea, this.#versionView, {
          onSelect: (versionId) => {
            this.#versionView.selectedVersionId = versionId;
            this.#renderRight();
          },
          onRestore: (versionId) => this.#restoreVersion(versionId),
          onCreateBranch: (name, fromVersionId) => this.#createBranch(name, fromVersionId),
          onSwitchBranch: (branchId) => this.#switchBranch(branchId),
          onCompare: (branchId) => {
            this.#versionView.compareBranchId = branchId;
            this.#renderRight();
          },
          onArchiveBranch: (branchId, archived) => this.#archiveBranch(branchId, archived),
          onLabelVersion: (versionId, label) => this.#labelVersion(versionId, label),
        });
      case 'spec':
        return renderSpec(idea, this.#plugins.list(), this.#viewerSpec(idea));
      default:
        return null;
    }
  }

  /**
   * Makes the registered research sources match the settings.
   *
   * Delegates to the AI layer, which is the one module allowed to know which concrete
   * sources exist. This file names no provider, and the architecture test that says so
   * is what keeps it that way.
   */
  #syncResearchSources(): void {
    // The desktop host gets first refusal on Tavily: it has no cross-origin restriction,
    // so a browser that would block the call still gets results. `createDesktopTavilyTransport`
    // returns null when the host does not offer it, and the source falls back to a direct
    // request that reports a blocked call as such.
    const transport = this.#desktopHost ? createDesktopTavilyTransport(this.#desktopHost) : null;
    syncResearchSources(this.#research, this.#settings, {
      tavilyApiKey: this.#tavilyApiKey,
      ...(transport ? { tavilyTransport: transport } : {}),
    });
  }

  /** The key belonging to whichever agent profile is currently selected. */
  #activeAgentKey(): string | null {
    const agent = activeAgent(this.#settings);
    return agent ? this.#agentApiKeys[agent.id] ?? null : this.#apiKey;
  }

  /** Turns the modal's secrets into the resolved form the app holds. */
  #resolveSecrets(secrets: SettingsSecrets): {
    agentApiKeys: Record<string, string>;
    tavilyApiKey: string | null;
  } {
    const agentApiKeys: Record<string, string> = {};
    for (const [id, value] of Object.entries(secrets.agentApiKeys ?? {})) {
      if (typeof value === 'string' && value.length > 0) agentApiKeys[id] = value;
    }
    return { agentApiKeys, tavilyApiKey: secrets.tavilyApiKey ?? null };
  }

  /** What the Spec panel needs to offer and host the 3D view. */
  #viewerSpec(idea: IdeaCase | null): SpecViewer {
    if (!this.#viewerMount) {
      this.#viewerMount = el('div', { class: 'viewer-mount', ariaLabel: 'Three-dimensional view' });
    }
    return {
      enabled: this.#viewerEnabled,
      mount: this.#viewerMount,
      available: this.#plugins.renderers().length > 0,
      onToggle: () => {
        this.#viewerEnabled = !this.#viewerEnabled;
        if (!this.#viewerEnabled) this.#disposeViewer();
        this.#renderRight();
        if (this.#viewerEnabled) this.#syncViewer(idea);
      },
    };
  }

  /**
   * Draws the current canonical scene, or updates the existing drawing.
   *
   * Called after a render, not during it: creating a renderer inside the component
   * tree would tie a GPU resource's lifetime to DOM construction, which is how
   * contexts leak.
   */
  #syncViewer(idea: IdeaCase | null): void {
    if (!this.#viewerEnabled || !idea || !this.#viewerMount) return;
    const renderer = this.#plugins.renderers()[0];
    if (!renderer) return;

    const projection = projectCanonicalScene(idea);
    const key = viewerKeyFor(idea, projection.scene.objects.length, projection.scene.connections.length);
    if (this.#viewerHandle && this.#viewerKey === key) return;

    if (this.#viewerHandle) {
      this.#viewerHandle.update(projection.scene);
      this.#viewerKey = key;
      return;
    }
    try {
      this.#viewerHandle = renderer.render(projection.scene, this.#viewerMount);
      this.#viewerKey = key;
    } catch (error) {
      this.#viewerEnabled = false;
      this.#notice = `The 3D view could not be opened (${error instanceof Error ? error.message : 'unknown error'}).`;
      this.#renderNotice();
    }
  }

  /** Releases the WebGL context. Called on toggle-off, on teardown and on idea switch. */
  #disposeViewer(): void {
    this.#viewerHandle?.dispose();
    this.#viewerHandle = null;
    this.#viewerKey = null;
  }

  #panelActions(): StatePanelActions {
    return {
      onAcceptChange: (changeId) => this.#accept(changeId),
      onRejectChange: (changeId) => this.#reject(changeId),
      onSelectAlternative: (alternativeId) => this.#selectAlternative(alternativeId),
      onResolveUnknown: (unknownId, resolution) => this.#resolveUnknown(unknownId, resolution),
      onAddEvidence: (input) => this.#addEvidence(input),
    };
  }

  /** Records evidence the user supplied. Applied immediately: they are its author. */
  #addEvidence(input: EvidenceInput): void {
    this.#withStateAction(() => {
      this.#state.addUserEvidence(input);
      this.#notice = 'Evidence recorded. Anything citing it can now be marked as supported by evidence.';
    });
  }

  #renderModal(): void {
    if (this.#workspaceOpen) {
      render(
        this.#modalHost,
        renderWorkspaceModal({
          entries: this.#state.listIdeas(),
          activeSessionId: this.#state.activeSessionId,
          storageDescription: this.#storageDescription(),
          onOpen: (sessionId) => this.#openIdea(sessionId),
          onArchive: (sessionId, archived) => this.#archiveIdea(sessionId, archived),
          onNewIdea: () => this.#newIdea(),
          onClose: () => {
            this.#workspaceOpen = false;
            this.#renderModal();
          },
        }),
      );
      return;
    }
    if (!this.#settingsOpen) {
      render(this.#modalHost);
      return;
    }
    render(
      this.#modalHost,
      renderSettingsModal({
        settings: this.#settingsDraft?.settings ?? this.#settings,
        apiKey: this.#apiKey,
        agentApiKeys: this.#settingsDraft?.agentApiKeys ?? this.#agentApiKeys,
        tavilyApiKey: this.#settingsDraft?.tavilyApiKey ?? this.#tavilyApiKey,
        availability: this.#availability,
        providerLabel: PROVIDER_LABELS[this.#settings.provider_id],
        models: this.#models,
        agentCheck: this.#agentCheck,
        notice: this.#storageWarning,
        onClose: () => {
          this.#settingsOpen = false;
          // Discarded on close: an abandoned edit is not a saved one, and keeping it
          // would silently resurrect a half-finished agent the next time Settings opened.
          this.#settingsDraft = null;
          this.#agentCheck = null;
          this.#renderModal();
        },
        onSignIn: () => void this.#signIn(),
        onRefreshModels: () => void this.#refreshModels(),
        onDiscoverAgent: (draft, secrets, agentId) => void this.#discoverAgent(draft, secrets, agentId),
        onProbeAgent: (draft, secrets, agentId) => void this.#probeAgent(draft, secrets, agentId),
        onSave: (settings, secrets) => this.#saveSettings(settings, secrets),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async #send(): Promise<void> {
    const text = this.#draft.trim();
    if (!text || this.#busy) return;

    this.#draft = '';
    this.#busy = true;
    this.#thinking = 'Reading your message…';
    this.#renderLeft();

    try {
      await this.#orchestrator.processMessage(text);
    } catch (error) {
      this.#reportLocalFailure(error);
    } finally {
      this.#busy = false;
      this.#thinking = null;
      this.#render();
    }
  }

  async #runOperation(operation: Operation): Promise<void> {
    if (this.#busy || !this.#state.hasSession) return;
    this.#busy = true;
    this.#thinking = `${labelForOperation(operation)}…`;
    this.#syncComposerState();
    this.#syncConversation();
    try {
      await this.#orchestrator.runOperation(operation);
    } catch (error) {
      this.#reportLocalFailure(error);
    } finally {
      this.#busy = false;
      this.#thinking = null;
      this.#render();
    }
  }

  /**
   * Replays the scripted greenhouse scenario.
   *
   * Labelled as a demo everywhere: the provider is `scripted`, the notice says no
   * model was called, and proposed changes are accepted automatically with a
   * transcript notice explaining that this is not normal behaviour. They have to
   * be, because a later scripted turn refers to items an earlier turn proposed —
   * exactly the dependency a real user resolves by reviewing the queue.
   */
  async #startDemo(): Promise<void> {
    if (this.#busy) return;
    const scripted = this.#bundle.providers.scripted;
    if (!scripted) return;

    this.#settings = SettingsSchema.parse({ ...this.#settings, provider_id: 'scripted' });
    applySettings(this.#bundle, this.#settings, this.#apiKey);
    this.#availability = { available: true };
    scripted.reset?.();
    this.#state.resetSession();
    clear(this.#conversation);
    // No session exists yet, so the introduction is a UI notice rather than a
    // transcript entry: the transcript belongs to the idea.
    this.#notice =
      'Offline demo running. No model is being called — these five turns are scripted and replay the acceptance scenario, from a rough idea to a recorded decision.';
    this.#renderNotice();

    this.#busy = true;
    this.#demoRunning = true;
    this.#renderLeft();
    try {
      for (const message of DEMO_MESSAGES) {
        this.#thinking = `Demo · sending “${message}”`;
        this.#syncConversation();
        await this.#orchestrator.processMessage(message);

        const pending = this.#state.pendingChanges();
        if (pending.length > 0) {
          this.#state.acceptChanges(pending.map((record) => record.id));
          this.#state.appendTranscript({
            role: 'system',
            text: `Demo mode: ${pending.length} proposed change(s) accepted automatically so the scripted scenario can continue. In normal use each one waits for your Accept or Reject.`,
          });
        }
        await sleep(DEMO_DELAY_MS);
      }
      this.#state.appendTranscript({
        role: 'system',
        text: 'Demo complete. The Idea State on the right is the real thing — inspect it, review the history, or switch provider in Settings and keep developing this idea with a model.',
      });
      this.#tab = 'state';
    } catch (error) {
      this.#reportLocalFailure(error);
    } finally {
      this.#busy = false;
      this.#demoRunning = false;
      this.#thinking = null;
      this.#render();
    }
  }

  #accept(changeId: string): void {
    this.#withStateAction(() => this.#state.acceptChange(changeId));
  }

  #reject(changeId: string): void {
    this.#withStateAction(() => this.#state.rejectChange(changeId));
  }

  #acceptAll(): void {
    const pending = this.#state.pendingChanges();
    if (pending.length === 0) return;
    this.#withStateAction(() => this.#state.acceptChanges(pending.map((record) => record.id)));
  }

  #rejectAll(): void {
    this.#withStateAction(() => {
      this.#state.rejectAllPending('Rejected together from the review queue.');
    });
  }

  #selectAlternative(alternativeId: string): void {
    const idea = this.#state.idea;
    const alternative = idea?.alternatives.find((item) => item.id === alternativeId);
    if (!idea || !alternative) return;
    this.#withStateAction(() =>
      this.#state.recordUserDecision({
        decision: `Use “${alternative.name}”.`,
        rationale: 'Selected from the Idea State panel.',
        alternative_id: alternativeId,
        rejected_alternative_ids: idea.alternatives
          .filter((item) => item.id !== alternativeId)
          .map((item) => item.id),
      }),
    );
  }

  #resolveUnknown(unknownId: string, resolution: string): void {
    this.#withStateAction(() => this.#state.resolveUnknown(unknownId, resolution));
  }

  #restoreVersion(versionId: string): void {
    const version = this.#state.idea?.version_history.find((entry) => entry.id === versionId);
    if (!version) return;
    const confirmed = window.confirm(
      `Restore v${version.number} (“${version.summary}”)?\n\nThe idea returns to that snapshot, recorded as a new version. Nothing is erased.`,
    );
    if (!confirmed) return;
    this.#withStateAction(() => {
      const restored = this.#state.restoreVersion(versionId);
      this.#versionView.selectedVersionId = restored.id;
      this.#versionView.compareBranchId = null;
    });
  }

  /** Runs a state mutation, surfacing a failure as a notice instead of a crash. */
  #withStateAction(action: () => unknown): void {
    try {
      action();
      this.#render();
    } catch (error) {
      this.#reportLocalFailure(error);
    }
  }

  /**
   * Starts another idea.
   *
   * v0.1 had to warn that this discarded the current idea, because a workspace held
   * exactly one. It holds many now, so there is nothing to confirm and nothing to
   * lose: the open idea is written to storage first (`setStore` and `startSession`
   * both flush) and stays in the Workspace list.
   */
  #newIdea(): void {
    this.#resetTurnUiState();
    // No session yet: the composer's first message creates it, which is how the
    // start screen works and how `original_idea` stays the user's own words.
    this.#state.closeSession();
    for (const provider of Object.values(this.#bundle.providers)) provider.reset?.();
    this.#render();
    void this.#refreshProvider();
  }

  /** Opens an idea that is already in the workspace. */
  #openIdea(sessionId: string): void {
    const outcome = this.#state.openSession(sessionId);
    if (outcome.status !== 'opened') {
      this.#notice =
        outcome.status === 'corrupt'
          ? `That idea could not be read (${outcome.reason}). The rest of your workspace is unaffected.`
          : outcome.status === 'missing'
            ? 'That idea is no longer stored.'
            : outcome.status === 'unsupported_version'
              ? `That idea was written in format v${outcome.found}, which this build does not read.`
              : `Storage could not be read (${outcome.reason}).`;
      this.#workspaceOpen = false;
      this.#render();
      return;
    }
    this.#workspaceOpen = false;
    this.#resetTurnUiState();
    for (const note of outcome.notes) {
      this.#notice = this.#notice ? `${this.#notice} ${note.message}` : note.message;
    }
    for (const provider of Object.values(this.#bundle.providers)) provider.reset?.();
    this.#render();
    void this.#refreshProvider();
  }

  #archiveIdea(sessionId: string, archived: boolean): void {
    try {
      this.#state.archiveSession(sessionId, { archived });
    } catch (error) {
      this.#reportLocalFailure(error);
      return;
    }
    if (archived && this.#state.activeSessionId === null) this.#resetTurnUiState();
    this.#render();
  }

  /**
   * Clears the per-idea UI state that must not leak from one idea into the next:
   * the transcript pane, the selected version, the branch comparison and the draft.
   */
  #resetTurnUiState(): void {
    // A 3D view of the previous idea must not survive into the next one.
    this.#viewerEnabled = false;
    this.#disposeViewer();
    this.#versionView = { selectedVersionId: null, compareBranchId: null };
    this.#tab = 'state';
    this.#draft = '';
    clear(this.#conversation);
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  #createBranch(name: string, fromVersionId: string): void {
    this.#withStateAction(() => {
      const branch = this.#state.createBranch({ name: name || undefined, from_version_id: fromVersionId });
      this.#versionView = { selectedVersionId: branch.head_version_id, compareBranchId: null };
      this.#notice = `Forked “${branch.name}”. Nothing was copied: both timelines share the history below the fork.`;
    });
  }

  #switchBranch(branchId: string): void {
    this.#withStateAction(() => {
      const head = this.#state.switchBranch(branchId);
      this.#versionView = { selectedVersionId: head.id, compareBranchId: null };
      const branch = this.#state.activeBranch();
      this.#notice = `Now on “${branch?.name ?? 'that branch'}”. The idea shows the state at the tip of that timeline.`;
    });
  }

  #archiveBranch(branchId: string, archived: boolean): void {
    this.#withStateAction(() => {
      const branch = this.#state.archiveBranch(branchId, { archived });
      this.#versionView = { selectedVersionId: null, compareBranchId: null };
      this.#notice = archived
        ? `Archived “${branch.name}”. Its versions are still in the history and it can be unarchived.`
        : `Unarchived “${branch.name}”.`;
    });
  }

  #labelVersion(versionId: string, label: string | null): void {
    this.#withStateAction(() => {
      this.#state.labelVersion(versionId, label);
      this.#versionView.selectedVersionId = versionId;
    });
  }

  #branchSummary(): string {
    const idea = this.#state.idea;
    if (!idea) return 'no versions';
    const branch = this.#state.activeBranch();
    const count = this.#state.branchVersions().length;
    const others = idea.branches.filter((entry) => !entry.archived).length - 1;
    const name = branch?.name ?? 'main';
    return others > 0 ? `${name} · ${count} versions · ${others} other branch${others === 1 ? '' : 'es'}` : `${name} · ${count} versions`;
  }

  #workspaceButtonTitle(): string {
    const entries = this.#state.listIdeas();
    const live = entries.filter((entry) => !entry.archived).length;
    const stored = this.#desktopHost
      ? `Stored as files in ${this.#desktopHost.workspaceDir ?? 'your data directory'}.`
      : 'Stored in this browser.';
    return `${live} idea${live === 1 ? '' : 's'} in this workspace. ${stored}`;
  }

  #openWorkspace(): void {
    this.#workspaceOpen = true;
    this.#renderModal();
  }

  /** What the workspace modal says about where the ideas actually live. */
  #storageDescription(): string | null {
    if (this.#desktopStore) {
      return `Ideas are stored as JSON files in ${this.#desktopStore.workspaceDir ?? 'your data directory'} — ` +
        'one file per idea, written atomically. There is no browser storage limit here.';
    }
    return null;
  }

  #exportWorkspace(): void {
    const json = this.#state.exportJson();
    if (!json) return;
    const name = `ideno-${this.#state.idea?.id ?? 'workspace'}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = el('a', { href: url, text: name });
    link.setAttribute('download', name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke after the download has started, not before.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  #importWorkspace(): void {
    const input = el('input', { type: 'file', class: 'visually-hidden' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;

      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const result = this.#state.importJson(text);
        if (!result.ok) {
          this.#notice = `Import failed: ${result.reason}`;
          this.#renderNotice();
          return;
        }
        this.#resetTurnUiState();
        this.#notice = `Imported “${result.session.idea.title}” with ${result.session.idea.version_history.length} versions.`;
        this.#render();
      });
      reader.addEventListener('error', () => {
        this.#notice = 'That file could not be read.';
        this.#renderNotice();
      });
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  // ---------------------------------------------------------------------------
  // Settings and provider
  // ---------------------------------------------------------------------------

  #openSettings(): void {
    this.#settingsOpen = true;
    // A fresh open starts from saved settings, not from whatever was abandoned last time.
    this.#settingsDraft = null;
    this.#agentCheck = null;
    this.#renderModal();
    void this.#refreshProvider();
  }

  #saveSettings(settings: Settings, secrets: SettingsSecrets): void {
    this.#settings = settings;
    const resolved = this.#resolveSecrets(secrets);
    this.#agentApiKeys = resolved.agentApiKeys;
    this.#tavilyApiKey = resolved.tavilyApiKey;
    this.#apiKey = this.#activeAgentKeyFor(settings, resolved.agentApiKeys);

    const saved = saveSettings(this.#store, settings, secrets);
    if (!saved.saved) {
      this.#notice = saved.reason ?? 'Settings could not be saved.';
    }
    applySettings(this.#bundle, settings, this.#apiKey);
    this.#syncResearchSources();
    this.#models = [];
    this.#settingsOpen = false;
    this.#settingsDraft = null;
    this.#agentCheck = null;
    this.#render();
    void this.#refreshProvider();
  }

  #activeAgentKeyFor(settings: Settings, agentApiKeys: Record<string, string>): string | null {
    const agent = activeAgent(settings);
    return agent ? agentApiKeys[agent.id] ?? null : null;
  }

  /**
   * Asks an endpoint what models it serves.
   *
   * Runs against the draft, not the saved settings, so an agent can be checked before it
   * exists — which is the only order that makes sense when setting one up.
   */
  async #discoverAgent(draft: Settings, secrets: SettingsSecrets, agentId: string): Promise<void> {
    const resolved = this.#resolveSecrets(secrets);
    this.#settingsDraft = { settings: draft, ...resolved };
    const agent = draft.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;

    this.#agentCheck = { agentId, kind: 'discover', busy: true, ok: false, models: [], message: '' };
    this.#renderModal();

    const result = await discoverModels({
      base_url: agent.base_url,
      api_key: resolved.agentApiKeys[agentId] ?? null,
      timeout_ms: this.#settings.timeout_ms,
    });
    // Ignored if the modal closed while the request was in flight: writing a result for
    // a panel nobody is looking at would resurrect it on the next open.
    if (!this.#settingsOpen) return;
    this.#agentCheck = {
      agentId,
      kind: 'discover',
      busy: false,
      ok: result.ok,
      models: result.models,
      message: result.ok ? '' : result.reason ?? 'That endpoint did not return a model list.',
    };
    this.#renderModal();
  }

  /**
   * Sends one real completion to prove the agent answers.
   *
   * Separate from discovery because it spends a request on the user's account, and
   * something that costs money must be an explicit action rather than a side effect of
   * opening a panel.
   */
  async #probeAgent(draft: Settings, secrets: SettingsSecrets, agentId: string): Promise<void> {
    const resolved = this.#resolveSecrets(secrets);
    this.#settingsDraft = { settings: draft, ...resolved };
    const agent = draft.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;

    this.#agentCheck = { agentId, kind: 'probe', busy: true, ok: false, models: [], message: '' };
    this.#renderModal();

    const result = await probeAgent({
      base_url: agent.base_url,
      model: agent.model,
      api_key: resolved.agentApiKeys[agentId] ?? null,
      timeout_ms: this.#settings.timeout_ms,
    });
    if (!this.#settingsOpen) return;
    this.#agentCheck = {
      agentId,
      kind: 'probe',
      busy: false,
      ok: result.ok,
      models: [],
      message: result.ok ? '' : result.reason ?? 'The test message did not get an answer.',
      ...(result.model ? { model: result.model } : {}),
      ...(result.reply ? { reply: result.reply } : {}),
      ...(typeof result.latency_ms === 'number' ? { latencyMs: result.latency_ms } : {}),
    };
    this.#renderModal();
  }

  async #refreshProvider(): Promise<void> {
    try {
      this.#availability = await this.#bundle.runtime.availability();
    } catch (error) {
      this.#availability = {
        available: false,
        action: 'configure',
        reason: error instanceof Error ? error.message : 'The provider could not be checked.',
      };
    }
    if (this.#availability.available && this.#bundle.runtime.capabilities().model_catalog) {
      await this.#refreshModels();
      return;
    }
    this.#models = [];
    this.#render();
  }

  async #refreshModels(): Promise<void> {
    try {
      this.#models = await this.#bundle.runtime.listModels();
    } catch {
      // A provider that cannot enumerate models is still usable; the settings
      // screen falls back to a text field.
      this.#models = [];
    }
    this.#render();
  }

  async #signIn(): Promise<void> {
    this.#availability = await this.#bundle.runtime.signIn();
    if (this.#availability.available) await this.#refreshModels();
    else this.#renderModal();
    this.#renderTopbar();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  #onStateEvent(event: StateEvent): void {
    switch (event.type) {
      case 'transcript_appended':
        this.#onTranscriptEntry(event.entry);
        break;
      case 'integrity':
        this.#notice = event.message;
        this.#renderNotice();
        break;
      case 'persistence':
        if (!event.persistent && event.reason) this.#storageWarning = event.reason;
        break;
      case 'version_committed':
        this.#versionView.selectedVersionId = event.version.id;
        break;
      case 'session_cleared':
        clear(this.#conversation);
        break;
      default:
        break;
    }
  }

  #onTranscriptEntry(_entry: TranscriptEntry): void {
    if (!this.#state.hasSession || !this.#left.contains(this.#conversation)) return;
    this.#syncConversation();
    this.#renderTopbar();
    if (this.#tab === 'state' || this.#tab === 'review') this.#renderRight();
  }

  #onOrchestratorEvent(event: OrchestratorEvent): void {
    switch (event.type) {
      case 'phase':
        this.#thinking =
          event.phase === 'complete' ? null : (event.detail ?? phaseLabel(event.phase ?? '', event.operation));
        this.#syncConversation();
        break;
      case 'preview':
        this.#preview = event.preview ?? null;
        this.#syncConversation();
        break;
      case 'failure':
      case 'turn_complete':
        this.#thinking = null;
        this.#preview = null;
        break;
      case 'warning':
        // Warnings are recorded on the turn result and the change log. Turning
        // each into a banner would bury the user; integrity problems (which do
        // matter) arrive as state events instead.
        break;
      default:
        break;
    }
  }

  #reportLocalFailure(error: unknown): void {
    this.#notice = error instanceof Error ? error.message : 'Something went wrong in the interface.';
    this.#busy = false;
    this.#thinking = null;
    this.#render();
  }
}

/**
 * Identity of what the 3D view is currently drawing.
 *
 * Deliberately coarse: it exists to avoid re-uploading geometry when nothing
 * relevant changed, not to detect every possible change. Anything finer would mean
 * hashing the whole scene on every render, which costs more than the redraw it saves.
 */
function viewerKeyFor(idea: IdeaCase, objects: number, connections: number): string {
  return [
    idea.id,
    idea.selected_alternative_id ?? 'none',
    idea.version_history.length,
    objects,
    connections,
  ].join('|');
}

function phaseLabel(phase: string, operation?: Operation): string {
  switch (phase) {
    case 'preparing':
      return 'Reading the current idea state…';
    case 'awaiting_provider':
      return 'Checking the provider…';
    case 'calling_model':
      return `${labelForOperation(operation ?? 'update')}…`;
    case 'applying':
      return 'Updating the idea state…';
    default:
      return 'Working…';
  }
}

function labelForOperation(operation: Operation): string {
  switch (operation) {
    case 'understand':
      return 'Understanding the idea';
    case 'update':
      return 'Updating the idea state';
    case 'critique':
      return 'Critiquing the idea';
    case 'explore':
      return 'Exploring alternatives';
    case 'research':
      return 'Reviewing what is evidenced';
    case 'decision':
      return 'Recording the decision';
    default:
      return 'Working';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Boots the app into a mount point. */
export function createApp(mount: HTMLElement): IdenoApp {
  return new IdenoApp(mount);
}
