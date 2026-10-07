/**
 * The canonical representation view.
 *
 * What has to exist before any renderer is the renderer-independent description,
 * because that is the contract every renderer (Three.js, OpenSCAD, an SVG diagram, a
 * CAD exporter) consumes. Showing the projection makes the contract inspectable and
 * makes the failure modes visible — an unparsed dimension or a connection to a
 * nonexistent object is listed, never papered over.
 *
 * The 3D view is offered *alongside* the projection rather than instead of it, and
 * the JSON stays on screen while it is open. A drawing is a claim about the idea; the
 * canonical scene is the claim it was drawn from, and being able to see both at once
 * is what makes the drawing checkable.
 */
import type { IdeaCase } from '../../core/schemas/index.js';
import { projectCanonicalScene } from '../../render/canonical.js';
import { CAPABILITY_LABELS } from '../../plugins/registry.js';
import type { PluginRecord } from '../../plugins/registry.js';
import { analyzeEvidenceGap } from '../../research/evidence.js';
import { bodyOf } from '../../core/idea_state/create.js';
import { button, el, type Child } from '../dom.js';

export interface SpecViewer {
  /** Whether the 3D view is switched on. */
  enabled: boolean;
  /**
   * The element the renderer draws into, owned by the application rather than by this
   * component.
   *
   * Panels here are re-rendered wholesale, and a WebGL context cannot survive being
   * thrown away and rebuilt on every state change — browsers cap the number of live
   * contexts, and the failure presents as a blank canvas with no error. So the mount
   * is created once by the app and *moved* into the panel on each render, which keeps
   * the canvas and its context alive.
   */
  mount: HTMLElement | null;
  /** A renderer is available to draw with. */
  available: boolean;
  onToggle(): void;
}

export function renderSpec(idea: IdeaCase | null, plugins: PluginRecord[], viewer?: SpecViewer): HTMLElement {
  if (!idea) {
    return el('div', { class: 'empty-line', text: 'Nothing to project yet.' });
  }

  const projection = projectCanonicalScene(idea);
  const gap = analyzeEvidenceGap(bodyOf(idea));
  const hasGeometry = projection.scene.objects.length > 0;

  return el(
    'div',
    null,
    el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'section-head' },
        el('span', { text: 'Canonical representation' }),
        el('span', {
          class: 'section-count',
          text: `${projection.scene.objects.length} objects · ${projection.scene.connections.length} connections · ${projection.scene.constraints.length} constraints`,
        }),
      ),
      el(
        'div',
        { class: 'section-body' },
        el(
          'div',
          { class: 'goal-text' },
          projection.scene.alternative_name
            ? `Projected from the selected alternative: ${projection.scene.alternative_name}. Units are normalised to millimetres.`
            : 'No alternative is selected, so there is no geometry to project. The constraints below hold for every option.',
        ),
        projection.notes.length > 0
          ? el(
              'div',
              { class: 'goal-text' },
              el('strong', { text: 'Could not be projected:' }),
              el('ul', { class: 'note-list' }, projection.notes.map((note) => el('li', null, note))),
            )
          : null,
        viewer ? renderViewerSection(viewer, hasGeometry) : null,
        el('pre', { class: 'code', text: JSON.stringify(projection.scene, null, 2) }),
      ),
    ),
    el(
      'section',
      { class: 'section' },
      el('div', { class: 'section-head' }, el('span', { text: 'Extension points' })),
      el(
        'div',
        { class: 'section-body' },
        plugins.length === 0
          ? el(
              'div',
              { class: 'empty-line' },
              `No plugins registered. Ideno exposes hooks for ${Object.values(CAPABILITY_LABELS)
                .join(', ')
                .toLowerCase()}. A renderer registered here consumes the canonical scene above — it never receives free-form instructions.`,
            )
          : null,
        plugins.map((plugin): Child =>
          el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'item-main' },
              el('span', { class: 'item-text', text: `${plugin.name} ${plugin.version}` }),
              el('span', {
                class: plugin.status === 'failed' ? 'chip chip-severity-critical' : 'chip',
                text: plugin.status,
              }),
            ),
            el(
              'div',
              { class: 'item-meta' },
              plugin.capabilities.map((capability) =>
                el('span', { class: 'chip', text: CAPABILITY_LABELS[capability] }),
              ),
            ),
            plugin.error ? el('div', { class: 'review-note', text: plugin.error }) : null,
          ),
        ),
      ),
    ),
    el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'section-head' },
        el('span', { text: 'What this idea rests on' }),
        el('span', {
          class: 'section-count',
          text: `${gap.evidence_count} evidenced · ${gap.unsupported.length} unevidenced · ${gap.open_research.length} open questions`,
        }),
      ),
      el(
        'div',
        { class: 'section-body' },
        gap.unsupported.length === 0
          ? el('div', { class: 'empty-line', text: 'Every recorded assertion is grounded in your words or in evidence.' })
          : null,
        gap.unsupported.slice(0, 12).map((claim): Child =>
          el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'item-main' },
              el('span', { class: `prov prov-${claim.provenance}`, text: claim.provenance.replace(/_/g, ' ') }),
              el('span', { class: 'item-text', text: claim.label }),
            ),
          ),
        ),
        gap.unsupported.length > 12
          ? el('div', { class: 'empty-line', text: `…and ${gap.unsupported.length - 12} more.` })
          : null,
      ),
    ),
  );
}

/**
 * The 3D view: a toggle, the app-owned mount, and the reason it is unavailable when
 * it is.
 *
 * The toggle is disabled rather than hidden when there is nothing to draw or no
 * renderer registered, and the reason is stated. A control that silently does
 * nothing teaches the user that the interface lies.
 */
function renderViewerSection(viewer: SpecViewer, hasGeometry: boolean): HTMLElement {
  const reason = !viewer.available
    ? 'No 3D renderer is registered.'
    : !hasGeometry
      ? 'There is no geometry to draw: select an alternative whose components have dimensions.'
      : null;

  const section = el(
    'div',
    { class: 'viewer' },
    el(
      'div',
      { class: 'viewer-bar' },
      button(viewer.enabled ? 'Hide 3D view' : 'Show 3D view', {
        class: 'btn-sm',
        disabled: reason !== null,
        title:
          reason ??
          'Drawn from the canonical representation above — objects, dimensions and connections. ' +
            'Nothing about this view comes from prose.',
        onClick: () => viewer.onToggle(),
      }),
      el('span', {
        class: 'field-hint',
        text: reason ?? 'Three.js, loaded only when this view is opened.',
      }),
    ),
  );

  if (viewer.enabled && viewer.mount) {
    // Appending an element that is already in the document moves it, which is what
    // keeps the canvas and its WebGL context alive across re-renders.
    section.appendChild(viewer.mount);
  }
  return section;
}
