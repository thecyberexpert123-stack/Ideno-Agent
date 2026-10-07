/**
 * Version history, branches, and the diff view.
 *
 * The point of this panel is that "what changed" is computed from two snapshots,
 * not quoted from a model's summary. If Ideno says it added a constraint, this
 * view shows whether the state actually gained one.
 *
 * Branching is presented as what it is: a way to develop an alternative as its own
 * timeline without losing the one it forked from. A fork costs one record and
 * copies nothing, so both timelines stay available and can be compared from the
 * point they diverged — which is the comparison that answers the question actually
 * being asked.
 */
import type { Branch, IdeaCase, VersionRecord } from '../../core/schemas/index.js';
import { diffAgainstParent, compareBranches, type DiffEntry } from '../../core/versioning/diff.js';
import {
  activeBranch,
  branchVersions,
  branchVersionNumbers,
  findBranch,
  findVersion,
} from '../../core/versioning/branch.js';
import { COLLECTION_LABELS, type CollectionName } from '../../core/idea_state/collections.js';
import { button, el, type Child } from '../dom.js';
import { formatTime, provenanceShort } from '../format.js';

export interface VersionActions {
  onSelect(versionId: string): void;
  onRestore(versionId: string): void;
  onCreateBranch(name: string, fromVersionId: string): void;
  onSwitchBranch(branchId: string): void;
  /**
   * Chooses the branch to compare against, or clears the comparison.
   *
   * This is an action rather than a mutation of the view object because the panel is
   * a pure function of its inputs: a `<select>` that quietly edited state without
   * asking for a re-render would leave the comparison chosen but not shown.
   */
  onCompare(branchId: string | null): void;
  onArchiveBranch(branchId: string, archived: boolean): void;
  onLabelVersion(versionId: string, label: string | null): void;
}

/** What the panel is currently showing; owned by the app so it survives re-renders. */
export interface VersionViewState {
  selectedVersionId: string | null;
  /** Branch being compared against the one being viewed, when comparing. */
  compareBranchId: string | null;
}

export function renderVersions(
  idea: IdeaCase | null,
  view: VersionViewState,
  actions: VersionActions,
): HTMLElement {
  if (!idea) return el('div', { class: 'empty-line', text: 'No idea yet, so no history yet.' });

  const history = idea.version_history;
  if (history.length === 0) {
    return el('div', { class: 'empty-line', text: 'No versions recorded yet.' });
  }

  const branch = activeBranch(idea);
  const versions = branchVersions(branch, history);
  if (versions.length === 0) {
    return el('div', { class: 'empty-line', text: 'This branch has no versions yet.' });
  }

  const numbers = branchVersionNumbers(branch, history);
  const selected =
    versions.find((version) => version.id === view.selectedVersionId) ??
    (versions[versions.length - 1] as VersionRecord);

  return el(
    'div',
    null,
    renderBranchBar(idea, branch, view, actions),
    el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'section-head' },
        el('span', { text: branch ? `Versions on “${branch.name}”` : 'Versions' }),
        el('span', {
          class: 'section-count',
          text: `${versions.length} of ${history.length} recorded`,
        }),
      ),
      el(
        'div',
        { class: 'section-body' },
        [...versions]
          .reverse()
          .map((version) => renderVersionRow(version, version.id === selected.id, numbers, branch, actions)),
      ),
    ),
    view.compareBranchId && branch
      ? renderBranchComparison(idea, branch, view.compareBranchId)
      : renderDiff(selected, history),
  );
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

