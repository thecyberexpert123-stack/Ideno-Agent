/**
 * The canonical representation: Idea State → renderer-independent scene.
 *
 * This is the contract a future 3D, CAD or diagram renderer consumes. The point
 * of it is that no renderer ever receives free-form natural language and decides
 * for itself what to build:
 *
 *     Idea State → CanonicalScene → (Three.js | OpenSCAD | SVG | ...)
 *
 * So the scene is explicit about geometry, topology and constraints, and it uses
 * normalised units. A renderer that disagrees with the modelling choices still
 * gets the same facts.
 *
 * Projection is deliberately conservative. It derives a scene from the *selected*
 * alternative's component graph plus the physical constraints recorded in the
 * state, and it reports — rather than hides — anything it could not resolve: an
 * unparseable dimension, a connection naming an object that does not exist, or no
 * selection at all. Guessing geometry would be the same defect as guessing
 * evidence.
 */
import { z } from 'zod';

import type { ComponentGraph, IdeaCase } from '../core/schemas/index.js';
import { newId, systemClock, type Clock } from '../core/ids.js';

export const CANONICAL_SCHEMA_VERSION = 1;

export const CanonicalUnitSchema = z.enum(['mm', 'cm', 'm', 'in']);
export type CanonicalUnit = z.infer<typeof CanonicalUnitSchema>;

/** Millimetres per unit. Inches are exactly 25.4 mm by definition. */
export const MM_PER_UNIT: Record<CanonicalUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

export interface Quantity {
  value: number;
  unit: CanonicalUnit;
  /** Normalised value in millimetres. */
  mm: number;
}

const QUANTITY_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|inch|inches|millimet(er|re)?s?|centimet(er|re)?s?|met(er|re)?s?)?\s*$/i;

const UNIT_ALIASES: Record<string, CanonicalUnit> = {
  mm: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  cm: 'cm',
  centimeter: 'cm',
  centimeters: 'cm',
  centimetre: 'cm',
  centimetres: 'cm',
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  in: 'in',
  inch: 'in',
  inches: 'in',
};

/**
 * Parses a dimension written the way people write dimensions ("40mm", "1.2 m",
 * "3 inches"). A bare number is treated as millimetres, because the canonical
 * scene is millimetre-based and silently assuming metres would be a 1000× error.
 *
 * Returns `null` for anything it cannot parse; callers record that as a note.
 */
export function parseQuantity(text: string): Quantity | null {
  if (typeof text !== 'string') return null;
  const match = QUANTITY_PATTERN.exec(text);
  if (!match) return null;

  const value = Number(match[1]);
  // Zero and negative lengths are not geometry; refusing them is better than
  // projecting a degenerate object a renderer would have to special-case.
  if (!Number.isFinite(value) || value <= 0) return null;

  const rawUnit = (match[2] ?? 'mm').toLowerCase();
  const unit = UNIT_ALIASES[rawUnit] ?? 'mm';
  return { value, unit, mm: round(value * MM_PER_UNIT[unit]) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type CanonicalObjectType = 'box' | 'cylinder' | 'sphere' | 'tube' | 'assembly' | 'custom';

export interface CanonicalObject {
  id: string;
  name: string;
  type: CanonicalObjectType;
  /** Named dimensions, each normalised. Absent when unparseable — never guessed. */
  dimensions: Record<string, Quantity>;
  properties: Record<string, string | number | boolean>;
  material: string | null;
}

export type CanonicalConnectionKind = 'fluid' | 'electrical' | 'data' | 'mechanical' | 'thermal' | 'other';

export interface CanonicalConnection {
  id: string;
  /** Object ids, resolved from the names used in the component graph. */
  from: string;
  to: string;
  kind: CanonicalConnectionKind;
  label: string | null;
}

export interface CanonicalConstraint {
  key: string;
  value: string | number | boolean;
  /** Idea State item this constraint came from, when it came from one. */
  source_item_id: string | null;
}

export const CanonicalSceneSchema = z.object({
  schema_version: z.literal(CANONICAL_SCHEMA_VERSION),
  case_id: z.string(),
  title: z.string(),
  /** Alternative the scene was projected from, or null when none is selected. */
  alternative_id: z.string().nullable(),
  alternative_name: z.string().nullable(),
  units: z.literal('mm'),
  objects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.enum(['box', 'cylinder', 'sphere', 'tube', 'assembly', 'custom']),
      dimensions: z.record(z.string(), z.object({ value: z.number(), unit: CanonicalUnitSchema, mm: z.number() })),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      material: z.string().nullable(),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.enum(['fluid', 'electrical', 'data', 'mechanical', 'thermal', 'other']),
      label: z.string().nullable(),
    }),
  ),
  constraints: z.array(
    z.object({
      key: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
      source_item_id: z.string().nullable(),
    }),
  ),
  generated_at: z.iso.datetime(),
});
export type CanonicalScene = z.infer<typeof CanonicalSceneSchema>;

