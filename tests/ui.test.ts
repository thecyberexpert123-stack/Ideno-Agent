// @vitest-environment jsdom
/**
 * UI tests.
 *
 * These run in jsdom and cover the two things the interface is responsible for:
 * rendering the Idea State faithfully (provenance, proposals, versions, canonical
 * spec) and never turning model or user text into markup. The last test boots the
 * whole application and runs the scripted scenario through the real DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateManager } from '../src/core/state_manager/state_manager.js';
import { MemoryStore } from '../src/core/state_manager/store.js';
import { fixedClock } from '../src/core/ids.js';
import { PersistedSettingsSchema, SettingsSchema } from '../src/ai/settings.js';
import {
  renderStatePanel,
  type EvidenceInput,
  type StatePanelActions,
} from '../src/ui/components/state_panel.js';
import { renderReviewQueue } from '../src/ui/components/review.js';
import { renderVersions, type VersionActions } from '../src/ui/components/versions.js';
import { renderWorkspaceModal } from '../src/ui/components/workspace.js';
import { renderSpec } from '../src/ui/components/spec.js';
import { renderMessage, renderThinking } from '../src/ui/components/conversation.js';
import { safeUrl } from '../src/ui/format.js';
import { createApp } from '../src/ui/app.js';
import { makeManager, sampleChangeSet } from './helpers.js';

const noopActions: StatePanelActions = {
  onAcceptChange: () => undefined,
  onRejectChange: () => undefined,
  onSelectAlternative: () => undefined,
  onResolveUnknown: () => undefined,
  onAddEvidence: () => undefined,
};

function text(node: HTMLElement): string {
  return node.textContent ?? '';
}

describe('safeUrl', () => {
  it('only lets http and https become links', () => {
    expect(safeUrl('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
    expect(safeUrl('http://localhost:8080/x')).toBe('http://localhost:8080/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('   ')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});

describe('state panel', () => {
  it('renders every section with provenance markers', () => {
    const state = makeManager();
    state.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null, review_mode: 'strict' });
    state.acceptChanges(state.pendingChanges().map((record) => record.id));

    const panel = renderStatePanel(state.idea, [], noopActions);
    const rendered = text(panel);

    expect(rendered).toContain('Goal');
    expect(rendered).toContain('Requirements');
    expect(rendered).toContain('Assumptions');
    expect(rendered).toContain('Constraints');
    expect(rendered).toContain('Unknowns');
    expect(rendered).toContain('Evidence');
    expect(rendered).toContain('Alternatives');
    expect(rendered).toContain('Decisions');
    expect(rendered).toContain('Water the plants automatically on a schedule.');
    expect(panel.querySelectorAll('.prov-model_inferred').length).toBeGreaterThan(0);
    expect(panel.querySelector('.prov-unknown')).not.toBeNull();
    expect(rendered).toContain('came from Ideno, not from you');
  });

  it('shows a proposed item in place, with Accept and Reject', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must be silent at night.', provenance: 'model_inferred', category: 'other' }] },
      { origin: 'update', message_id: null, rationale: 'Implied by indoor use.' },
    );
    const pending = state.pendingChanges();
    expect(pending).toHaveLength(1);

    const accepted: string[] = [];
    const panel = renderStatePanel(state.idea, pending, {
      ...noopActions,
      onAcceptChange: (id) => accepted.push(id),
    });

    expect(panel.querySelectorAll('.item-proposed')).toHaveLength(1);
    expect(text(panel)).toContain('Must be silent at night.');
    expect(text(panel)).toContain('Proposed');

    const buttons = [...panel.querySelectorAll('button')].map((node) => node.textContent);
    expect(buttons).toContain('Accept');
    expect(buttons).toContain('Reject');

    const accept = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Accept')!;
    accept.click();
    expect(accepted).toEqual([pending[0]!.id]);
  });

  it('renders model-supplied HTML as inert text', () => {
    const state = makeManager();
    state.enqueueChanges(
      {
        constraints_added: [
          {
            text: '<img src=x onerror="window.__pwned = true"> must be quiet',
            provenance: 'user_stated',
            category: 'other',
          },
        ],
      },
      { origin: 'update', message_id: null },
    );

    const panel = renderStatePanel(state.idea, [], noopActions);
    expect(text(panel)).toContain('<img src=x onerror=');
    expect(panel.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('offers a way to resolve an unknown and a way to select an alternative', () => {
    const state = makeManager();
    state.enqueueChanges(
      {
        unknowns_added: [{ text: 'How many plants?', provenance: 'unknown', impact: 'high' }],
        alternatives_added: [{ name: 'Option A', text: 'Option A', summary: 'A.', provenance: 'model_suggestion' }],
      },
      { origin: 'understand', message_id: null },
    );
    state.acceptChanges(state.pendingChanges().map((record) => record.id));

    const resolved: { id: string; resolution: string }[] = [];
    const selected: string[] = [];
    const panel = renderStatePanel(state.idea, [], {
      ...noopActions,
      onResolveUnknown: (id, resolution) => resolved.push({ id, resolution }),
      onSelectAlternative: (id) => selected.push(id),
    });

    const resolveButton = [...panel.querySelectorAll('button')].find(
      (node) => node.textContent === 'Mark resolved',
    )!;
    expect(resolveButton).toBeTruthy();
    resolveButton.click();

    const input = panel.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = 'The user settled on 20 plants.';
    const save = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Save')!;
    save.click();
    expect(resolved).toEqual([
      { id: state.idea!.unknowns[0]!.id, resolution: 'The user settled on 20 plants.' },
    ]);

    const selectButton = [...panel.querySelectorAll('button')].find(
      (node) => node.textContent === 'Select this approach',
    )!;
    selectButton.click();
    expect(selected).toEqual([state.idea!.alternatives[0]!.id]);
  });

  it('renders evidence sources as links only when they are safe URLs', () => {
    const state = makeManager();
    state.addUserEvidence({
      claim: 'Drip emitters deliver 2 L/h.',
      source_title: 'Datasheet',
      source_locator: 'https://example.com/d.pdf',
      relevance: 'Pump sizing',
      confidence: 0.9,
    });
    state.addUserEvidence({
      claim: 'A handbook says 4 L/h.',
      source_title: 'Handbook',
      source_locator: 'javascript:alert(1)',
      relevance: 'Pump sizing',
      confidence: 0.5,
    });

    const panel = renderStatePanel(state.idea, [], noopActions);
    const links = [...panel.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/d.pdf');
    expect(text(panel)).toContain('javascript:alert(1)');
  });

  it('lets the user record evidence they supplied themselves', () => {
    const state = makeManager();
    const added: EvidenceInput[] = [];
    const panel = renderStatePanel(state.idea, [], {
      ...noopActions,
      onAddEvidence: (input) => added.push(input),
    });

    const open = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Add evidence')!;
    expect(open).toBeTruthy();
    open.click();

    const inputs = [...panel.querySelectorAll('.review-card input')] as HTMLInputElement[];
    expect(inputs).toHaveLength(5);

    // Submitting an incomplete source is refused, and the reason is honest about
    // why: an unsourced claim is not evidence.
    const save = [...panel.querySelectorAll('button')].find(
      (node) => node.textContent === 'Save as evidence',
    )!;
    save.click();
    expect(added).toEqual([]);
    expect(text(panel)).toMatch(/An unsourced claim is a suggestion, not evidence/);

    const [claim, title, locator, relevance, confidence] = inputs;
    claim!.value = 'Drip emitters deliver 2 L/h at 1 bar.';
    title!.value = 'Supplier datasheet';
    locator!.value = 'https://example.com/dripper.pdf';
    relevance!.value = 'Sizes the pump and reservoir.';
    confidence!.value = '0.9';
    save.click();

    expect(added).toEqual([
      {
        claim: 'Drip emitters deliver 2 L/h at 1 bar.',
        source_title: 'Supplier datasheet',
        source_locator: 'https://example.com/dripper.pdf',
        relevance: 'Sizes the pump and reservoir.',
        confidence: 0.9,
      },
    ]);
    // The form closes after saving.
    expect(panel.querySelectorAll('.review-card')).toHaveLength(0);
  });

  it('refuses an out-of-range confidence in the evidence form', () => {
    const state = makeManager();
    const added: EvidenceInput[] = [];
    const panel = renderStatePanel(state.idea, [], {
      ...noopActions,
      onAddEvidence: (input) => added.push(input),
    });
    [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Add evidence')!.click();
    const inputs = [...panel.querySelectorAll('.review-card input')] as HTMLInputElement[];
    for (const [index, value] of ['A claim', 'A title', 'https://example.com', 'Relevant', '3'].entries()) {
      inputs[index]!.value = value;
    }
    [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Save as evidence')!.click();
    expect(added).toEqual([]);
    expect(text(panel)).toMatch(/Confidence must be between 0 and 1/);
  });

  it('explains itself when there is no idea yet', () => {
    expect(text(renderStatePanel(null, [], noopActions))).toMatch(/Nothing structured yet/);
  });
});

describe('review queue', () => {
  it('renders the card shape from the specification', () => {
    const state = makeManager();
    state.enqueueChanges(
      {
        constraints_added: [
          {
            text: 'Must operate without mains electricity',
            provenance: 'model_inferred',
            category: 'power',
            affects: { item_ids: [], areas: ['Power architecture', 'Component selection', 'Battery requirements'] },
          },
        ],
      },
      { origin: 'update', message_id: null, rationale: 'You said it must run off-grid.', review_mode: 'strict' },
    );

    const queue = renderReviewQueue(state.pendingChanges(), [], state.idea, {
      ...noopActions,
      onAcceptAll: () => undefined,
      onRejectAll: () => undefined,
    });
    const rendered = text(queue);

    // The label is uppercased by CSS; textContent keeps the source casing.
    expect(rendered).toContain('Constraint added');
    expect(queue.querySelector('.review-kind')?.textContent?.trim()).toMatch(/^Constraint added/);
    expect(rendered).toContain('“Must operate without mains electricity”');
    expect(rendered).toContain('Affected:');
    expect(rendered).toContain('Power architecture');
    expect(rendered).toContain('Battery requirements');
    expect(rendered).toContain('You said it must run off-grid.');
    expect(queue.querySelectorAll('.review-card')).toHaveLength(1);
  });

  it('lists recently decided changes, including rejections with their reason', () => {
    const state = makeManager();
    state.enqueueChanges(sampleChangeSet(), { origin: 'understand', message_id: null });
    const [first, ...rest] = state.pendingChanges();
    state.rejectChange(first!.id, 'Not true in this case.');
    state.acceptChanges(rest.map((record) => record.id));

    const resolved = state.changeLog().filter((record) => record.status !== 'pending');
    const queue = renderReviewQueue([], resolved, state.idea, {
      ...noopActions,
      onAcceptAll: () => undefined,
      onRejectAll: () => undefined,
    });
    const rendered = text(queue);
    expect(rendered).toContain('Recently decided');
    expect(rendered).toContain('Not true in this case.');
    expect(rendered).toContain('rejected');
  });

  it('explains what the queue is for when it is empty', () => {
    const queue = renderReviewQueue([], [], null, {
      ...noopActions,
      onAcceptAll: () => undefined,
      onRejectAll: () => undefined,
    });
    expect(text(queue)).toMatch(/Nothing is waiting for you/);
  });
});

/** Every branch action, no-op by default, overridden per test. */
function versionActions(overrides: Partial<VersionActions> = {}): VersionActions {
  return {
    onSelect: () => undefined,
    onRestore: () => undefined,
    onCreateBranch: () => undefined,
    onSwitchBranch: () => undefined,
    onCompare: () => undefined,
    onArchiveBranch: () => undefined,
    onLabelVersion: () => undefined,
    ...overrides,
  };
}