function renderBranchBar(
  idea: IdeaCase,
  branch: Branch | null,
  view: VersionViewState,
  actions: VersionActions,
): HTMLElement {
  const live = idea.branches.filter((entry) => !entry.archived);
  const archived = idea.branches.filter((entry) => entry.archived);

  const select = el(
    'select',
    {
      class: 'branch-select',
      ariaLabel: 'Branch',
      onChange: (event) => {
        const value = (event.target as HTMLSelectElement).value;
        if (value && value !== branch?.id) actions.onSwitchBranch(value);
      },
    },
    ...live.map((entry) => el('option', { value: entry.id, text: branchLabel(entry, idea) })),
  );
  if (archived.length > 0) {
    // Archived branches are listed but not selectable: opening one is a two-step
    // act (unarchive, then switch), and a disabled option says that better than a
    // switch that immediately errors.
    select.appendChild(el('option', { value: '', text: `── ${archived.length} archived ──`, disabled: true }));
    for (const entry of archived) {
      select.appendChild(el('option', { value: entry.id, text: `${entry.name} (archived)`, disabled: true }));
    }
  }
  if (branch) select.value = branch.id;

  const forkForm = el('div', { class: 'branch-fork' });
  const nameInput = el('input', {
    type: 'text',
    placeholder: 'New branch name',
    ariaLabel: 'New branch name',
    value: '',
  });

  const submitFork = (): void => {
    const head = branch ? findVersion(idea.version_history, branch.head_version_id) : null;
    if (!head) return;
    // An empty name is accepted here and only here: forking from the tip has an
    // obvious default and the core's `suggestBranchName` will name it. Forking from
    // an older version goes through the inline editor, which requires a name,
    // because "from-v3" says nothing about why that timeline exists.
    actions.onCreateBranch(nameInput.value.trim(), head.id);
    nameInput.value = '';
  };

  forkForm.replaceChildren(
    nameInput,
    button('Fork here', {
      class: 'btn-sm',
      title:
        'Start a new timeline from the tip of this branch. Nothing is copied and nothing is lost: ' +
        'both branches keep their own history and can be compared.',
      onClick: submitFork,
    }),
  );
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitFork();
    }
  });

  const compareSelect = el(
    'select',
    {
      class: 'branch-select',
      ariaLabel: 'Compare with branch',
      onChange: (event) => {
        actions.onCompare((event.target as HTMLSelectElement).value || null);
      },
    },
    el('option', { value: '', text: 'Compare with…' }),
    ...idea.branches
      .filter((entry) => entry.id !== branch?.id)
      .map((entry) => el('option', { value: entry.id, text: entry.name })),
  );
  compareSelect.value = view.compareBranchId ?? '';

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('span', { text: 'Branches' }),
      el('span', { class: 'section-count', text: `${live.length} open · ${archived.length} archived` }),
    ),
    el(
      'div',
      { class: 'section-body branch-bar' },
      el('div', { class: 'branch-bar-row' }, el('span', { class: 'field-hint', text: 'Viewing' }), select),
      el('div', { class: 'branch-bar-row' }, forkForm),
      idea.branches.length > 1
        ? el('div', { class: 'branch-bar-row' }, compareSelect)
        : el('div', {
            class: 'field-hint',
            text: 'Fork a branch to develop an alternative as its own timeline.',
          }),
      branch && !branch.archived && live.length > 1
        ? el(
            'div',
            { class: 'branch-bar-row' },
            button('Archive branch', {
              class: 'btn-sm btn-ghost',
              title:
                'Retire this branch. Its versions stay in the history and it can be unarchived; ' +
                'nothing is deleted.',
              onClick: () => actions.onArchiveBranch(branch.id, true),
            }),
          )
        : null,
      branch?.description
        ? el('div', { class: 'field-hint', text: branch.description })
        : null,
    ),
  );
}

function branchLabel(branch: Branch, idea: IdeaCase): string {
  const versions = branchVersions(branch, idea.version_history);
  const head = versions.length > 0 ? versions[versions.length - 1] : null;
  const position = head ? `${branch.name}#${versions.length - 1}` : branch.name;
  return branch.id === idea.active_branch_id ? `${position} (current)` : position;
}

function renderBranchComparison(idea: IdeaCase, from: Branch, toBranchId: string): HTMLElement {
  const to = findBranch(idea, toBranchId);
  if (!to) {
    return el('div', { class: 'empty-line', text: 'That branch no longer exists.' });
  }

  const comparison = compareBranches(from, to, idea.version_history);
  if (!comparison.diff) {
    return el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'section-head' },
        el('span', { text: `“${from.name}” compared with “${to.name}”` }),
      ),
      el('p', { class: 'hint', text: comparison.reason ?? 'These branches could not be compared.' }),
    );
  }

  const base = comparison.base;
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('span', { text: `“${to.name}” since it forked from “${from.name}”` }),
      el('span', { class: 'section-count', text: comparison.diff.summary }),
    ),
    el(
      'p',
      { class: 'hint' },
      base
        ? `Compared from v${base.number}, the point the two branches diverged — not from the tip of ` +
          `“${from.name}”, which would list everything that branch did as though it were missing here.`
        : 'Compared from the earliest shared version.',
      comparison.unique_to_target.length > 0
        ? ` ${comparison.unique_to_target.length} version(s) on “${to.name}” since then.`
        : ` “${to.name}” has no versions of its own since the fork.`,
    ),
    el('div', { class: 'section-body' }, renderDiffEntries(comparison.diff.entries)),
  );
}

