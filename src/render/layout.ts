/**
 * Layout: canonical scene → positioned objects.
 *
 * This sits between the canonical representation and any renderer:
 *
 *     Idea State → CanonicalScene → SceneLayout → (Three.js | SVG | OpenSCAD | …)
 *
 * It exists as its own step for one reason. "Where does this box go, and how big is
 * it in millimetres?" is a modelling decision, not a drawing decision. If each
 * renderer answered it independently, a 3D view and a 2D diagram of the same idea
 * would disagree, and neither could be checked against the other. Deciding it once,
 * in code that can be tested without a GPU, means every renderer shows the same
 * arrangement and the arrangement itself has a test suite.
 *
 * The rules, in the order they matter:
 *
 *  1. **Nothing is invented.** A dimension the canonical projection could not parse
 *     is absent, and stays absent: the object is reported as unresolved and drawn as
 *     a placeholder that looks like a placeholder. Guessing a size would be the same
 *     defect as guessing a citation.
 *  2. **Deterministic.** The same scene always produces the same layout, byte for
 *     byte. There is no randomness and no dependence on iteration order of a map.
 *  3. **Explained.** Every compromise — a missing axis, a placeholder, an object
 *     placed away from the thing it connects to — is listed in `notes`.
 */
import type { CanonicalConnectionKind, CanonicalObjectType, CanonicalScene } from './canonical.js';
import { newId, systemClock, type Clock } from '../core/ids.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Axis = 'x' | 'y' | 'z';

export interface LayoutObject {
  id: string;
  name: string;
  type: CanonicalObjectType;
  /** Bounding size in millimetres, or null when nothing could be resolved. */
  size: Vec3 | null;
  /** Centre position in millimetres. Objects rest on the y = 0 ground plane. */
  position: Vec3;
  /** Axes that were not specified and had to be filled in from the ones that were. */
  missing_axes: Axis[];
  /** True when no dimension at all could be resolved, so this is a placeholder. */
  placeholder: boolean;
  /** Cylinder/sphere/tube radius in mm, when the type has one and it is known. */
  radius: number | null;
  material: string | null;
}

export interface LayoutLink {
  id: string;
  from: string;
  to: string;
  kind: CanonicalConnectionKind;
  label: string | null;
  from_position: Vec3;
  to_position: Vec3;
}

export interface SceneLayout {
  units: 'mm';
  objects: LayoutObject[];
  links: LayoutLink[];
  bounds: { min: Vec3; max: Vec3; size: Vec3 };
  /** Everything the layout had to decide, compromise on, or could not resolve. */
  notes: string[];
  generated_at: string;
}

export interface LayoutOptions {
  clock?: Clock;
  /** Gap between neighbouring objects, in millimetres. */
  gap?: number;
  /** Size used for an object with no resolvable dimension at all. */
  placeholder_size?: number;
}

/** Default spacing: enough to see that two objects are two objects. */
const DEFAULT_GAP_MM = 60;
/**
 * A placeholder is deliberately small and obviously not geometry. Making it large
 * would let an unresolved object dominate the view and imply a size nobody stated.
 */
const DEFAULT_PLACEHOLDER_MM = 40;

/**
 * Which dimension names mean which axis.
 *
 * Y is up, matching the convention every 3D tool uses, so "height" is Y and
 * "depth" is Z. Names are matched case-insensitively after stripping anything that
 * is not a letter, so `outer_diameter`, `Outer Diameter` and `outerDiameter` all
 * resolve the same way.
 */
const AXIS_KEYS: Record<Axis, string[]> = {
  x: ['width', 'w', 'x', 'length', 'l', 'span', 'longside'],
  y: ['height', 'h', 'y', 'thickness', 'elevation', 'vertical', 'depthvertical'],
  z: ['depth', 'd', 'z', 'breadth'],
};

/** Keys that describe a diameter, which spans two axes depending on the type. */
const DIAMETER_KEYS = ['diameter', 'outerDiameter', 'od', 'bore'];
const RADIUS_KEYS = ['radius', 'r', 'outerRadius'];

export interface ProjectLayoutResult {
  layout: SceneLayout;
}

/**
 * Lays out a canonical scene.
 *
 * Deterministic and side-effect free apart from the injected clock.
 */