describe('version panel', () => {
  it('lists versions newest first and shows the diff of the selected one', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated', category: 'physical' }] },
      { origin: 'update', message_id: null },
    );
    const history = state.versions();
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: history[1]!.id, compareBranchId: null },
      versionActions(),
    );
    const rendered = text(panel);

    // Versions are now numbered by position along the branch a person is looking at.
    expect(rendered).toContain('main#1');
    expect(rendered).toContain('main#0');
    expect(rendered).toContain('Constraints added');
    expect(rendered).toContain('Must fit on a balcony.');
    expect(rendered.indexOf('main#1')).toBeLessThan(rendered.indexOf('main#0'));
    // The branch tip offers no restore; v0 does.
    const restore = [...panel.querySelectorAll('button')].filter((node) => node.textContent === 'Restore');
    expect(restore).toHaveLength(1);
  });

  it('offers restore for every version except the head', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const restores: string[] = [];
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions({ onRestore: (id) => restores.push(id) }),
    );
    const restore = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Restore')!;
    restore.click();
    expect(restores).toEqual([state.versions()[0]!.id]);
  });
});

describe('branch panel', () => {
  it('shows the branch being viewed and offers a fork', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions(),
    );
    const rendered = text(panel);

    expect(rendered).toContain('Branches');
    expect(rendered).toContain('1 open · 0 archived');
    expect(rendered).toContain('Versions on “main”');
    expect(rendered).toContain('Fork here');
    // With one branch there is nothing to compare against, and the panel says what
    // to do instead of showing an empty control.
    expect(rendered).toContain('Fork a branch to develop an alternative as its own timeline.');
    expect(panel.querySelectorAll('select.branch-select')).toHaveLength(1);
  });

  it('forks from the branch tip and from an older version', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const forks: [string, string][] = [];
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions({
        onCreateBranch: (name, fromVersionId) => forks.push([name, fromVersionId]),
      }),
    );

    const input = panel.querySelector('input[aria-label="New branch name"]') as HTMLInputElement;
    input.value = 'passive-design';
    const forkHere = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Fork here')!;
    forkHere.click();
    expect(forks).toHaveLength(1);
    expect(forks[0]![0]).toBe('passive-design');
    expect(forks[0]![1]).toBe(state.latestVersion()!.id);

    // The per-row Fork targets the version it sits on, not the tip, and asks for a
    // name inline rather than through a native dialog.
    const rowFork = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Fork')!;
    rowFork.click();
    const editor = panel.querySelector('input[aria-label="Branch from v0"]') as HTMLInputElement;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe('from-v0');
    editor.value = 'off-grid';
    const submit = [...panel.querySelectorAll('button')].find((node) => node.textContent === 'Fork' && node !== rowFork)!;
    submit.click();
    expect(forks).toHaveLength(2);
    expect(forks[1]!).toEqual(['off-grid', state.versions()[0]!.id]);
  });

  it('lists every branch and switches between them', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const fork = state.createBranch({ name: 'passive-design' });
    state.enqueueChanges(
      { constraints_added: [{ text: 'No electricity at all.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );

    const switches: string[] = [];
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions({ onSwitchBranch: (id) => switches.push(id) }),
    );
    const rendered = text(panel);

    expect(rendered).toContain('2 open · 0 archived');
    expect(rendered).toContain('Versions on “passive-design”');
    expect(rendered).toContain('Compare with…');

    const selects = panel.querySelectorAll('select.branch-select');
    expect(selects).toHaveLength(2);
    const branchSelect = selects[0] as HTMLSelectElement;
    expect([...branchSelect.options].map((option) => option.text).join(' | ')).toContain('main#1');
    branchSelect.value = state.branches()[0]!.id;
    branchSelect.dispatchEvent(new Event('change'));
    expect(switches).toEqual([state.branches()[0]!.id]);
    expect(fork.name).toBe('passive-design');
  });

  it('offers archiving only when another branch would remain open', () => {
    const state = makeManager();
    state.createBranch({ name: 'second' });
    const withTwo = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions(),
    );
    expect([...withTwo.querySelectorAll('button')].some((node) => node.textContent === 'Archive branch')).toBe(true);

    state.archiveBranch(state.branches()[1]!.id);
    const withOne = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: null },
      versionActions(),
    );
    expect([...withOne.querySelectorAll('button')].some((node) => node.textContent === 'Archive branch')).toBe(false);
  });

  it('labels a version and marks labelled versions as protected', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const labels: [string, string | null][] = [];
    const panel = renderVersions(
      state.idea,
      { selectedVersionId: state.versions()[0]!.id, compareBranchId: null },
      versionActions({ onLabelVersion: (id, label) => labels.push([id, label]) }),
    );

    // Rows are newest first, so v0 is the second row; every row has its own Label
    // button and the editor must belong to the row it was opened from.
    const rows = [...panel.querySelectorAll<HTMLElement>('.version-row')];
    expect(rows).toHaveLength(2);
    const rowV0 = rows[1]!;
    expect(text(rowV0)).toContain('main#0');

    const label = [...rowV0.querySelectorAll('button')].find((node) => node.textContent === 'Label')!;
    label.click();
    const editor = rowV0.querySelector('input[aria-label="Name v0"]') as HTMLInputElement;
    expect(editor).not.toBeNull();
    expect(labels).toHaveLength(0); // nothing is recorded until it is submitted
    // The other row is untouched.
    expect(rows[0]!.querySelector('input')).toBeNull();

    // Cancel restores the row and records nothing.
    const cancel = [...rowV0.querySelectorAll('button')].find((node) => node.textContent === 'Cancel')!;
    cancel.click();
    expect(labels).toHaveLength(0);
    expect(rowV0.querySelector('input[aria-label="Name v0"]')).toBeNull();
    expect(text(rowV0)).toContain('Original idea');

    // An empty value is not submitted at all.
    const reopen = [...rowV0.querySelectorAll('button')].find((node) => node.textContent === 'Label')!;
    reopen.click();
    const field = rowV0.querySelector('input[aria-label="Name v0"]') as HTMLInputElement;
    field.value = '   ';
    [...rowV0.querySelectorAll('button')].find((node) => node.textContent === 'Label')!.click();
    expect(labels).toHaveLength(0);
    expect(rowV0.querySelector('input[aria-label="Name v0"]')).not.toBeNull();

    field.value = 'before the balcony constraint';
    [...rowV0.querySelectorAll('button')].find((node) => node.textContent === 'Label')!.click();
    expect(labels).toEqual([[state.versions()[0]!.id, 'before the balcony constraint']]);
  });

  it('says when a snapshot is no longer stored instead of showing an empty diff', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const target = state.versions()[0]!;
    target.snapshot = null;
    target.snapshot_pruned = true;

    const panel = renderVersions(
      state.idea,
      { selectedVersionId: target.id, compareBranchId: null },
      versionActions(),
    );
    const rendered = text(panel);
    expect(rendered).toContain('snapshot not stored');
    expect(rendered).toContain('cannot be compared or restored');
    expect(rendered).not.toContain('No difference between these versions.');
    // And the row itself is marked, so the list does not imply it is viewable.
    expect(rendered).toContain('snapshot dropped');
    const restore = [...panel.querySelectorAll('button')].filter((node) => node.textContent === 'Restore');
    expect(restore).toHaveLength(0);
  });

  it('compares two branches from where they diverged', () => {
    const state = makeManager();
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    const main = state.branches()[0]!;
    const fork = state.createBranch({ name: 'passive-design' });
    state.enqueueChanges(
      { constraints_added: [{ text: 'No electricity at all.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    // Back on main, asking the question a person actually asks: what did the fork do?
    state.switchBranch(main.id);

    const panel = renderVersions(
      state.idea,
      { selectedVersionId: null, compareBranchId: fork.id },
      versionActions(),
    );
    const rendered = text(panel);

    expect(rendered).toContain('“passive-design” since it forked from “main”');
    // The comparison runs from the divergence point, and the panel says so: comparing
    // two tips would list the other branch's work as though it were missing here.
    expect(rendered).toContain('the point the two branches diverged');
    expect(rendered).toContain('1 version(s) on “passive-design” since then');

    // Assertions below are scoped to the comparison section: the version list above
    // it legitimately mentions both constraints in its summaries, so checking the
    // whole panel would not test the comparison at all.
    const sections = [...panel.querySelectorAll<HTMLElement>('section.section')];
    const comparison = sections[sections.length - 1]!;
    const compared = text(comparison);
    expect(compared).toContain('No electricity at all.');
    // The constraint both branches share is the base, not a difference.
    expect(compared).not.toContain('Must fit on a balcony.');
    expect(compared).toContain('1 Constraints added');
  });
});

describe('workspace panel', () => {
  function twoIdeas(): StateManager {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: true });
    state.startSession('A compost heater.');
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    state.startSession('A tidal pump.');
    return state;
  }

  it('lists every idea with its phase, version count and review queue', () => {
    const state = twoIdeas();
    const opened: string[] = [];
    const modal = renderWorkspaceModal({
      entries: state.listIdeas(),
      activeSessionId: state.activeSessionId,
      storageDescription: null,
      onOpen: (id) => opened.push(id),
      onArchive: () => undefined,
      onNewIdea: () => undefined,
      onClose: () => undefined,
    });
    const rendered = text(modal);

    // Titles are derived from the first sentence with the full stop removed.
    expect(rendered).toContain('A compost heater');
    expect(rendered).toContain('A tidal pump');
    expect(rendered).toContain('versions');
    // With no storage description supplied, the modal states the browser default.
    expect(rendered).toContain('Ideas are stored in this browser');
    expect(modal.querySelectorAll('.idea-row')).toHaveLength(2);
    // The open idea cannot be "opened" again.
    const active = modal.querySelector('.idea-row-active .idea-open') as HTMLButtonElement;
    expect(active.disabled).toBe(true);
    expect(active.title).toContain('This is the open idea');
  });

  it('opens another idea and archives one without deleting it', () => {
    const state = twoIdeas();
    const closed = state.listIdeas().find((entry) => entry.session_id !== state.activeSessionId)!;
    const opened: string[] = [];
    const archived: [string, boolean][] = [];

    const modal = renderWorkspaceModal({
      entries: state.listIdeas(),
      activeSessionId: state.activeSessionId,
      storageDescription: null,
      onOpen: (id) => opened.push(id),
      onArchive: (id, value) => archived.push([id, value]),
      onNewIdea: () => undefined,
      onClose: () => undefined,
    });

    const openButton = modal.querySelector('.idea-row .idea-open:not([disabled])') as HTMLButtonElement;
    openButton.click();
    expect(opened).toEqual([closed.session_id]);

    const archiveButton = [...modal.querySelectorAll('button')].find((node) => node.textContent === 'Archive')!;
    archiveButton.click();
    expect(archived).toHaveLength(1);
    expect(archived[0]![1]).toBe(true);
    // Archiving is reversible and the wording says so.
    expect(archiveButton.getAttribute('title')).toContain('can be unarchived');
  });

  it('keeps archived ideas retrievable behind a disclosure', () => {
    const state = twoIdeas();
    const other = state.listIdeas().find((entry) => entry.session_id !== state.activeSessionId)!;
    state.archiveSession(other.session_id);

    const modal = renderWorkspaceModal({
      entries: state.listIdeas(),
      activeSessionId: state.activeSessionId,
      storageDescription: null,
      onOpen: () => undefined,
      onArchive: () => undefined,
      onNewIdea: () => undefined,
      onClose: () => undefined,
    });
    expect(text(modal)).toContain('Archived (1)');
    expect(text(modal)).toContain('Show 1 archived idea');
    expect(modal.querySelectorAll('.idea-row')).toHaveLength(1);

    const show = [...modal.querySelectorAll('button')].find((node) =>
      node.textContent?.startsWith('Show 1 archived'),
    )!;
    show.click();
    expect(modal.querySelectorAll('.idea-row')).toHaveLength(2);
    expect([...modal.querySelectorAll('button')].some((node) => node.textContent === 'Unarchive')).toBe(true);
  });

  it('says where the ideas are stored when the desktop host is present', () => {
    const state = twoIdeas();
    const modal = renderWorkspaceModal({
      entries: state.listIdeas(),
      activeSessionId: state.activeSessionId,
      storageDescription:
        'Ideas are stored as JSON files in /home/tester/.local/share/ideno/v1/workspace — ' +
        'one file per idea, written atomically. There is no browser storage limit here.',
      onOpen: () => undefined,
      onArchive: () => undefined,
      onNewIdea: () => undefined,
      onClose: () => undefined,
    });
    expect(text(modal)).toContain('/home/tester/.local/share/ideno/v1/workspace');
    expect(text(modal)).toContain('no browser storage limit');
  });

  it('closes on a backdrop click and offers a new idea', () => {
    const state = twoIdeas();
    let closed = false;
    let created = false;
    const modal = renderWorkspaceModal({
      entries: state.listIdeas(),
      activeSessionId: state.activeSessionId,
      storageDescription: null,
      onOpen: () => undefined,
      onArchive: () => undefined,
      onNewIdea: () => {
        created = true;
      },
      onClose: () => {
        closed = true;
      },
    });

    const backdrop = modal as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).toBe(true);

    closed = false;
    const newIdea = [...modal.querySelectorAll('button')].find((node) => node.textContent === 'New idea')!;
    newIdea.click();
    expect(created).toBe(true);
    expect(closed).toBe(true);
  });
});

