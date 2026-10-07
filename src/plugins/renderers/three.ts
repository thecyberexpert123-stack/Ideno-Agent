/**
 * Three.js renderer for the canonical representation.
 *
 * This is the plugin the extension point was built for, and the reason that point
 * exists is visible in what this file is *not* allowed to do. It receives a
 * `CanonicalScene` — objects, dimensions, connections, constraints — and never a
 * sentence. There is no path by which natural language reaches a renderer here, so
 * there is no path by which a model's prose decides what geometry exists.
 *
 *     Idea State → CanonicalScene → SceneLayout → Three.js
 *
 * The layout step is shared with any future renderer, so a 3D view and an SVG
 * diagram of the same idea cannot disagree about where anything is.
 *
 * Three.js is imported dynamically. It is roughly 300 KB gzipped, and a person who
 * never opens the 3D view should never download it — the same reasoning that keeps
 * the Puter SDK out of the main chunk. Only *types* are imported statically, which
 * costs nothing at runtime.
 */
import type * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { CanonicalScene } from '../../render/canonical.js';
import {
  projectLayout,
  suggestedCameraDistance,
  suggestedGridStep,
  type LayoutObject,
  type SceneLayout,
} from '../../render/layout.js';
import type { CanonicalRenderer, IdenoPlugin, RendererHandle } from '../registry.js';

export const THREE_RENDERER_ID = 'three-canonical';

export type ThreeModule = typeof THREE;
export type ControlsModule = { OrbitControls: new (camera: THREE.Camera, dom: HTMLElement) => OrbitControls };

/**
 * Colour per connection kind.
 *
 * Fixed here rather than derived, because the point is that a reader learns it once:
 * fluid is blue, electrical amber, data violet, mechanical grey, thermal red. The
 * same mapping is used by the connection list in the Spec panel, so the two views
 * cannot disagree about what a line means.
 */
export const LINK_COLORS: Record<string, number> = {
  fluid: 0x2b6ca3,
  electrical: 0x8a5a00,
  data: 0x7a4bbd,
  mechanical: 0x6b6b78,
  thermal: 0xb3261e,
  other: 0x8b8b96,
};

/** Objects whose geometry is fully specified are solid; anything less is not. */
export const SOLID_COLOR = 0xc9ccd6;
export const PARTIAL_COLOR = 0x9aa3c7;
export const PLACEHOLDER_COLOR = 0xb3261e;
const GROUND_COLOR = 0xd8dae2;
const BACKGROUND_COLOR = 0xf7f7f8;

export interface ThreeRenderOptions {
  /** Injected for tests; defaults to a dynamic import of `three`. */
  loadThree?: () => Promise<ThreeModule>;
  /** Injected for tests; defaults to a dynamic import of OrbitControls. */
  loadControls?: () => Promise<ControlsModule>;
}

/**
 * Creates the renderer plugin.
 *
 * A factory rather than a constant so the module loaders can be injected: without
 * that seam there is no way to test any of this in an environment with no WebGL,
 * which is every CI environment including this one.
 */
export const THREE_PLUGIN_ID = 'ideno-three-renderer';
export const THREE_PLUGIN_VERSION = '0.2.0';

/**
 * The plugin that contributes the 3D renderer.
 *
 * Registering it costs nothing: Three.js is only imported when `render` is actually
 * called, so a user who never opens the 3D view never downloads it. That is the same
 * reasoning that keeps the Puter SDK out of the main chunk, and it is why this is a
 * plugin at all rather than a component the Spec panel imports directly.
 */
export function createThreePlugin(options: ThreeRenderOptions = {}): IdenoPlugin {
  return {
    id: THREE_PLUGIN_ID,
    name: '3D renderer',
    version: THREE_PLUGIN_VERSION,
    capabilities: ['render3d'],
    activate(context) {
      context.registerRenderer(createThreeRenderer(options));
    },
  };
}