// ---------------------------------------------------------------------------
// Version rows
// ---------------------------------------------------------------------------

function renderVersionRow(
  version: VersionRecord,
  isSelected: boolean,
  numbers: Map<string, number>,
  branch: Branch | null,
  actions: VersionActions,
): HTMLElement {
  const isHead = branch ? branch.head_version_id === version.id : false;
  const position = numbers.get(version.id);
  // The number a person reads is the position along the branch they are looking at;
  // the stored `number` stays globally monotonic so ordering never depends on which
  // branch is open.
  const displayNumber = branch && position !== undefined ? `${branch.name}#${position}` : `v${version.number}`;

  const row = el(
    'div',
    {
      class: 'version-row',
      role: 'button',
      tabIndex: 0,
      title: `${version.summary} — ${formatTime(version.created_at)}`,
      onClick: () => actions.onSelect(version.id),
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          actions.onSelect(version.id);
        }
      },
    },
    el('span', { class: 'version-no', text: displayNumber }),
    el('span', { class: 'version-summary', text: version.label ?? version.summary }),
    version.label ? el('span', { class: 'chip chip-phase', text: 'labelled' }) : null,
    version.snapshot_pruned ? el('span', { class: 'chip', text: 'snapshot dropped' }) : null,
    el('span', { class: 'chip', text: version.trigger }),
    el('span', { class: 'version-time', text: formatTime(version.created_at) }),
    isSelected ? el('span', { class: 'chip chip-phase', text: 'viewing' }) : null,
    isHead ? el('span', { class: 'chip', text: 'branch tip' }) : null,
    button(version.label ? 'Unlabel' : 'Label', {
      class: 'btn-sm btn-ghost',
      title: version.label
        ? 'Remove the label.'
        : 'Name this point in history. A labelled version is never dropped under storage pressure.',
      onClick: (event) => {
        event.stopPropagation();
        if (version.label) {
          actions.onLabelVersion(version.id, null);
          return;
        }
        openInlineEditor(row, {
          fieldLabel: `Name v${version.number}`,
          placeholder: 'e.g. before the balcony constraint',
          initial: '',
          maxLength: 120,
          submitLabel: 'Label',
          onSubmit: (value) => actions.onLabelVersion(version.id, value),
        });
      },
    }),
    isHead || !version.snapshot
      ? null
      : button('Restore', {
          class: 'btn-sm',
          title: 'Restore this snapshot as a new version. History is never rewritten.',
          onClick: (event) => {
            event.stopPropagation();
            actions.onRestore(version.id);
          },
        }),
    isHead || !version.snapshot
      ? null
      : button('Fork', {
          class: 'btn-sm btn-ghost',
          title: 'Start a new branch from this point, keeping the current one as it is.',
          onClick: (event) => {
            event.stopPropagation();
            openInlineEditor(row, {
              fieldLabel: `Branch from v${version.number}`,
              placeholder: 'e.g. passive-design',
              initial: `from-v${version.number}`,
              maxLength: 60,
              submitLabel: 'Fork',
              onSubmit: (value) => actions.onCreateBranch(value, version.id),
            });
          },
        }),
  );
  return row;
}

export interface InlineEditorOptions {
  fieldLabel: string;
  placeholder: string;
  initial: string;
  maxLength: number;
  submitLabel: string;
  /** Called with the trimmed, length-capped value. An empty value is never submitted. */
  onSubmit(value: string): void;
}

/**
 * Swaps a row's contents for a one-field editor, and puts them back afterwards.
 *
 * Deliberately not `window.prompt`. Ideno runs in a browser *and* inside a web
 * engine hosted by Python, and `prompt` is exactly the kind of thing an embedded
 * engine quietly does not implement: jsdom returns `undefined` from it, and a
 * WebKitGTK or Qt window may never show a dialog at all. A feature that depended on
 * it would appear to work in one host and silently do nothing in the other, which
 * is the worst way to fail. An inline field behaves identically in every host, and
 * it is testable.
 */
