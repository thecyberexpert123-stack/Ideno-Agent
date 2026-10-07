import { describe, expect, it } from 'vitest';

import {
  CANONICAL_SCHEMA_VERSION,
  CanonicalSceneSchema,
  MM_PER_UNIT,
  parseQuantity,
  projectCanonicalScene,
} from '../src/render/canonical.js';
import { fixedClock } from '../src/core/ids.js';
import { createIdeaCase } from '../src/core/idea_state/create.js';
import type { Alternative, IdeaCase } from '../src/core/schemas/index.js';
import { runDemoScenario } from './helpers.js';

function caseWith(spec: Alternative['spec'], overrides: Partial<IdeaCase> = {}): IdeaCase {
  const idea = createIdeaCase({ original_idea: 'A reaction chamber.', clock: fixedClock() });
  const alternative: Alternative = {
    id: 'alt_1',
    name: 'Sealed chamber',
    text: 'Sealed chamber',
    summary: 'A sealed cylindrical chamber with an inlet and an outlet.',
    provenance: 'model_suggestion',
    origin_operation: 'explore',
    source_message_id: null,
    evidence_refs: [],
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    status: 'selected',
    pros: [],
    cons: [],
    addresses: [],
    spec,
  };
  return {
    ...idea,
    alternatives: [alternative],
    selected_alternative_id: 'alt_1',
    ...overrides,
  };
}

describe('parseQuantity', () => {
  it.each([
    ['40mm', 40, 'mm', 40],
    ['40 mm', 40, 'mm', 40],
    ['1.2 m', 1.2, 'm', 1200],
    ['80cm', 80, 'cm', 800],
    ['3 inches', 3, 'in', 76.2],
    ['2in', 2, 'in', 50.8],
    ['250', 250, 'mm', 250],
  ])('parses "%s"', (input, value, unit, mm) => {
    expect(parseQuantity(input)).toEqual({ value, unit, mm });
  });

  it('treats a bare number as millimetres, the canonical unit', () => {
    expect(parseQuantity('100')?.mm).toBe(100);
    expect(MM_PER_UNIT.mm).toBe(1);
  });

  it.each(['', '   ', 'large', '40 parsecs', 'mm', '0mm', '-5mm', 'NaN', '{}'])(
    'refuses "%s" rather than guessing',
    (input) => {
      expect(parseQuantity(input)).toBeNull();
    },
  );
});