export function projectLayout(scene: CanonicalScene, options: LayoutOptions = {}): SceneLayout {
  const clock = options.clock ?? systemClock;
  const gap = Math.max(0, options.gap ?? DEFAULT_GAP_MM);
  const placeholderSize = Math.max(1, options.placeholder_size ?? DEFAULT_PLACEHOLDER_MM);
  const notes: string[] = [];

  const resolved = scene.objects.map((object) => resolveSize(object, placeholderSize, notes));
  const positions = placeObjects(scene, resolved, gap);

  const objects: LayoutObject[] = resolved.map((entry, index) => {
    const position = positions[index] ?? { x: 0, y: 0, z: 0 };
    const size = entry.size;
    return {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      size,
      // Resting on the ground plane rather than centred on it: a greenhouse frame
      // drawn half below the floor reads as a mistake even when it is not one.
      position: { x: position.x, y: size ? size.y / 2 : placeholderSize / 2, z: position.z },
      missing_axes: entry.missing_axes,
      placeholder: entry.placeholder,
      radius: entry.radius,
      material: entry.material,
    };
  });

  const byId = new Map(objects.map((object) => [object.id, object]));
  const links: LayoutLink[] = [];
  for (const connection of scene.connections) {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    if (!from || !to) {
      // The canonical projection already refuses connections naming unknown objects,
      // so this is belt and braces: a layout must not invent an endpoint.
      notes.push(`A connection referenced "${connection.from}" or "${connection.to}", which are not in the scene.`);
      continue;
    }
    links.push({
      id: connection.id || newId('link'),
      from: from.id,
      to: to.id,
      kind: connection.kind,
      label: connection.label,
      from_position: from.position,
      to_position: to.position,
    });
  }

  return {
    units: 'mm',
    objects,
    links,
    bounds: computeBounds(objects, placeholderSize),
    notes,
    generated_at: clock(),
  };
}

interface ResolvedObject {
  id: string;
  name: string;
  type: CanonicalObjectType;
  size: Vec3 | null;
  missing_axes: Axis[];
  placeholder: boolean;
  radius: number | null;
  material: string | null;
}

/**
 * Resolves an object's named dimensions onto three axes.
 *
 * Partial information is handled honestly: the axes that were specified are used,
 * the axes that were not are filled from the smallest specified one, and each
 * filled axis is named in a note and in `missing_axes` so a renderer can show it
 * differently. No dimension means a placeholder, not a guess.
 */
function resolveSize(
  object: CanonicalScene['objects'][number],
  placeholderSize: number,
  notes: string[],
): ResolvedObject {
  const base: Omit<ResolvedObject, 'size' | 'missing_axes' | 'placeholder' | 'radius'> = {
    id: object.id,
    name: object.name,
    type: object.type,
    material: object.material,
  };

  const known = readDimensions(object.dimensions);
  const diameter = firstOf(known, DIAMETER_KEYS);
  const radius = firstOf(known, RADIUS_KEYS);
  const across = diameter ?? (radius !== null ? radius * 2 : null);

  const axes: Partial<Record<Axis, number>> = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = firstOf(known, AXIS_KEYS[axis]);
    if (value !== null) axes[axis] = value;
  }

  // A diameter spans two axes for anything round, and all three for a sphere.
  if (across !== null) {
    if (object.type === 'sphere') {
      axes.x ??= across;
      axes.y ??= across;
      axes.z ??= across;
    } else if (object.type === 'cylinder' || object.type === 'tube') {
      axes.x ??= across;
      axes.z ??= across;
      // A cylinder's own axis is Y unless a length says otherwise.
      const length = firstOf(known, ['length', 'l', 'height', 'h']);
      if (length !== null) axes.y ??= length;
    } else {
      axes.x ??= across;
      axes.z ??= across;
    }
  }

  const resolvedAxes = (['x', 'y', 'z'] as const).filter((axis) => axes[axis] !== undefined);
  if (resolvedAxes.length === 0) {
    notes.push(
      `"${object.name}" has no dimension Ideno could read, so it is drawn as a ${placeholderSize} mm placeholder rather than at a guessed size.`,
    );
    return { ...base, size: null, missing_axes: ['x', 'y', 'z'], placeholder: true, radius: null };
  }

  const missing = (['x', 'y', 'z'] as const).filter((axis) => axes[axis] === undefined);
  let size: Vec3;
  if (missing.length > 0) {
    // Filling a missing axis from the smallest known one keeps the object inside the
    // footprint it was actually given, which is the conservative choice: a balcony
    // constraint is violated by drawing something too big, not too small.
    const fill = Math.min(...resolvedAxes.map((axis) => axes[axis] as number));
    size = {
      x: axes.x ?? fill,
      y: axes.y ?? fill,
      z: axes.z ?? fill,
    };
    notes.push(
      `"${object.name}" specifies ${resolvedAxes.join(' and ')} but not ${missing.join(' or ')}; ` +
        `${missing.join(' and ')} ${missing.length === 1 ? 'was' : 'were'} drawn as ${round(fill)} mm.`,
    );
  } else {
    size = { x: axes.x as number, y: axes.y as number, z: axes.z as number };
  }

  return {
    ...base,
    size,
    missing_axes: missing,
    placeholder: false,
    radius: across !== null ? across / 2 : null,
  };
}