export function createThreeRenderer(options: ThreeRenderOptions = {}): CanonicalRenderer {
  const loadThree = options.loadThree ?? ((): Promise<ThreeModule> => import('three'));
  const loadControls =
    options.loadControls ?? ((): Promise<ControlsModule> => import('three/addons/controls/OrbitControls.js'));

  return {
    id: THREE_RENDERER_ID,
    label: '3D (Three.js)',
    render(scene: CanonicalScene, mount: HTMLElement): RendererHandle {
      // `render` is synchronous and loading Three.js is not, so the session owns both
      // the pending work and the teardown. Disposing before the imports resolve must
      // not leave a canvas behind.
      const session = new RenderSession(mount, loadThree, loadControls);
      void session.start(scene);
      return {
        update(next: CanonicalScene) {
          session.update(next);
        },
        dispose() {
          session.dispose();
        },
      };
    },
  };
}

/**
 * One mounted 3D view.
 *
 * Holds every disposable object, because a renderer that leaks a WebGL context per
 * re-render will exhaust the browser's context limit in a handful of idea switches —
 * and that failure presents as a blank canvas with no error, which is the worst kind.
 */
class RenderSession {
  #mount: HTMLElement;
  #loadThree: () => Promise<ThreeModule>;
  #loadControls: () => Promise<ControlsModule>;

  #disposed = false;
  #three: ThreeModule | null = null;
  #renderer: THREE.WebGLRenderer | null = null;
  #scene: THREE.Scene | null = null;
  #camera: THREE.PerspectiveCamera | null = null;
  #controls: OrbitControls | null = null;
  /** Everything drawn from the layout, so it can be replaced wholesale on update. */
  #content: THREE.Group | null = null;
  #frame = 0;
  #resizeObserver: ResizeObserver | null = null;
  #notesReported = new Set<string>();

  constructor(mount: HTMLElement, loadThree: () => Promise<ThreeModule>, loadControls: () => Promise<ControlsModule>) {
    this.#mount = mount;
    this.#loadThree = loadThree;
    this.#loadControls = loadControls;
  }

