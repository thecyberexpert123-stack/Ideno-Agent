/**
 * Plugin extension points.
 *
 * v0.1 ships no plugins. What it ships is the seam they will attach to, because
 * the alternative — retrofitting an extension model later — is how systems end up
 * with the AI provider, the renderer and the research source tangled together.
 *
 * The contract a plugin sees is narrow on purpose:
 *
 *  - `registerResearchSource` — evidence with real locators (see `research/`).
 *  - `registerRenderer` — consumes a `CanonicalScene`, never natural language.
 *  - `getState` / `getCanonicalScene` / `subscribe` — read the Idea State and
 *    follow its evolution.
 *
 * There is deliberately no way for a plugin to mutate the Idea State directly.
 * Changes enter through the State Manager's validated change records, so a plugin
 * cannot bypass provenance, review or versioning.
 */
import type { IdeaCase } from '../core/schemas/index.js';
import type { StateEvent, StateManager } from '../core/state_manager/state_manager.js';
import type { CanonicalProjection, CanonicalScene } from '../render/canonical.js';
import { projectCanonicalScene } from '../render/canonical.js';
import type { ResearchSource } from '../research/evidence.js';
import type { ResearchRegistry } from '../research/evidence.js';

export const PLUGIN_CAPABILITIES = [
  'research',
  'render3d',
  'cad',
  'code',
  'simulation',
  'data',
  'visualization',
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<PluginCapability, string> = {
  research: 'Research',
  render3d: '3D rendering',
  cad: 'CAD export',
  code: 'Code generation',
  simulation: 'Simulation',
  data: 'Data',
  visualization: 'Visualization',
};

export interface RendererHandle {
  /** Re-render with a newer scene, without tearing the view down. */
  update(scene: CanonicalScene): void;
  dispose(): void;
}

/**
 * A consumer of the canonical representation. Three.js would be one
 * implementation; an SVG diagram or an OpenSCAD exporter would be others. All of
 * them receive the same explicit scene.
 */
export interface CanonicalRenderer {
  readonly id: string;
  readonly label: string;
  render(scene: CanonicalScene, mount: HTMLElement): RendererHandle;
}

export interface IdenoPluginContext {
  registerResearchSource(source: ResearchSource): void;
  registerRenderer(renderer: CanonicalRenderer): void;
  getState(): IdeaCase | null;
  /** Null until an idea exists: there is nothing to project before then. */
  getCanonicalScene(): CanonicalProjection | null;
  subscribe(listener: (event: StateEvent) => void): () => void;
}

export interface IdenoPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: PluginCapability[];
  activate(context: IdenoPluginContext): void | Promise<void>;
}

export type PluginStatus = 'registered' | 'active' | 'failed';

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  capabilities: PluginCapability[];
  status: PluginStatus;
  /** Present when activation failed. One broken plugin must not break Ideno. */
  error: string | null;
}

export interface PluginRegistryOptions {
  state: StateManager;
  research: ResearchRegistry;
}

export class PluginRegistry {
  #state: StateManager;
  #research: ResearchRegistry;
  #plugins = new Map<string, { plugin: IdenoPlugin; status: PluginStatus; error: string | null }>();
  #renderers = new Map<string, CanonicalRenderer>();

  constructor(options: PluginRegistryOptions) {
    this.#state = options.state;
    this.#research = options.research;
  }

  get research(): ResearchRegistry {
    return this.#research;
  }

  register(plugin: IdenoPlugin): void {
    if (this.#plugins.has(plugin.id)) {
      throw new Error(`A plugin with id "${plugin.id}" is already registered.`);
    }
    for (const capability of plugin.capabilities) {
      if (!PLUGIN_CAPABILITIES.includes(capability)) {
        throw new Error(`Plugin "${plugin.id}" declares an unknown capability "${capability}".`);
      }
    }
    this.#plugins.set(plugin.id, { plugin, status: 'registered', error: null });
  }

  unregister(id: string): boolean {
    return this.#plugins.delete(id);
  }

  /**
   * Activates every registered plugin. Failures are recorded per plugin and do
   * not abort the others: a broken visualisation must not stop the idea from
   * being developed.
   */
  async activateAll(): Promise<void> {
    const context = this.createContext();
    for (const entry of this.#plugins.values()) {
      if (entry.status === 'active') continue;
      try {
        await entry.plugin.activate(context);
        entry.status = 'active';
        entry.error = null;
      } catch (error) {
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : 'The plugin failed to activate.';
      }
    }
  }

  list(): PluginRecord[] {
    return [...this.#plugins.values()].map((entry) => ({
      id: entry.plugin.id,
      name: entry.plugin.name,
      version: entry.plugin.version,
      capabilities: [...entry.plugin.capabilities],
      status: entry.status,
      error: entry.error,
    }));
  }

  renderers(): CanonicalRenderer[] {
    return [...this.#renderers.values()];
  }

  renderer(id: string): CanonicalRenderer | null {
    return this.#renderers.get(id) ?? null;
  }

  createContext(): IdenoPluginContext {
    const state = this.#state;
    const research = this.#research;
    const renderers = this.#renderers;

    return {
      registerResearchSource(source) {
        research.register(source);
      },
      registerRenderer(renderer) {
        if (renderers.has(renderer.id)) {
          throw new Error(`A renderer with id "${renderer.id}" is already registered.`);
        }
        renderers.set(renderer.id, renderer);
      },
      getState() {
        return state.idea;
      },
      getCanonicalScene() {
        const idea = state.idea;
        return idea ? projectCanonicalScene(idea) : null;
      },
      subscribe(listener) {
        return state.subscribe(listener);
      },
    };
  }
}
