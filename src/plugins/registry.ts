/**
 * Plugin extension point.
 *
 * v0.1 ships exactly one plugin — research — and the registry exists because
 * the server genuinely needs to report which capabilities are available. It is
 * not a staging area for imaginary features: a plugin is only listed once it
 * is registered by real code that can run.
 *
 * Future plugins (3D, CAD, simulation, visualisation) attach here. The
 * contract they will consume is the renderer-independent canonical
 * representation in `./canonical/schema.ts`, not free-form natural language,
 * so that every representation is derived from the same Idea State.
 */

export type PluginKind = 'research' | 'representation' | 'analysis';

export interface PluginDescriptor {
  readonly id: string;
  readonly kind: PluginKind;
  readonly label: string;
  readonly description: string;
  /** False when the plugin is registered but missing configuration. */
  readonly available: boolean;
  /** Why it is unavailable, when it is. */
  readonly detail?: string;
}

export class PluginRegistry {
  readonly #plugins = new Map<string, PluginDescriptor>();

  register(descriptor: PluginDescriptor): void {
    if (this.#plugins.has(descriptor.id)) {
      throw new Error(`Plugin "${descriptor.id}" is already registered`);
    }
    this.#plugins.set(descriptor.id, descriptor);
  }

  list(): PluginDescriptor[] {
    return [...this.#plugins.values()];
  }

  get(id: string): PluginDescriptor | null {
    return this.#plugins.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#plugins.has(id);
  }
}