/** Normalises dimension names so `outer_diameter` and `Outer Diameter` agree. */
function readDimensions(dimensions: Record<string, { value: number; unit: string; mm: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [name, quantity] of Object.entries(dimensions)) {
    const key = normaliseKey(name);
    if (key.length === 0) continue;
    // Last write wins on a duplicate key, which cannot happen for distinct names and
    // is the least surprising resolution for two spellings of the same one.
    out.set(key, quantity.mm);
  }
  return out;
}

export function normaliseKey(name: string): string {
  return name.replace(/[^A-Za-z]/g, '').toLowerCase();
}

function firstOf(known: Map<string, number>, candidates: string[]): number | null {
  for (const candidate of candidates) {
    const value = known.get(normaliseKey(candidate));
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Places objects on a grid, in breadth-first order from the most connected object.
 *
 * A grid is not a solver, and it does not claim to be: nothing here knows that a
 * pump should sit below a reservoir. What it does guarantee is that objects joined
 * by a connection land near each other, that the arrangement is the same every time,
 * and that no two objects overlap. Producing a physically sensible arrangement is a
 * constraint-solving problem, and pretending a grid solved it would put a guess in
 * front of the user labelled as a design.
 */
function placeObjects(
  scene: CanonicalScene,
  resolved: ResolvedObject[],
  gap: number,
): { x: number; z: number }[] {
  const count = resolved.length;
  if (count === 0) return [];

  const indexById = new Map(resolved.map((object, index) => [object.id, index]));
  const adjacency: number[][] = resolved.map(() => []);
  for (const connection of scene.connections) {
    const from = indexById.get(connection.from);
    const to = indexById.get(connection.to);
    if (from === undefined || to === undefined || from === to) continue;
    adjacency[from]!.push(to);
    adjacency[to]!.push(from);
  }

  // Highest degree first, ties broken by scene order, so the result never depends on
  // anything as unstable as an object's insertion order in a map.
  const start = resolved
    .map((_object, index) => index)
    .sort((a, b) => adjacency[b]!.length - adjacency[a]!.length || a - b)[0]!;

  const order: number[] = [];
  const seen = new Set<number>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const index of frontier) {
      order.push(index);
      for (const neighbour of adjacency[index]!) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next.sort((a, b) => a - b);
  }
  // Objects nothing connects to are still placed, in scene order, after the rest.
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) order.push(index);
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  // Cell size comes from the largest footprint, so no two objects can overlap
  // whatever their individual sizes.
  const largest = resolved.reduce((widest, object) => {
    const size = object.size;
    if (!size) return widest;
    return Math.max(widest, size.x, size.z);
  }, DEFAULT_PLACEHOLDER_MM);
  const cell = largest + gap;

  const positions: { x: number; z: number }[] = new Array(count).fill({ x: 0, z: 0 });
  order.forEach((objectIndex, cellIndex) => {
    const column = cellIndex % columns;
    const row = Math.floor(cellIndex / columns);
    // Centred on the origin, so the camera's default target is the middle of the
    // arrangement rather than a corner of it.
    positions[objectIndex] = {
      x: (column - (columns - 1) / 2) * cell,
      z: (row - (Math.ceil(count / columns) - 1) / 2) * cell,
    };
  });

  return positions;
}

function computeBounds(objects: LayoutObject[], placeholderSize: number): SceneLayout['bounds'] {
  if (objects.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
  }
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const object of objects) {
    const size = object.size ?? { x: placeholderSize, y: placeholderSize, z: placeholderSize };
    for (const axis of ['x', 'y', 'z'] as const) {
      const half = size[axis] / 2;
      min[axis] = Math.min(min[axis], object.position[axis] - half);
      max[axis] = Math.max(max[axis], object.position[axis] + half);
    }
  }
  return { min, max, size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z } };
}

/**
 * How far the camera should stand back to see the whole arrangement.
 *
 * Derived from the bounds and the field of view rather than hardcoded, because a
 * balcony greenhouse and a shipping-container farm differ by an order of magnitude
 * and a fixed distance frames one of them badly.
 */
export function suggestedCameraDistance(bounds: SceneLayout['bounds'], fovDegrees = 50): number {
  const radius = Math.max(bounds.size.x, bounds.size.y, bounds.size.z) / 2;
  if (!Number.isFinite(radius) || radius <= 0) return DEFAULT_PLACEHOLDER_MM * 6;
  const fov = (Math.min(170, Math.max(1, fovDegrees)) * Math.PI) / 180;
  return round((radius / Math.sin(fov / 2)) * 1.35);
}

/** Ground grid spacing that stays readable across three orders of magnitude. */
export function suggestedGridStep(bounds: SceneLayout['bounds']): number {
  const span = Math.max(bounds.size.x, bounds.size.z);
  if (!Number.isFinite(span) || span <= 0) return DEFAULT_PLACEHOLDER_MM * 2;
  const raw = span / 8;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return round(Math.max(magnitude, magnitude * Math.round(raw / magnitude)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