  async start(scene: CanonicalScene): Promise<void> {
    let three: ThreeModule;
    try {
      three = await this.#loadThree();
    } catch (error) {
      this.#fail(`Three.js could not be loaded: ${describe(error)}`);
      return;
    }
    if (this.#disposed) return;

    if (!webglAvailable()) {
      this.#fail(
        'This browser or web engine did not provide WebGL, so the 3D view cannot be drawn. ' +
          'The dimensions and connections listed here are the same data the 3D view uses.',
      );
      return;
    }

    this.#three = three;
    const layout = projectLayout(scene);

    try {
      this.#build(three, layout);
    } catch (error) {
      this.#fail(`The 3D view could not be built: ${describe(error)}`);
      return;
    }

    // OrbitControls is a separate addon import, and optional: a view you cannot
    // rotate is much less useful, but a view that does not load at all is worse.
    try {
      const controls = await this.#loadControls();
      if (!this.#disposed && this.#camera && this.#renderer && controls?.OrbitControls) {
        const instance = new controls.OrbitControls(this.#camera, this.#renderer.domElement);
        instance.enableDamping = true;
        instance.target.set(0, layout.bounds.size.y / 2, 0);
        instance.update();
        this.#controls = instance;
      }
    } catch (error) {
      this.#note(`Orbit controls could not be loaded, so the view cannot be rotated (${describe(error)}).`);
    }

    if (this.#disposed) {
      this.#teardown();
      return;
    }
    for (const note of layout.notes) this.#note(note);
    if (layout.objects.length === 0) {
      this.#note('Nothing to draw: the selected alternative specifies no components.');
    }
    this.#startFrameLoop();
    this.#observeResize();
  }

  /** Re-renders with a newer scene without tearing the view down. */
  update(scene: CanonicalScene): void {
    if (this.#disposed || !this.#three || !this.#scene) return;
    const layout = projectLayout(scene);
    try {
      this.#replaceContent(layout);
      this.#frameCamera(layout);
      for (const note of layout.notes) this.#note(note);
    } catch (error) {
      this.#note(`The 3D view could not be updated: ${describe(error)}`);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#teardown();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  #build(three: ThreeModule, layout: SceneLayout): void {
    const width = this.#width();
    const height = this.#height();

    const renderer = new three.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);
    renderer.domElement.setAttribute('aria-label', 'Three-dimensional view of the selected alternative');
    renderer.domElement.className = 'viewer-canvas';
    this.#mount.appendChild(renderer.domElement);
    this.#renderer = renderer;

    const scene = new three.Scene();
    scene.background = new three.Color(BACKGROUND_COLOR);
    this.#scene = scene;

    const camera = new three.PerspectiveCamera(50, Math.max(0.1, width / Math.max(1, height)), 1, 200_000);
    this.#camera = camera;

    // Two lights rather than one: a single directional light leaves the far side of
    // every object black, which reads as a hole in the geometry.
    scene.add(new three.AmbientLight(0xffffff, 0.7));
    const key = new three.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new three.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1.5, 0.8, -1);
    scene.add(fill);

    this.#replaceContent(layout);
    this.#frameCamera(layout);
  }

  /**
   * Replaces everything derived from the layout.
   *
   * Rebuilt rather than patched: matching old meshes to new ones across a projection
   * that mints ids per call would eventually show geometry from a previous
   * alternative, and "wrong but plausible" is the failure mode this whole product is
   * built to avoid.
   */
  #replaceContent(layout: SceneLayout): void {
    const three = this.#three;
    const scene = this.#scene;
    if (!three || !scene) return;

    if (this.#content) {
      scene.remove(this.#content);
      disposeGroup(this.#content);
      this.#content = null;
    }

    const group = new three.Group();
    group.add(this.#buildGround(three, layout));
    for (const object of layout.objects) group.add(this.#buildObject(three, object));
    group.add(this.#buildLinks(three, layout));
    scene.add(group);
    this.#content = group;
  }

  #buildGround(three: ThreeModule, layout: SceneLayout): THREE.Object3D {
    const step = suggestedGridStep(layout.bounds);
    const span = Math.max(layout.bounds.size.x, layout.bounds.size.z, step * 2);
    const divisions = Math.max(2, Math.min(64, Math.round(span / step)));
    const grid = new three.GridHelper(span, divisions, GROUND_COLOR, GROUND_COLOR);
    // A grid is a reference, not an object: drawing it at full opacity makes the
    // components harder to see than they need to be.
    const material = grid.material as THREE.Material | THREE.Material[];
    for (const entry of Array.isArray(material) ? material : [material]) {
      entry.transparent = true;
      entry.opacity = 0.45;
    }
    return grid;
  }

  /**
   * One mesh per object, sized from the layout and coloured by how completely its
   * geometry was specified.
   *
   * A component with no readable dimension becomes a small wireframe box rather than
   * a solid one of a guessed size: the difference between "this is 400 mm wide" and
   * "Ideno does not know how wide this is" has to be visible without reading a note.
   */
  #buildObject(three: ThreeModule, object: LayoutObject): THREE.Object3D {
    const size = object.size;
    const color = colorForObject(object);

    if (!size) {
      const geometry = new three.BoxGeometry(1, 1, 1);
      geometry.scale(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
      const mesh = new three.Mesh(
        geometry,
        new three.MeshStandardMaterial({ color: PLACEHOLDER_COLOR, wireframe: true }),
      );
      mesh.position.set(0, PLACEHOLDER_SIZE / 2, 0);
      return withIdentity(mesh, object);
    }

    const material = new three.MeshStandardMaterial({
      color,
      roughness: 0.72,
      metalness: 0.05,
      // An axis Ideno filled in is drawn see-through, so a partly specified object
      // never looks as settled as a fully specified one.
      transparent: object.missing_axes.length > 0,
      opacity: object.missing_axes.length > 0 ? 0.62 : 1,
    });

    const radius = object.radius ?? Math.min(size.x, size.z) / 2;
    let mesh: THREE.Mesh;
    switch (object.type) {
      case 'cylinder':
      case 'tube':
        // A tube is drawn as a solid cylinder: the canonical scene records its
        // outside, and inventing a wall thickness nobody stated would be a guess.
        mesh = new three.Mesh(new three.CylinderGeometry(radius, radius, size.y, 32), material);
        break;
      case 'sphere':
        mesh = new three.Mesh(new three.SphereGeometry(Math.max(radius, size.y / 2), 32, 24), material);
        break;
      case 'assembly':
      case 'custom':
        // An assembly's contents are its own objects, and a custom type has no defined
        // shape. Both are drawn as a bounding wireframe: honest about the fact that
        // the volume is known and the form is not.
        mesh = new three.Mesh(
          new three.BoxGeometry(size.x, size.y, size.z),
          new three.MeshStandardMaterial({ color, wireframe: true }),
        );
        break;
      case 'box':
      default:
        mesh = new three.Mesh(new three.BoxGeometry(size.x, size.y, size.z), material);
        break;
    }
    return withIdentity(mesh, object);
  }

  /**
   * One line per connection, coloured by kind.
   *
   * Lines rather than pipes: a pipe has a diameter, and no diameter was ever stated.
   * Drawing one would put a number in front of the user that exists nowhere in the
   * idea.
   */
  #buildLinks(three: ThreeModule, layout: SceneLayout): THREE.Object3D {
    const group = new three.Group();
    for (const link of layout.links) {
      const geometry = new three.BufferGeometry().setFromPoints([
        new three.Vector3(link.from_position.x, link.from_position.y, link.from_position.z),
        new three.Vector3(link.to_position.x, link.to_position.y, link.to_position.z),
      ]);
      const line = new three.Line(
        geometry,
        new three.LineBasicMaterial({ color: colorForLink(link.kind), linewidth: 2 }),
      );
      line.name = link.id;
      line.userData = { kind: link.kind, label: link.label, from: link.from, to: link.to };
      group.add(line);
    }
    return group;
  }

  /** Positions the camera from the layout's own bounds. */
  #frameCamera(layout: SceneLayout): void {
    const distance = suggestedCameraDistance(layout.bounds);
    this.#camera?.position.set(distance * 0.85, distance * 0.7, distance * 0.95);
    this.#camera?.lookAt(0, layout.bounds.size.y / 2, 0);
    this.#controls?.target.set(0, layout.bounds.size.y / 2, 0);
    this.#controls?.update();
  }

  // -------------------------------------------------------------------------
  // Lifetime
  // -------------------------------------------------------------------------

  #startFrameLoop(): void {
    const tick = (): void => {
      if (this.#disposed || !this.#renderer || !this.#scene || !this.#camera) return;
      this.#frame = requestAnimationFrame(tick);
      this.#controls?.update();
      this.#renderer.render(this.#scene, this.#camera);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  #observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#disposed || !this.#renderer || !this.#camera) return;
      const width = this.#width();
      const height = this.#height();
      this.#renderer.setSize(width, height);
      this.#camera.aspect = Math.max(0.1, width / Math.max(1, height));
      this.#camera.updateProjectionMatrix();
    });
    this.#resizeObserver.observe(this.#mount);
  }

  #teardown(): void {
    if (this.#frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#controls?.dispose();
    this.#controls = null;
    if (this.#scene) {
      disposeGroup(this.#scene);
      this.#scene.clear();
    }
    this.#content = null;
    this.#scene = null;
    this.#camera = null;
    this.#renderer?.dispose();
    this.#renderer = null;
    this.#three = null;
    while (this.#mount.firstChild) this.#mount.removeChild(this.#mount.firstChild);
  }

  #width(): number {
    return Math.max(160, this.#mount.clientWidth || DEFAULT_VIEW_WIDTH);
  }

  #height(): number {
    return Math.max(120, this.#mount.clientHeight || DEFAULT_VIEW_HEIGHT);
  }

  /** Renders a failure inside the mount, replacing whatever was there. */
  #fail(message: string): void {
    if (this.#disposed) return;
    this.#teardown();
    const panel = document.createElement('div');
    panel.className = 'viewer-fallback';
    const text = document.createElement('p');
    text.className = 'hint';
    text.textContent = message;
    panel.appendChild(text);
    this.#mount.appendChild(panel);
  }

  /** Appends a note under the view, once each. Text only; never markup. */
  #note(message: string): void {
    if (this.#disposed || this.#notesReported.has(message)) return;
    this.#notesReported.add(message);
    let list = this.#mount.querySelector('.viewer-notes');
    if (!list) {
      list = document.createElement('ul');
      list.className = 'viewer-notes note-list';
      this.#mount.appendChild(list);
    }
    const item = document.createElement('li');
    item.textContent = message;
    list.appendChild(item);
  }
}

const PLACEHOLDER_SIZE = 40;
const DEFAULT_VIEW_WIDTH = 480;
const DEFAULT_VIEW_HEIGHT = 320;

/** Attaches the Idea State identity a viewer needs to explain what it is showing. */
function withIdentity(mesh: THREE.Mesh, object: LayoutObject): THREE.Mesh {
  mesh.name = object.id;
  mesh.position.set(object.position.x, object.position.y, object.position.z);
  mesh.userData = {
    object_id: object.id,
    name: object.name,
    type: object.type,
    material: object.material,
    placeholder: object.placeholder,
    missing_axes: [...object.missing_axes],
  };
  return mesh;
}

/** Frees every geometry and material below a node. */
function disposeGroup(root: { traverse: (callback: (node: unknown) => void) => void }): void {
  root.traverse((node) => {
    const candidate = node as {
      geometry?: { dispose?: () => void };
      material?: { dispose?: () => void } | { dispose?: () => void }[];
    };
    candidate.geometry?.dispose?.();
    const material = candidate.material;
    if (Array.isArray(material)) for (const entry of material) entry?.dispose?.();
    else material?.dispose?.();
  });
}

/**
 * Whether a WebGL context can be created at all.
 *
 * Checked before constructing a renderer, because the alternative is an exception
 * from deep inside Three.js. jsdom has no WebGL, which makes the failure path the
 * *tested* path rather than the hopeful one.
 */
export function webglAvailable(factory?: () => HTMLCanvasElement | null): boolean {
  try {
    const canvas = factory
      ? factory()
      : typeof document === 'undefined'
        ? null
        : document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    const probe =
      canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    return probe !== null && probe !== undefined;
  } catch {
    return false;
  }
}

/** Colour for an object, given how completely its geometry was specified. */
export function colorForObject(object: { placeholder: boolean; missing_axes: unknown[] }): number {
  if (object.placeholder) return PLACEHOLDER_COLOR;
  if (object.missing_axes.length > 0) return PARTIAL_COLOR;
  return SOLID_COLOR;
}

export function colorForLink(kind: string): number {
  return LINK_COLORS[kind] ?? LINK_COLORS.other!;
}

/**
 * A readable summary of a layout.
 *
 * Used for the fallback shown when 3D is unavailable, and by tests that have no GPU
 * to assert against. Same data, different surface — which is the point of keeping
 * the layout separate from the renderer.
 */
export function describeLayout(layout: SceneLayout): string[] {
  return layout.objects.map((object) => {
    const size = object.size
      ? `${round(object.size.x)} × ${round(object.size.y)} × ${round(object.size.z)} mm`
      : 'no dimensions given';
    const flags = [
      object.placeholder ? 'placeholder' : null,
      object.missing_axes.length > 0 ? `missing ${object.missing_axes.join('/')}` : null,
    ].filter((flag): flag is string => flag !== null);
    return `${object.name} (${object.type}): ${size}${flags.length > 0 ? ` — ${flags.join(', ')}` : ''}`;
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'unknown error';
}
