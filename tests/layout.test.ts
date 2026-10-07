/**
 * Layout and the Three.js renderer plugin (B5).
 *
 * The layout is the part that can be tested properly, and it is where the modelling
 * decisions live: how a named dimension maps onto an axis, where objects go, what
 * happens when a dimension is missing. Three.js itself is exercised only as far as an
 * environment with no GPU allows — which is far enough to cover the paths that
 * matter, because the failure path (no WebGL) is the one a real user is most likely
 * to hit in an embedded engine.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { projectCanonicalScene } from '../src/render/canonical.js';
import {
  projectLayout,
  suggestedCameraDistance,
  suggestedGridStep,
  normaliseKey,
} from '../src/render/layout.js';
import {
  LINK_COLORS,
  PARTIAL_COLOR,
  PLACEHOLDER_COLOR,
  SOLID_COLOR,
  THREE_PLUGIN_ID,
  colorForLink,
  colorForObject,
  createThreePlugin,
  createThreeRenderer,
  describeLayout,
  webglAvailable,
} from '../src/plugins/renderers/three.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { ResearchRegistry } from '../src/research/evidence.js';
import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { createIdeaCase, createHistoryRoot } from '../src/core/idea_state/create.js';
import { fixedClock } from '../src/core/ids.js';
import type { CanonicalScene } from '../src/render/canonical.js';

const CLOCK = fixedClock('2026-04-01T00:00:00.000Z');

/** A scene with three fully specified components and two connections. */
function scene(input: Partial<CanonicalScene> = {}): CanonicalScene {
  return {
    schema_version: 1,
    case_id: 'idea_1',
    title: 'Balcony greenhouse',
    alternative_id: 'alt_1',
    alternative_name: 'Active hydroponic loop',
    units: 'mm',
    objects: [
      {
        id: 'obj_frame',
        name: 'Frame',
        type: 'box',
        dimensions: {
          width: { value: 1200, unit: 'mm', mm: 1200 },
          height: { value: 1800, unit: 'mm', mm: 1800 },
          depth: { value: 600, unit: 'mm', mm: 600 },
        },
        properties: {},
        material: 'aluminium',
      },
      {
        id: 'obj_reservoir',
        name: 'Reservoir',
        type: 'cylinder',
        dimensions: {
          diameter: { value: 220, unit: 'mm', mm: 220 },
          height: { value: 250, unit: 'mm', mm: 250 },
        },
        properties: {},
        material: null,
      },
      {
        id: 'obj_pump',
        name: 'Pump',
        type: 'custom',
        dimensions: {
          length: { value: 120, unit: 'mm', mm: 120 },
          width: { value: 80, unit: 'mm', mm: 80 },
          height: { value: 60, unit: 'mm', mm: 60 },
        },
        properties: {},
        material: null,
      },
    ],
    connections: [
      { id: 'link_1', from: 'obj_pump', to: 'obj_reservoir', kind: 'fluid', label: 'suction' },
      { id: 'link_2', from: 'obj_reservoir', to: 'obj_frame', kind: 'mechanical', label: null },
    ],
    constraints: [],
    generated_at: '2026-04-01T00:00:00.000Z',
    ...input,
  };
}