describe('projectCanonicalScene', () => {
  it('projects objects, resolved connections and normalised units', () => {
    const idea = caseWith({
      objects: [
        {
          name: 'Reaction Chamber',
          type: 'cylinder',
          dimensions: { radius: '40mm', height: '80mm' },
          properties: { sealed: true, transparent: false },
          material: 'Borosilicate glass',
        },
        { name: 'Inlet', type: 'tube', dimensions: { length: '1.5 cm' }, properties: {}, material: null },
      ],
      connections: [{ from: 'Inlet', to: 'Reaction Chamber', kind: 'fluid', label: 'feed' }],
      constraints: [{ key: 'sealed', value: true }],
    });

    const { scene, notes } = projectCanonicalScene(idea);
    expect(notes).toEqual([]);
    expect(scene.schema_version).toBe(CANONICAL_SCHEMA_VERSION);
    expect(scene.units).toBe('mm');
    expect(scene.alternative_id).toBe('alt_1');
    expect(scene.objects).toHaveLength(2);

    const chamber = scene.objects[0]!;
    expect(chamber.id).toBe('obj_reaction_chamber');
    expect(chamber.type).toBe('cylinder');
    expect(chamber.dimensions.radius).toEqual({ value: 40, unit: 'mm', mm: 40 });
    expect(chamber.properties).toEqual({ sealed: true, transparent: false });
    expect(chamber.material).toBe('Borosilicate glass');
    expect(scene.objects[1]?.dimensions.length?.mm).toBe(15);

    // Connections reference object ids, not the free-text names in the graph.
    expect(scene.connections[0]).toMatchObject({
      from: 'obj_inlet',
      to: 'obj_reaction_chamber',
      kind: 'fluid',
      label: 'feed',
    });
    expect(scene.constraints).toContainEqual({ key: 'sealed', value: true, source_item_id: 'alt_1' });
    expect(CanonicalSceneSchema.safeParse(scene).success).toBe(true);
  });

  it('omits an unparseable dimension and says so', () => {
    const idea = caseWith({
      objects: [
        { name: 'Tank', type: 'box', dimensions: { width: '400mm', depth: 'about a metre' }, properties: {}, material: null },
      ],
      connections: [],
      constraints: [],
    });
    const { scene, notes } = projectCanonicalScene(idea);
    expect(scene.objects[0]?.dimensions).toEqual({ width: { value: 400, unit: 'mm', mm: 400 } });
    expect(notes.join(' ')).toMatch(/Could not parse the depth dimension "about a metre"/);
  });

  it('omits a connection that names an object which does not exist', () => {
    const idea = caseWith({
      objects: [{ name: 'Pump', type: 'custom', dimensions: {}, properties: {}, material: null }],
      connections: [{ from: 'Pump', to: 'Ghost', kind: 'fluid', label: null }],
      constraints: [],
    });
    const { scene, notes } = projectCanonicalScene(idea);
    expect(scene.connections).toEqual([]);
    expect(notes.join(' ')).toMatch(/names an object that is not in the graph/);
  });

  it('reports a duplicate object name instead of projecting it twice', () => {
    const duplicated = { name: 'Valve', type: 'custom' as const, dimensions: {}, properties: {}, material: null };
    const idea = caseWith({ objects: [duplicated, duplicated], connections: [], constraints: [] });
    const { scene, notes } = projectCanonicalScene(idea);
    expect(scene.objects).toHaveLength(1);
    expect(notes.join(' ')).toMatch(/Duplicate object name "Valve"/);
  });

  it('carries the state\'s physical constraints with their source item ids', () => {
    const idea = caseWith({ objects: [], connections: [], constraints: [] });
    idea.constraints.push(
      {
        id: 'con_1',
        text: 'Must fit within a balcony footprint and its load limit.',
        provenance: 'user_stated',
        origin_operation: 'update',
        source_message_id: null,
        evidence_refs: [],
        notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        status: 'active',
        category: 'physical',
        hard: true,
      },
      {
        id: 'con_2',
        text: 'Budget is 200 euros.',
        provenance: 'user_stated',
        origin_operation: 'update',
        source_message_id: null,
        evidence_refs: [],
        notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        status: 'active',
        category: 'budget',
        hard: true,
      },
      {
        id: 'con_3',
        text: 'Must survive wind load.',
        provenance: 'model_inferred',
        origin_operation: 'update',
        source_message_id: null,
        evidence_refs: [],
        notes: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        status: 'dropped',
        category: 'environmental',
        hard: true,
      },
    );

    const { scene } = projectCanonicalScene(idea);
    expect(scene.constraints).toEqual([
      {
        key: 'must_fit_within_a_balcony_footprint_and_its_load_limit',
        value: 'Must fit within a balcony footprint and its load limit.',
        source_item_id: 'con_1',
      },
    ]);
  });

  it('projects no geometry when nothing is selected, and explains why', () => {
    const idea = caseWith({
      objects: [{ name: 'Frame', type: 'box', dimensions: {}, properties: {}, material: null }],
      connections: [],
      constraints: [],
    });
    idea.selected_alternative_id = null;
    idea.alternatives[0]!.status = 'proposed';

    const { scene, notes } = projectCanonicalScene(idea);
    expect(scene.objects).toEqual([]);
    expect(scene.alternative_id).toBeNull();
    expect(notes.join(' ')).toMatch(/No alternative is selected/);
  });

  it('says so when no alternatives exist at all', () => {
    const idea = createIdeaCase({ original_idea: 'A kite.', clock: fixedClock() });
    const { scene, notes } = projectCanonicalScene(idea);
    expect(scene.objects).toEqual([]);
    expect(notes.join(' ')).toMatch(/No alternatives have been proposed yet/);
  });

  it('stamps a generated_at time from the injected clock', () => {
    const idea = caseWith({ objects: [], connections: [], constraints: [] });
    const { scene } = projectCanonicalScene(idea, { clock: () => '2026-05-05T05:05:05.000Z' });
    expect(scene.generated_at).toBe('2026-05-05T05:05:05.000Z');
  });
});

describe('canonical projection over a developed idea', () => {
  it('produces a renderable scene from the greenhouse scenario', async () => {
    const state = await runDemoScenario();
    const idea = state.idea;
    expect(idea).not.toBeNull();
    expect(idea?.selected_alternative_id).toBeTruthy();

    const { scene, notes } = projectCanonicalScene(idea!);
    expect(notes).toEqual([]);
    expect(scene.alternative_name).toBe('Battery-powered sensor node with local scheduler');
    expect(scene.objects.length).toBeGreaterThanOrEqual(6);

    const reservoir = scene.objects.find((object) => object.name === 'Reservoir');
    expect(reservoir?.type).toBe('cylinder');
    expect(reservoir?.dimensions.radius?.mm).toBe(90);
    expect(reservoir?.dimensions.height?.mm).toBe(220);

    // Topology survived the projection, with names resolved to ids.
    const pump = scene.objects.find((object) => object.name === 'Peristaltic pump');
    expect(
      scene.connections.some(
        (link) => link.to === pump?.id && link.kind === 'electrical',
      ),
    ).toBe(true);
    expect(scene.connections.some((link) => link.kind === 'fluid')).toBe(true);

    // The no-cloud constraint the user stated is in the scene, traceably.
    expect(scene.constraints).toContainEqual({ key: 'cloud_connectivity', value: false, source_item_id: scene.alternative_id });
    const balcony = scene.constraints.find((entry) => entry.value.toString().includes('balcony'));
    expect(balcony?.source_item_id).toBeTruthy();
    expect(CanonicalSceneSchema.safeParse(scene).success).toBe(true);
  });

  it('is renderer-independent: nothing in the scene refers to a renderer', async () => {
    const state = await runDemoScenario();
    const { scene } = projectCanonicalScene(state.idea!);
    const serialised = JSON.stringify(scene).toLowerCase();
    expect(serialised).not.toContain('three');
    expect(serialised).not.toContain('mesh');
    expect(serialised).not.toContain('geometry');
  });
});
