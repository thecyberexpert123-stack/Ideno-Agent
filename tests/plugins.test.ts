import { describe, expect, it, vi } from 'vitest';

import { PluginRegistry, type IdenoPlugin, type IdenoPluginContext } from '../src/plugins/registry.js';
import { ResearchRegistry, type ResearchSource } from '../src/research/evidence.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { fixedClock } from '../src/core/ids.js';
import type { CanonicalScene } from '../src/render/canonical.js';
import { makeManager } from './helpers.js';

function makeRegistry(state?: StateManager): { registry: PluginRegistry; research: ResearchRegistry; state: StateManager } {
  const manager = state ?? new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
  const research = new ResearchRegistry();
  return { registry: new PluginRegistry({ state: manager, research }), research, state: manager };
}

function plugin(overrides: Partial<IdenoPlugin> = {}): IdenoPlugin {
  return {
    id: 'test.plugin',
    name: 'Test plugin',
    version: '1.0.0',
    capabilities: ['visualization'],
    activate: () => undefined,
    ...overrides,
  };
}

describe('registration', () => {
  it('lists registered plugins with their declared capabilities', () => {
    const { registry } = makeRegistry();
    registry.register(plugin({ id: 'a', capabilities: ['render3d', 'cad'] }));
    registry.register(plugin({ id: 'b', name: 'Other', version: '0.2.1', capabilities: ['data'] }));

    expect(registry.list()).toEqual([
      { id: 'a', name: 'Test plugin', version: '1.0.0', capabilities: ['render3d', 'cad'], status: 'registered', error: null },
      { id: 'b', name: 'Other', version: '0.2.1', capabilities: ['data'], status: 'registered', error: null },
    ]);
  });

  it('refuses a duplicate plugin id', () => {
    const { registry } = makeRegistry();
    registry.register(plugin({ id: 'dup' }));
    expect(() => registry.register(plugin({ id: 'dup' }))).toThrowError(/already registered/);
  });

  it('refuses a capability Ideno does not define', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.register(plugin({ capabilities: ['teleportation'] as unknown as IdenoPlugin['capabilities'] })),
    ).toThrowError(/unknown capability "teleportation"/);
  });

  it('unregisters a plugin', () => {
    const { registry } = makeRegistry();
    registry.register(plugin({ id: 'gone' }));
    expect(registry.unregister('gone')).toBe(true);
    expect(registry.list()).toEqual([]);
  });
});

describe('activation', () => {
  it('activates plugins and hands them a working context', async () => {
    const { registry, state } = makeRegistry(makeManager());
    const seen: (IdenoPluginContext | null)[] = [null];
    registry.register(
      plugin({
        activate(context) {
          seen[0] = context;
        },
      }),
    );
    await registry.activateAll();

    expect(registry.list()[0]).toMatchObject({ status: 'active', error: null });
    expect(seen[0]?.getState()?.original_idea).toBe(state.idea?.original_idea);
  });

  it('isolates a failing plugin so the others still activate', async () => {
    const { registry } = makeRegistry();
    registry.register(
      plugin({
        id: 'broken',
        activate() {
          throw new Error('renderer crashed');
        },
      }),
    );
    registry.register(plugin({ id: 'fine' }));
    await registry.activateAll();

    const records = registry.list();
    expect(records.find((record) => record.id === 'broken')).toMatchObject({
      status: 'failed',
      error: 'renderer crashed',
    });
    expect(records.find((record) => record.id === 'fine')?.status).toBe('active');
  });

  it('records an asynchronous activation failure the same way', async () => {
    const { registry } = makeRegistry();
    registry.register(
      plugin({
        id: 'async-broken',
        async activate() {
          await Promise.resolve();
          throw new Error('late failure');
        },
      }),
    );
    await registry.activateAll();
    expect(registry.list()[0]).toMatchObject({ status: 'failed', error: 'late failure' });
  });

  it('does not activate a plugin twice', async () => {
    const { registry } = makeRegistry();
    const activate = vi.fn();
    registry.register(plugin({ activate }));
    await registry.activateAll();
    await registry.activateAll();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe('the extension points a plugin gets', () => {
  it('registers a research source into the shared registry', async () => {
    const { registry, research } = makeRegistry();
    const source: ResearchSource = {
      id: 'demo.source',
      label: 'Demo source',
      async search() {
        return [];
      },
    };
    registry.register(
      plugin({
        capabilities: ['research'],
        activate(context) {
          context.registerResearchSource(source);
        },
      }),
    );
    expect(research.empty).toBe(true);
    await registry.activateAll();
    expect(research.list()).toEqual([source]);
    expect(registry.research).toBe(research);
  });

  it('registers a canonical renderer and refuses a duplicate id', async () => {
    const { registry } = makeRegistry();
    const rendered: CanonicalScene[] = [];
    const renderer = {
      id: 'svg',
      label: 'SVG diagram',
      render(scene: CanonicalScene) {
        rendered.push(scene);
        return { update: (next: CanonicalScene) => rendered.push(next), dispose: () => undefined };
      },
    };
    registry.register(
      plugin({
        capabilities: ['render3d'],
        activate(context) {
          context.registerRenderer(renderer);
          expect(() => context.registerRenderer(renderer)).toThrowError(/already registered/);
        },
      }),
    );
    await registry.activateAll();
    expect(registry.renderers()).toHaveLength(1);
    expect(registry.renderer('svg')?.label).toBe('SVG diagram');
    expect(registry.renderer('missing')).toBeNull();
  });

  it('offers no way to mutate the idea state directly', () => {
    const { registry } = makeRegistry();
    const context = registry.createContext();
    // The context surface is read-only plus registration: changes must go through
    // the State Manager's validated change records.
    expect(Object.keys(context).sort()).toEqual([
      'getCanonicalScene',
      'getState',
      'registerRenderer',
      'registerResearchSource',
      'subscribe',
    ]);
  });

  it('reports no scene before an idea exists', () => {
    const { registry } = makeRegistry();
    const context = registry.createContext();
    expect(context.getState()).toBeNull();
    expect(context.getCanonicalScene()).toBeNull();
  });

  it('projects a canonical scene for a renderer to consume', async () => {
    const state = makeManager();
    const { registry } = makeRegistry(state);
    state.enqueueChanges(
      {
        alternatives_added: [
          {
            name: 'Frame',
            text: 'Frame',
            summary: 'A frame.',
            provenance: 'model_suggestion',
            spec: {
              objects: [{ name: 'Post', type: 'box', dimensions: { height: '2 m' }, properties: {}, material: null }],
              connections: [],
              constraints: [],
            },
          },
        ],
      },
      { origin: 'explore', message_id: null, review_mode: 'strict' },
    );
    state.acceptChanges(state.pendingChanges().map((record) => record.id));
    state.selectAlternative(state.idea!.alternatives[0]!.id);

    const projection = registry.createContext().getCanonicalScene();
    expect(projection?.scene.objects[0]?.dimensions.height?.mm).toBe(2000);
  });

  it('forwards state events to a subscriber', () => {
    const state = makeManager();
    const { registry } = makeRegistry(state);
    const events: string[] = [];
    const unsubscribe = registry.createContext().subscribe((event) => events.push(event.type));

    state.enqueueChanges(
      { constraints_added: [{ text: 'Must be quiet.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    unsubscribe();
    state.appendTranscript({ role: 'user', text: 'ignored' });

    expect(events).toContain('version_committed');
    expect(events).not.toContain('transcript_appended');
  });
});