export function openInlineEditor(row: HTMLElement, options: InlineEditorOptions): void {
  // Detached nodes are re-appendable, so "cancel" restores the row exactly.
  const previous = [...row.childNodes];
  const input = el('input', {
    type: 'text',
    value: options.initial,
    placeholder: options.placeholder,
    ariaLabel: options.fieldLabel,
    class: 'inline-editor-input',
  });
  input.maxLength = options.maxLength;

  const close = (): void => {
    row.replaceChildren(...previous);
  };
  const submit = (): void => {
    const value = input.value.trim().slice(0, options.maxLength);
    if (value.length === 0) {
      input.focus();
      return;
    }
    close();
    options.onSubmit(value);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    // The row itself behaves like a button: a space typed into the field must not
    // also select the version behind it.
    event.stopPropagation();
  });
  input.addEventListener('click', (event) => event.stopPropagation());

  row.replaceChildren(
    el('span', { class: 'field-hint', text: options.fieldLabel }),
    input,
    button(options.submitLabel, { class: 'btn-sm btn-primary', onClick: submit }),
    button('Cancel', { class: 'btn-sm btn-ghost', onClick: close }),
  );
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

function renderDiff(version: VersionRecord, history: VersionRecord[]): HTMLElement {
  // A pruned snapshot has no state to compare. Saying so is the honest rendering:
  // an empty diff would claim nothing changed, which is a different statement.
  if (!version.snapshot) return renderPrunedSnapshot(version);

  const diff = diffAgainstParent(version, history);

  if (!diff) {
    return el(
      'section',
      { class: 'section' },
      el('div', { class: 'section-head' }, el('span', { text: `v${version.number} — original idea` })),
      el('div', { class: 'goal-text' }, version.snapshot.original_idea),
    );
  }

  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('span', { text: `v${diff.from_version} → v${diff.to_version}` }),
      el('span', { class: 'section-count', text: diff.summary }),
    ),
    el('div', { class: 'section-body' }, renderDiffEntries(diff.entries)),
  );
}

function renderDiffEntries(entries: DiffEntry[]): Child {
  if (entries.length === 0) {
    return el('div', { class: 'empty-line', text: 'No difference between these versions.' });
  }

  const groups = new Map<CollectionName | 'idea', DiffEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.collection) ?? [];
    list.push(entry);
    groups.set(entry.collection, list);
  }

  return [...groups.entries()].map(([collection, group]) =>
    el(
      'div',
      { class: 'diff-group' },
      el(
        'div',
        { class: 'section-head' },
        el('span', { text: collection === 'idea' ? 'Idea' : COLLECTION_LABELS[collection] }),
        el('span', { class: 'section-count', text: String(group.length) }),
      ),
      group.map(renderDiffEntry),
    ),
  );
}

function renderDiffEntry(entry: DiffEntry): HTMLElement {
  const symbol = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '−' : '~';
  return el(
    'div',
    { class: `diff-entry diff-${entry.kind}` },
    el(
      'div',
      { class: 'item-main' },
      el('span', { class: 'version-no', text: symbol }),
      el('span', { class: 'item-text', text: entry.label }),
      entry.provenance ? el('span', { class: 'prov', text: provenanceShort(entry.provenance) }) : null,
      entry.status ? el('span', { class: 'chip', text: entry.status }) : null,
    ),
    entry.detail ? el('div', { class: 'item-detail', text: entry.detail }) : null,
    entry.fields.length > 0
      ? el(
          'div',
          null,
          entry.fields.map((field): Child =>
            el(
              'div',
              { class: 'diff-field' },
              el('span', { text: `${field.field}:` }),
              el('span', { class: 'diff-before', text: field.before }),
              el('span', { text: '→' }),
              el('span', { class: 'diff-after', text: field.after }),
            ),
          ),
        )
      : null,
  );
}

/** Shown for a version whose snapshot was dropped under storage pressure. */
function renderPrunedSnapshot(version: VersionRecord): HTMLElement {
  return el(
    'section',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('span', { text: `v${version.number} — snapshot not stored` })),
    el(
      'p',
      { class: 'hint' },
      `Ideno kept the record of this version ("${version.summary}") but not its state snapshot: ` +
        'storage ran out and this was the oldest snapshot that could be dropped. ' +
        'It cannot be compared or restored. Export your idea, or run Ideno as a desktop ' +
        'application where the workspace is stored as files rather than in browser storage.',
    ),
  );
}