describe('dimension resolution', () => {
  it('maps named dimensions onto axes with Y up', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    const frame = layout.objects.find((object) => object.id === 'obj_frame')!;
    expect(frame.size).toEqual({ x: 1200, y: 1800, z: 600 });
    expect(frame.missing_axes).toEqual([]);
    expect(frame.placeholder).toBe(false);
  });

  it('spans a diameter across both horizontal axes for a cylinder', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    const reservoir = layout.objects.find((object) => object.id === 'obj_reservoir')!;
    expect(reservoir.size).toEqual({ x: 220, y: 250, z: 220 });
    expect(reservoir.radius).toBe(110);
  });

  it('spans a diameter across all three axes for a sphere', () => {
    const layout = projectLayout(
      scene({
        objects: [
          {
            id: 'obj_ball',
            name: 'Ball valve',
            type: 'sphere',
            dimensions: { diameter: { value: 40, unit: 'mm', mm: 40 } },
            properties: {},
            material: null,
          },
        ],
      }),
      { clock: CLOCK },
    );
    expect(layout.objects[0]!.size).toEqual({ x: 40, y: 40, z: 40 });
  });

  it('accepts a radius when no diameter is given', () => {
    const layout = projectLayout(
      scene({
        objects: [
          {
            id: 'obj_tank',
            name: 'Tank',
            type: 'cylinder',
            dimensions: {
              radius: { value: 100, unit: 'mm', mm: 100 },
              height: { value: 300, unit: 'mm', mm: 300 },
            },
            properties: {},
            material: null,
          },
        ],
      }),
      { clock: CLOCK },
    );
    expect(layout.objects[0]!.size).toEqual({ x: 200, y: 300, z: 200 });
  });

  it('treats spelling variants of a dimension name as the same dimension', () => {
    for (const name of ['outer_diameter', 'Outer Diameter', 'outerDiameter', 'OUTER-DIAMETER']) {
      expect(normaliseKey(name)).toBe('outerdiameter');
    }
  });

  it('reads a diameter however it is spelled, including the abbreviation', () => {
    // `OD` is an abbreviation rather than a spelling of "outer diameter", so it is
    // matched by the key list, not by normalisation. Both routes have to work, or a
    // component specified by an engineer reads as unspecified.
    for (const name of ['diameter', 'outer_diameter', 'od', 'bore']) {
      const layout = projectLayout(
        scene({
          objects: [
            {
              id: 'obj_pipe',
              name: 'Pipe',
              type: 'cylinder',
              dimensions: {
                [name]: { value: 50, unit: 'mm', mm: 50 },
                height: { value: 400, unit: 'mm', mm: 400 },
              },
              properties: {},
              material: null,
            },
          ],
        }),
        { clock: CLOCK },
      );
      expect(layout.objects[0]!.size, name).toEqual({ x: 50, y: 400, z: 50 });
      expect(layout.objects[0]!.placeholder, name).toBe(false);
    }
  });

  it('fills a missing axis from the smallest known one and says so', () => {
    const layout = projectLayout(
      scene({
        objects: [
          {
            id: 'obj_tray',
            name: 'Seed tray',
            type: 'box',
            dimensions: {
              width: { value: 400, unit: 'mm', mm: 400 },
              height: { value: 80, unit: 'mm', mm: 80 },
            },
            properties: {},
            material: null,
          },
        ],
      }),
      { clock: CLOCK },
    );
    const tray = layout.objects[0]!;
    // The conservative choice: a balcony constraint is violated by drawing something
    // too big, not too small.
    expect(tray.size).toEqual({ x: 400, y: 80, z: 80 });
    expect(tray.missing_axes).toEqual(['z']);
    expect(tray.placeholder).toBe(false);
    expect(layout.notes.join(' ')).toMatch(/Seed tray.*not z|Seed tray.*z/);
  });

  it('draws an object with no readable dimension as a labelled placeholder', () => {
    const layout = projectLayout(
      scene({
        objects: [
          { id: 'obj_mystery', name: 'Controller', type: 'custom', dimensions: {}, properties: {}, material: null },
        ],
      }),
      { clock: CLOCK, placeholder_size: 25 },
    );
    const mystery = layout.objects[0]!;
    expect(mystery.size).toBeNull();
    expect(mystery.placeholder).toBe(true);
    expect(mystery.missing_axes).toEqual(['x', 'y', 'z']);
    expect(layout.notes.join(' ')).toContain('25 mm placeholder rather than at a guessed size');
  });

  it('refuses a dimension that the canonical projection already rejected', () => {
    // A flow rate is not a length. The projection drops it, so the layout never sees
    // it — asserted here because a renderer silently treating "200 mL/min" as a size
    // would be exactly the kind of guess this pipeline exists to prevent.
    const root = createHistoryRoot(CLOCK);
    const idea = createIdeaCase({ original_idea: 'A greenhouse.', clock: CLOCK, root });
    idea.selected_alternative_id = 'alt_1';
    idea.alternatives.push({
      id: 'alt_1',
      name: 'Loop',
      text: 'Loop',
      summary: 'Loop',
      provenance: 'model_suggestion',
      origin_operation: 'explore',
      source_message_id: null,
      evidence_refs: [],
      notes: null,
      created_at: CLOCK(),
      updated_at: null,
      status: 'selected',
      pros: [],
      cons: [],
      addresses: [],
      spec: {
        objects: [
          {
            name: 'Pump',
            type: 'custom',
            dimensions: { flow: '200 mL/min' },
            properties: { flow_rate: '200 mL/min' },
            material: null,
          },
        ],
        connections: [],
        constraints: [],
      },
    });
    root.version.snapshot = null;
    const projection = projectCanonicalScene(idea, { clock: CLOCK });
    expect(projection.notes.join(' ')).toMatch(/Could not parse the flow dimension/);
    const layout = projectLayout(projection.scene, { clock: CLOCK });
    expect(layout.objects[0]!.placeholder).toBe(true);
  });
});