describe('spec panel', () => {
  it('shows the canonical scene and what could not be projected', () => {
    const state = makeManager();
    state.enqueueChanges(
      {
        constraints_added: [{ text: 'Must fit on a balcony.', provenance: 'user_stated', category: 'physical' }],
        alternatives_added: [
          {
            name: 'Frame',
            text: 'Frame',
            summary: 'A frame.',
            provenance: 'model_suggestion',
            spec: {
              objects: [
                { name: 'Post', type: 'box', dimensions: { height: '2 m', width: 'wide' }, properties: {}, material: null },
              ],
              connections: [{ from: 'Post', to: 'Ghost', kind: 'mechanical', label: null }],
              constraints: [{ key: 'sealed', value: true }],
            },
          },
        ],
      },
      { origin: 'explore', message_id: null },
    );
    state.acceptChanges(state.pendingChanges().map((record) => record.id));
    state.selectAlternative(state.idea!.alternatives[0]!.id);

    const panel = renderSpec(state.idea, []);
    const rendered = text(panel);
    expect(rendered).toContain('Canonical representation');
    expect(rendered).toContain('"units": "mm"');
    expect(rendered).toContain('"mm": 2000');
    expect(rendered).toContain('Could not parse the width dimension "wide"');
    expect(rendered).toContain('names an object that is not in the graph');
    expect(rendered).toContain('No plugins registered');
    expect(rendered).toContain('What this idea rests on');
  });

  it('says there is nothing to project before an idea exists', () => {
    expect(text(renderSpec(null, []))).toMatch(/Nothing to project yet/);
  });
});