export interface CanonicalProjection {
  scene: CanonicalScene;
  /** Everything that could not be projected, in plain language. */
  notes: string[];
}

/** Constraint categories that describe physical reality rather than preference. */
const PHYSICAL_CATEGORIES = new Set(['physical', 'environmental', 'power', 'connectivity']);

export interface ProjectOptions {
  clock?: Clock;
}

/**
 * Projects the selected alternative into a canonical scene.
 *
 * With no alternative selected there is no geometry to project, and the result
 * says so instead of inventing a model; the state's own physical constraints are
 * still included, because those hold regardless of which approach is chosen.
 */
export function projectCanonicalScene(idea: IdeaCase, options: ProjectOptions = {}): CanonicalProjection {
  const clock = options.clock ?? systemClock;
  const notes: string[] = [];

  const selected = idea.selected_alternative_id
    ? idea.alternatives.find((alternative) => alternative.id === idea.selected_alternative_id) ?? null
    : null;

  if (!selected) {
    notes.push(
      idea.alternatives.length === 0
        ? 'No alternatives have been proposed yet, so there is no geometry to project.'
        : 'No alternative is selected. Select one to project its geometry; constraints below hold for every option.',
    );
  }

  const graph: ComponentGraph | null = selected?.spec ?? null;
  const objects: CanonicalObject[] = [];
  const connections: CanonicalConnection[] = [];
  const idByName = new Map<string, string>();

  for (const component of graph?.objects ?? []) {
    const id = slugId(component.name);
    if (idByName.has(component.name)) {
      notes.push(`Duplicate object name "${component.name}"; only the first was projected.`);
      continue;
    }
    idByName.set(component.name, id);

    const dimensions: Record<string, Quantity> = {};
    for (const [name, raw] of Object.entries(component.dimensions)) {
      const quantity = parseQuantity(raw);
      if (!quantity) {
        notes.push(`Could not parse the ${name} dimension "${raw}" of "${component.name}"; it was omitted.`);
        continue;
      }
      dimensions[name] = quantity;
    }

    objects.push({
      id,
      name: component.name,
      type: component.type,
      dimensions,
      properties: { ...component.properties },
      material: component.material,
    });
  }

  for (const link of graph?.connections ?? []) {
    const from = idByName.get(link.from);
    const to = idByName.get(link.to);
    if (!from || !to) {
      notes.push(
        `Connection "${link.from}" → "${link.to}" names an object that is not in the graph; it was omitted.`,
      );
      continue;
    }
    connections.push({ id: newId('link'), from, to, kind: link.kind, label: link.label });
  }

  const constraints: CanonicalConstraint[] = [];
  for (const entry of graph?.constraints ?? []) {
    constraints.push({ key: entry.key, value: entry.value, source_item_id: selected?.id ?? null });
  }
  for (const constraint of idea.constraints) {
    if (constraint.status !== 'active') continue;
    if (!PHYSICAL_CATEGORIES.has(constraint.category)) continue;
    constraints.push({
      key: slugKey(constraint.text),
      value: constraint.text,
      source_item_id: constraint.id,
    });
  }

  const scene: CanonicalScene = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    case_id: idea.id,
    title: idea.title,
    alternative_id: selected?.id ?? null,
    alternative_name: selected?.name ?? null,
    units: 'mm',
    objects,
    connections,
    constraints,
    generated_at: clock(),
  };

  const validated = CanonicalSceneSchema.safeParse(scene);
  if (!validated.success) {
    // Should be unreachable: the scene is built from validated state. If it ever
    // fails, say so rather than handing a renderer something malformed.
    notes.push(`The projected scene failed validation: ${validated.error.message}`);
  }

  return { scene: validated.success ? validated.data : scene, notes };
}

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `obj_${slug || newId('x').slice(4)}`;
}

function slugKey(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || 'constraint';
}