describe('placement', () => {
  it('is deterministic', () => {
    const first = projectLayout(scene(), { clock: CLOCK });
    const second = projectLayout(scene(), { clock: CLOCK });
    expect(first.objects.map((object) => object.position)).toEqual(second.objects.map((object) => object.position));
    expect(first.bounds).toEqual(second.bounds);
  });

  it('never overlaps two objects', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    for (let i = 0; i < layout.objects.length; i += 1) {
      for (let j = i + 1; j < layout.objects.length; j += 1) {
        const a = layout.objects[i]!;
        const b = layout.objects[j]!;
        const ax = a.size?.x ?? 40;
        const az = a.size?.z ?? 40;
        const bx = b.size?.x ?? 40;
        const bz = b.size?.z ?? 40;
        const overlaps =
          Math.abs(a.position.x - b.position.x) < (ax + bx) / 2 &&
          Math.abs(a.position.z - b.position.z) < (az + bz) / 2;
        expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it('rests objects on the ground plane rather than centring them on it', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    for (const object of layout.objects) {
      const height = object.size?.y ?? 40;
      expect(object.position.y).toBeCloseTo(height / 2, 6);
    }
    expect(layout.bounds.min.y).toBeCloseTo(0, 6);
  });

  it('places connected objects nearer to each other than the grid is wide', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    const pump = layout.objects.find((object) => object.id === 'obj_pump')!;
    const reservoir = layout.objects.find((object) => object.id === 'obj_reservoir')!;
    const distance = Math.hypot(pump.position.x - reservoir.position.x, pump.position.z - reservoir.position.z);
    // The largest footprint is the frame at 1200 mm, plus the default gap.
    expect(distance).toBeLessThanOrEqual(1200 + 60);
  });

  it('lays out an empty scene without inventing objects', () => {
    const layout = projectLayout(scene({ objects: [], connections: [] }), { clock: CLOCK });
    expect(layout.objects).toEqual([]);
    expect(layout.links).toEqual([]);
    expect(layout.bounds.size).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('links only objects that exist', () => {
    const layout = projectLayout(
      scene({
        connections: [
          { id: 'link_bad', from: 'obj_pump', to: 'obj_absent', kind: 'data', label: null },
          { id: 'link_ok', from: 'obj_pump', to: 'obj_reservoir', kind: 'fluid', label: null },
        ],
      }),
      { clock: CLOCK },
    );
    expect(layout.links.map((link) => link.id)).toEqual(['link_ok']);
    expect(layout.notes.join(' ')).toContain('obj_absent');
  });

  it('derives a camera distance and grid step from the bounds', () => {
    const layout = projectLayout(scene(), { clock: CLOCK });
    const distance = suggestedCameraDistance(layout.bounds);
    // The largest object is 1800 mm tall; the camera has to be further away than that.
    expect(distance).toBeGreaterThan(layout.bounds.size.y);
    const step = suggestedGridStep(layout.bounds);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(Math.max(layout.bounds.size.x, layout.bounds.size.z));

    // Degenerate bounds must not produce NaN or Infinity, which would put the camera
    // nowhere and show a blank view with no explanation.
    const empty = projectLayout(scene({ objects: [], connections: [] }), { clock: CLOCK });
    expect(Number.isFinite(suggestedCameraDistance(empty.bounds))).toBe(true);
    expect(Number.isFinite(suggestedGridStep(empty.bounds))).toBe(true);
  });
});

describe('renderer colouring', () => {
  it('distinguishes fully specified, partly specified and unknown geometry', () => {
    expect(colorForObject({ placeholder: false, missing_axes: [] })).toBe(SOLID_COLOR);
    expect(colorForObject({ placeholder: false, missing_axes: ['z'] })).toBe(PARTIAL_COLOR);
    expect(colorForObject({ placeholder: true, missing_axes: ['x', 'y', 'z'] })).toBe(PLACEHOLDER_COLOR);
    // The three must be visibly different, or the distinction carries no information.
    expect(new Set([SOLID_COLOR, PARTIAL_COLOR, PLACEHOLDER_COLOR]).size).toBe(3);
  });

  it('gives every connection kind its own colour and a default', () => {
    const kinds = Object.keys(LINK_COLORS);
    expect(new Set(kinds.map((kind) => LINK_COLORS[kind])).size).toBe(kinds.length);
    expect(colorForLink('fluid')).toBe(LINK_COLORS.fluid);
    expect(colorForLink('something-invented')).toBe(LINK_COLORS.other);
  });
});

describe('describeLayout', () => {
  it('reports sizes and what was missing, in plain language', () => {
    const lines = describeLayout(projectLayout(scene(), { clock: CLOCK }));
    expect(lines).toContain('Frame (box): 1200 × 1800 × 600 mm');
    expect(lines).toContain('Reservoir (cylinder): 220 × 250 × 220 mm');
  });

  it('says when an object has no dimensions at all', () => {
    const lines = describeLayout(
      projectLayout(
        scene({
          objects: [{ id: 'obj_x', name: 'Controller', type: 'custom', dimensions: {}, properties: {}, material: null }],
        }),
        { clock: CLOCK },
      ),
    );
    expect(lines[0]).toContain('no dimensions given');
    expect(lines[0]).toContain('placeholder');
  });
});

describe('the Three.js plugin', () => {
  it('registers through the plugin registry as a 3D renderer', async () => {
    const state = new StateManager({ store: new MemoryStore(), clock: CLOCK, persist: false });
    const registry = new PluginRegistry({ state, research: new ResearchRegistry() });
    registry.register(createThreePlugin());
    await registry.activateAll();

    const records = registry.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: THREE_PLUGIN_ID, status: 'active', error: null });
    expect(records[0]!.capabilities).toEqual(['render3d']);
    expect(registry.renderers()).toHaveLength(1);
    expect(registry.renderers()[0]!.label).toContain('Three.js');
  });

  it('reports a WebGL-free environment instead of throwing from inside Three.js', () => {
    // jsdom has no WebGL, which is also the situation in an embedded engine that was
    // built without it. The check happens before any Three.js constructor runs.
    expect(webglAvailable()).toBe(false);
    expect(webglAvailable(() => null)).toBe(false);
    expect(
      webglAvailable(() => {
        throw new Error('no context factory');
      }),
    ).toBe(false);
    // And it is true when a context can be made, which is the whole test.
    expect(
      webglAvailable(
        () =>
          ({
            getContext: (kind: string) => (kind === 'webgl2' ? {} : null),
          }) as unknown as HTMLCanvasElement,
      ),
    ).toBe(true);
  });

  it('renders a readable explanation into the mount when WebGL is missing', async () => {
    const mount = document.createElement('div');
    Object.defineProperty(mount, 'clientWidth', { value: 400 });
    Object.defineProperty(mount, 'clientHeight', { value: 300 });
    document.body.appendChild(mount);

    let threeRequested = false;
    const renderer = createThreeRenderer({
      loadThree: async () => {
        threeRequested = true;
        return {} as never;
      },
      loadControls: async () => ({ OrbitControls: class {} as never }),
    });
    const handle = renderer.render(scene(), mount);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(threeRequested).toBe(true);
    const fallback = mount.querySelector('.viewer-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toMatch(/did not provide WebGL/);
    // The same data is offered in another form, so a missing GPU is not a dead end.
    expect(fallback!.textContent).toMatch(/same data the 3D view uses/);
    expect(mount.querySelector('canvas')).toBeNull();

    handle.dispose();
    mount.remove();
  });

  it('reports a Three.js that fails to load rather than leaving a blank box', async () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const renderer = createThreeRenderer({
      loadThree: async () => {
        throw new Error('network unreachable');
      },
      loadControls: async () => ({ OrbitControls: class {} as never }),
    });
    renderer.render(scene(), mount);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mount.querySelector('.viewer-fallback')!.textContent).toMatch(/network unreachable/);
    mount.remove();
  });

  it('does nothing when disposed before the imports resolve', async () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    // A holder rather than a captured variable: control-flow analysis concludes a
    // `let` assigned only inside a closure is still null, and refuses the call.
    const gate: { release: ((value: unknown) => void) | null } = { release: null };
    const renderer = createThreeRenderer({
      loadThree: () =>
        new Promise((resolve) => {
          gate.release = resolve;
        }) as never,
      loadControls: async () => ({ OrbitControls: class {} as never }),
    });
    const handle = renderer.render(scene(), mount);
    handle.dispose();
    gate.release?.({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A view torn down before it was built must not attach a canvas afterwards.
    expect(mount.querySelector('canvas')).toBeNull();
    expect(mount.childElementCount).toBe(0);
    mount.remove();
  });
});