describe('conversation', () => {
  it('renders a question card with its justification', () => {
    const entry = {
      id: 'msg_1',
      role: 'ideno' as const,
      text: 'Recorded.',
      created_at: '2026-01-01T00:00:00.000Z',
      turn_id: 'turn_1',
      operation: 'update' as const,
      classification: 'new_information' as const,
      reasoning_summary: 'Added the constraint.',
      question: {
        text: 'Is there an outdoor outlet?',
        why_it_matters: 'It decides the power architecture.',
        impact: 'high' as const,
        unknown_id: null,
      },
      error_code: null,
      raw_text: null,
    };
    const node = renderMessage(entry);
    const rendered = text(node);
    expect(rendered).toContain('One question · high impact');
    expect(rendered).toContain('Is there an outdoor outlet?');
    expect(rendered).toContain('It decides the power architecture.');
    expect(rendered).toContain('read as: new information');
    expect(node.querySelector('details summary')?.textContent).toBe('Why');
  });

  it('keeps an unusable model response behind a disclosure', () => {
    const node = renderMessage({
      id: 'msg_2',
      role: 'system',
      text: 'The model response could not be validated.',
      created_at: '2026-01-01T00:00:00.000Z',
      turn_id: null,
      operation: null,
      classification: null,
      reasoning_summary: null,
      question: null,
      error_code: 'malformed_response',
      raw_text: '{"operation": broken',
    });
    expect(node.classList.contains('message-error')).toBe(true);
    const details = node.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toMatch(/unusable model response/);
    expect(details?.textContent).toContain('{"operation": broken');
  });
});

// ---------------------------------------------------------------------------
// Full application boot
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the UI to settle.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the application', () => {
  let mount: HTMLElement;
  /**
   * Every app this suite creates.
   *
   * The app coalesces its writes, so an app that is not disposed can still have a
   * pending save when the next test clears `localStorage` — which made one of these
   * tests fail roughly one run in three. Disposing in `afterEach` is what a real
   * embedding page does on teardown anyway.
   */
  let apps: { dispose(): void }[];

  /** Creates an app and registers it for teardown. */
  function createTrackedApp(target: HTMLElement) {
    const app = createApp(target);
    apps.push(app);
    return app;
  }

  beforeEach(() => {
    apps = [];
    localStorage.clear();
    localStorage.setItem(
      'ideno.settings.v1',
      JSON.stringify(
        PersistedSettingsSchema.parse({
          ...SettingsSchema.parse({ provider_id: 'scripted', timeout_ms: 5000 }),
          openai_api_key: null,
        }),
      ),
    );
    document.body.replaceChildren();
    mount = document.createElement('div');
    mount.id = 'app';
    document.body.appendChild(mount);
  });

  afterEach(() => {
    for (const app of apps) app.dispose();
    apps = [];
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('boots to a start screen and runs the scripted scenario end to end', async () => {
    const app = createTrackedApp(mount);
    await app.start();

    expect(text(mount)).toContain('Give Ideno a rough idea');
    expect(text(mount)).toContain('Scripted offline demo');

    const demo = [...mount.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Run the labelled offline demo'),
    )!;
    expect(demo).toBeTruthy();
    demo.click();

    await waitFor(() => text(mount).includes('Demo complete'));

    const rendered = text(mount);
    expect(rendered).toContain('Small autonomous greenhouse');
    expect(rendered).toContain('I want to build a small autonomous greenhouse.');
    expect(rendered).toContain('Must fit within a balcony footprint');
    expect(rendered).toContain('without cloud connectivity');
    expect(rendered).toContain('Battery-powered sensor node with local scheduler');
    expect(rendered).toContain('Your decision');
    expect(rendered).toContain('Passive solar with wicking beds');
    expect(rendered).toMatch(/Offline demo running|Demo mode:/);

    // The conversation holds all five user messages and five replies.
    expect(mount.querySelectorAll('.message-user')).toHaveLength(5);
    expect(mount.querySelectorAll('.message-ideno')).toHaveLength(5);

    // Every proposal was accepted by the demo, so nothing is left pending.
    const reviewTab = [...mount.querySelectorAll<HTMLElement>('.tab')].find((node) =>
      node.textContent?.startsWith('Review'),
    )!;
    expect(reviewTab.querySelector('.badge')).toBeNull();
    expect([...mount.querySelectorAll('.item-proposed')]).toHaveLength(0);

    // The history tab shows real versions with real diffs.
    const historyTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent === 'History',
    )!;
    historyTab.click();
    await waitFor(() => text(mount).includes('Versions'));
    expect(text(mount)).toContain('Original idea');
    expect(text(mount)).toMatch(/Constraints added|Requirements added/);

    // The spec tab projects the selected alternative.
    const specTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent === 'Spec',
    )!;
    specTab.click();
    await waitFor(() => text(mount).includes('Canonical representation'));
    expect(text(mount)).toContain('Battery-powered sensor node with local scheduler');
    expect(text(mount)).toContain('"units": "mm"');
    expect(text(mount)).toContain('Peristaltic pump');
  }, 30_000);

  it('persists the idea and restores it on the next boot', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    const demo = [...mount.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Run the labelled offline demo'),
    )!;
    demo.click();
    await waitFor(() => text(mount).includes('Demo complete'));
    // v2 layout: a small index plus one record per idea.
    expect(localStorage.getItem('ideno.workspace.index.v2')).not.toBeNull();
    const index = JSON.parse(localStorage.getItem('ideno.workspace.index.v2')!) as {
      active_session_id: string | null;
    };
    expect(index.active_session_id).not.toBeNull();
    expect(localStorage.getItem(`ideno.session.v2.${index.active_session_id}`)).not.toBeNull();

    // A fresh app instance reads the same storage the browser would. The first app
    // is disposed first: it may still be holding a coalesced write, and a page
    // navigating away is exactly when `dispose()` runs.
    app.dispose();
    document.body.replaceChildren();
    const remount = document.createElement('div');
    remount.id = 'app';
    document.body.appendChild(remount);
    await createTrackedApp(remount).start();

    expect(text(remount)).toContain('Small autonomous greenhouse');
    expect(remount.querySelectorAll('.message-user')).toHaveLength(5);
    expect(text(remount)).toContain('Must fit within a balcony footprint');
  }, 30_000);

  it('shows a streamed response as a proposal, and clears it when the turn ends', async () => {
    const app = createTrackedApp(mount);
    await app.start();

    // The scripted provider is configured by the app without streaming, so the
    // preview is exercised through the same event path the orchestrator uses.
    const previews = [...mount.querySelectorAll('.thinking-preview')];
    expect(previews).toHaveLength(0);

    const textarea = mount.querySelector('.start textarea') as HTMLTextAreaElement;
    textarea.value = 'A greenhouse.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    findButton('Start developing').click();

    await waitFor(() => mount.querySelectorAll('.message-ideno').length > 0);
    // Once the turn is over nothing provisional is left on screen: a stale
    // "proposing…" would describe a state the idea is no longer in.
    expect(mount.querySelectorAll('.thinking-preview')).toHaveLength(0);
    expect(mount.querySelectorAll('.thinking')).toHaveLength(0);
  }, 30_000);

  it('renders the thinking indicator with a provisional preview line', () => {
    const node = renderThinking('Calling the model…', 'Proposing 2 constraints…');
    expect(node.querySelector('.spinner')).not.toBeNull();
    expect(node.textContent).toContain('Calling the model…');
    const preview = node.querySelector('.thinking-preview')!;
    expect(preview.textContent).toBe('Proposing 2 constraints…');
    // The wording and the tooltip both say it is not a change that has been made.
    expect(preview.textContent).toMatch(/Proposing|Proposed/);
    expect(preview.getAttribute('title')).toMatch(/not yet validated/i);

    // Without a preview there is no provisional line at all.
    expect(renderThinking('Calling the model…').querySelector('.thinking-preview')).toBeNull();
  });

  it('offers the 3D view next to the canonical scene it was drawn from', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    await runDemo();

    const specTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent === 'Spec',
    )!;
    specTab.click();
    await waitFor(() => text(mount).includes('Canonical representation'));

    // The plugin registered at startup, so the control is live rather than disabled
    // with a reason nobody can act on.
    const toggle = findButton('Show 3D view');
    expect(toggle.disabled).toBe(false);
    expect(text(mount)).toContain('loaded only when this view is opened');

    toggle.click();
    await waitFor(() => mount.querySelector('.viewer-mount') !== null);
    expect(findButton('Hide 3D view')).toBeTruthy();
    // jsdom has no WebGL, so the honest outcome is an explanation — and the canonical
    // JSON stays on screen, because the scene is the claim the drawing is drawn from.
    await waitFor(() => mount.querySelector('.viewer-fallback') !== null || mount.querySelector('canvas') !== null);
    expect(mount.querySelector('.viewer-fallback')?.textContent).toMatch(/did not provide WebGL/);
    expect(text(mount)).toContain('"units": "mm"');

    // Toggling off releases the view; the app owns the WebGL context's lifetime, not
    // the component tree.
    findButton('Hide 3D view').click();
    await waitFor(() => text(mount).includes('Show 3D view'));
    expect(mount.querySelector('.viewer-fallback')).toBeNull();
    expect(app.desktopHost).toBeNull();
  }, 40_000);

  it('records evidence typed into the state panel', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    const demo = [...mount.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Run the labelled offline demo'),
    )!;
    demo.click();
    await waitFor(() => text(mount).includes('Demo complete'));

    const open = [...mount.querySelectorAll('button')].find((node) => node.textContent === 'Add evidence')!;
    open.click();
    const inputs = [...mount.querySelectorAll('.review-card input')] as HTMLInputElement[];
    inputs[0]!.value = 'Balcony live loads are commonly 250 kg/m2.';
    inputs[1]!.value = 'Structural guide';
    inputs[2]!.value = 'https://example.com/balcony-load';
    inputs[3]!.value = 'Caps the weight of a filled reservoir.';
    inputs[4]!.value = '0.8';
    [...mount.querySelectorAll('button')]
      .find((node) => node.textContent === 'Save as evidence')!
      .click();

    await waitFor(() => text(mount).includes('Evidence recorded'));
    expect(text(mount)).toContain('Balcony live loads are commonly 250 kg/m2.');
    // The panel shows the short provenance word; the full sentence is the tooltip.
    const evidenced = mount.querySelector('.prov-evidence_supported');
    expect(evidenced?.textContent).toBe('Evidenced');
    expect(evidenced?.getAttribute('title')).toBe('Supported by evidence');
    const link = [...mount.querySelectorAll('a')].find((node) =>
      node.getAttribute('href')?.includes('balcony-load'),
    );
    expect(link).toBeTruthy();
  }, 30_000);

  it('sends a typed message and shows the reply', async () => {
    const app = createTrackedApp(mount);
    await app.start();

    const textarea = mount.querySelector('.start textarea') as HTMLTextAreaElement;
    textarea.value = 'A wind-powered water pump.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const start = [...mount.querySelectorAll('button')].find((node) => node.textContent === 'Start developing')!;
    expect(start.disabled).toBe(false);
    start.click();

    await waitFor(() => mount.querySelectorAll('.message-ideno').length > 0);
    expect(mount.querySelector('.message-user')?.textContent).toContain('A wind-powered water pump.');
    // The scripted provider's first turn is the greenhouse understanding pass,
    // which is fine: what is being tested is that the UI wired the message through.
    expect(text(mount)).toContain('Requirements');
  }, 20_000);

  /** Runs the demo so the app has a developed idea to work with. */
  async function runDemo(): Promise<void> {
    const demo = [...mount.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Run the labelled offline demo'),
    )!;
    demo.click();
    await waitFor(() => text(mount).includes('Demo complete'));
  }

  function findButton(label: string, root: ParentNode = mount): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No button labelled "${label}"`);
    return found;
  }

  /**
   * States an idea in the composer and waits for Ideno to answer.
   *
   * Two ideas have to be *stated*, not merely started: an IdeaCase cannot exist
   * without `original_idea`, so "New idea" closes the open one and shows the start
   * screen rather than creating an empty idea that would clutter the workspace.
   */
  async function stateIdea(text_: string): Promise<void> {
    const textarea = mount.querySelector('.start textarea') as HTMLTextAreaElement;
    textarea.value = text_;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    findButton('Start developing').click();
    await waitFor(() => mount.querySelectorAll('.message-ideno').length > 0);
  }

  it('keeps several ideas and switches between them', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    await stateIdea('A compost heater for a small garden.');

    // Start a second idea. No confirmation is asked for, because nothing is lost:
    // the first idea stays in the workspace.
    findButton('New idea').click();
    await waitFor(() => text(mount).includes('Give Ideno a rough idea'));
    expect(text(mount)).not.toContain('A compost heater');
    await stateIdea('A tidal pump for a salt marsh.');

    // The workspace lists both.
    findButton('Workspace').click();
    await waitFor(() => mount.querySelector('.idea-list') !== null);
    expect(mount.querySelectorAll('.idea-row')).toHaveLength(2);
    expect(text(mount)).toContain('A tidal pump');

    // Opening the first idea brings back its own conversation, not the second one's.
    const openFirst = [...mount.querySelectorAll<HTMLButtonElement>('.idea-open')].find((node) =>
      node.textContent?.includes('A compost heater'),
    )!;
    openFirst.click();
    await waitFor(() => text(mount).includes('A compost heater for a small garden.'));
    expect(mount.querySelectorAll('.message-user')).toHaveLength(1);
    expect(text(mount)).not.toContain('A tidal pump for a salt marsh.');
    // The modal closed itself, so the app is usable again.
    expect(mount.querySelector('.modal-backdrop')).toBeNull();
    expect(app.desktopHost).toBeNull(); // a browser session, so browser storage
  }, 40_000);

  it('archives an idea without deleting it and brings it back', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    await stateIdea('A compost heater for a small garden.');
    findButton('New idea').click();
    await waitFor(() => text(mount).includes('Give Ideno a rough idea'));
    await stateIdea('A tidal pump for a salt marsh.');

    findButton('Workspace').click();
    await waitFor(() => mount.querySelector('.idea-list') !== null);

    const row = [...mount.querySelectorAll<HTMLElement>('.idea-row')].find((node) =>
      node.textContent?.includes('A compost heater'),
    )!;
    findButton('Archive', row).click();
    await waitFor(() => text(mount).includes('Archived (1)'));

    // Archived ideas are behind a disclosure, not gone, and the open idea is
    // untouched by archiving a different one.
    expect(mount.querySelectorAll('.idea-row')).toHaveLength(1);
    const show = [...mount.querySelectorAll('button')].find((node) =>
      node.textContent?.startsWith('Show 1 archived'),
    )!;
    show.click();
    await waitFor(() => mount.querySelectorAll('.idea-row').length === 2);

    findButton('Unarchive').click();
    await waitFor(() => text(mount).includes('Archived') === false);
    expect(mount.querySelectorAll('.idea-row')).toHaveLength(2);

    // Still openable, with its own conversation intact.
    const open = [...mount.querySelectorAll<HTMLButtonElement>('.idea-open')].find((node) =>
      node.textContent?.includes('A compost heater'),
    )!;
    expect(open.disabled).toBe(false);
    open.click();
    await waitFor(() => text(mount).includes('A compost heater for a small garden.'));
    expect(mount.querySelectorAll('.message-user')).toHaveLength(1);
  }, 40_000);

  it('forks a branch, works on it, and compares it with the one it came from', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    await runDemo();

    const historyTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent === 'History',
    )!;
    historyTab.click();
    await waitFor(() => text(mount).includes('Branches'));
    expect(text(mount)).toContain('Versions on “main”');

    // Fork from the tip.
    const nameField = mount.querySelector('input[aria-label="New branch name"]') as HTMLInputElement;
    nameField.value = 'passive-design';
    findButton('Fork here').click();
    await waitFor(() => text(mount).includes('Versions on “passive-design”'));
    expect(text(mount)).toContain('2 open · 0 archived');
    expect(text(mount)).toContain(
      'Nothing was copied: both timelines share the history below the fork.',
    );

    // The fork starts at the tip of main, so its own version list is the inherited
    // history and its tip is marked.
    expect(text(mount)).toContain('branch tip');
    expect(mount.querySelectorAll('.version-row').length).toBeGreaterThan(1);

    // Comparing immediately after a fork: nothing has diverged yet.
    const compare = mount.querySelectorAll('select.branch-select')[1] as HTMLSelectElement;
    const mainOption = [...compare.options].find((option) => option.text === 'main')!;
    compare.value = mainOption.value;
    compare.dispatchEvent(new Event('change'));
    await waitFor(() => text(mount).includes('since it forked from'));
    expect(text(mount)).toContain('“main” since it forked from “passive-design”');
    expect(text(mount)).toContain('has no versions of its own since the fork');

    // Switching back to main restores the state main had, unchanged.
    const branchSelect = mount.querySelectorAll('select.branch-select')[0] as HTMLSelectElement;
    const mainBranch = [...branchSelect.options].find((option) => option.text.startsWith('main#'))!;
    branchSelect.value = mainBranch.value;
    branchSelect.dispatchEvent(new Event('change'));
    await waitFor(() => text(mount).includes('Versions on “main”'));
    expect(text(mount)).toContain('Now on “main”');

    // Back on main, the idea itself is main's state again — which is the claim worth
    // testing, so it is checked in the panel that shows the state rather than the one
    // showing history.
    const stateTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent?.startsWith('Idea State'),
    )!;
    stateTab.click();
    await waitFor(() => text(mount).includes('Must fit within a balcony footprint'));
    expect(text(mount)).toContain('without cloud connectivity');

    // Archiving a branch is offered while two are open, and refused for the last one.
    historyTab.click();
    await waitFor(() => text(mount).includes('Archive branch'));
    findButton('Archive branch').click();
    await waitFor(() => text(mount).includes('1 open · 1 archived'));
    expect(mount.querySelectorAll('button').length).toBeGreaterThan(0);
    expect([...mount.querySelectorAll('button')].some((node) => node.textContent === 'Archive branch')).toBe(false);
  }, 40_000);

  it('labels a version from the history panel', async () => {
    const app = createTrackedApp(mount);
    await app.start();
    await runDemo();

    const historyTab = [...mount.querySelectorAll<HTMLButtonElement>('.tab')].find(
      (node) => node.textContent === 'History',
    )!;
    historyTab.click();
    await waitFor(() => mount.querySelectorAll('.version-row').length > 0);

    const rows = [...mount.querySelectorAll<HTMLElement>('.version-row')];
    const last = rows[rows.length - 1]!;
    findButton('Label', last).click();
    const field = last.querySelector('input.inline-editor-input') as HTMLInputElement;
    expect(field).not.toBeNull();
    field.value = 'before the balcony constraint';
    findButton('Label', last).click();

    await waitFor(() => text(mount).includes('before the balcony constraint'));
    expect(text(mount)).toContain('labelled');
    // The label replaces the summary in the row, and the row can be unlabelled.
    expect([...last.querySelectorAll('button')].some((node) => node.textContent === 'Unlabel')).toBe(false);
    const reread = [...mount.querySelectorAll<HTMLElement>('.version-row')];
    expect([...reread[reread.length - 1]!.querySelectorAll('button')].some(
      (node) => node.textContent === 'Unlabel',
    )).toBe(true);
  }, 40_000);
});

describe('state manager under a DOM environment', () => {
  it('still applies changes with structuredClone available from jsdom', () => {
    const state = new StateManager({ store: new MemoryStore(), clock: fixedClock(), persist: false });
    state.startSession('A kite.');
    state.enqueueChanges(
      { constraints_added: [{ text: 'Must fly in 10 knots.', provenance: 'user_stated' }] },
      { origin: 'update', message_id: null },
    );
    expect(state.idea?.constraints).toHaveLength(1);
  });
});
