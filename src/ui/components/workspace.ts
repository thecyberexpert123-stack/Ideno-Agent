/**
 * The workspace: several ideas, one open at a time.
 *
 * This is the switcher, and it is deliberately not a sidebar of chat history. Every
 * row is an *idea* with a phase, a version count and a review queue — the state of
 * the thing being developed, not a list of conversations. That distinction is the
 * whole product thesis, and the switcher is where a user would first notice if it
 * had been lost.
 *
 * Archiving is offered; deleting is not. An idea someone spent an evening on is part
 * of the record, and the only destructive action in Ideno is the explicit
 * "clear this browser's data" in Settings, behind a confirmation.
 */
import { IDEA_PHASE_LABELS, type WorkspaceIndexEntry } from '../../core/schemas/index.js';
import { button, el } from '../dom.js';
import { formatTime } from '../format.js';

export interface WorkspaceModalInput {
  entries: WorkspaceIndexEntry[];
  activeSessionId: string | null;
  /** Set when the ideas are stored as files by the desktop host. */
  storageDescription: string | null;
  onOpen(sessionId: string): void;
  onArchive(sessionId: string, archived: boolean): void;
  onNewIdea(): void;
  onClose(): void;
}

export function renderWorkspaceModal(input: WorkspaceModalInput): HTMLElement {
  const showArchived = { value: false };

  const backdrop = el('div', {
    class: 'modal-backdrop',
    role: 'dialog',
    ariaLabel: 'Ideno workspace',
    onClick: (event) => {
      if (event.target === backdrop) input.onClose();
    },
  });

  const list = el('div', { class: 'idea-list' });

  const redraw = (): void => {
    const live = input.entries.filter((entry) => !entry.archived);
    const archived = input.entries.filter((entry) => entry.archived);
    const rows: HTMLElement[] = live.map((entry) =>
      renderIdeaRow(entry, entry.session_id === input.activeSessionId, input),
    );

    if (live.length === 0) {
      rows.push(
        el('div', {
          class: 'empty-line',
          text: 'No open ideas. Start one — a rough sentence is enough.',
        }),
      );
    }

    if (archived.length > 0) {
      rows.push(el('div', { class: 'modal-section-title', text: `Archived (${archived.length})` }));
      if (showArchived.value) {
        rows.push(...archived.map((entry) => renderIdeaRow(entry, false, input)));
      } else {
        rows.push(
          button(showArchivedLabel(archived.length), {
            class: 'btn-sm btn-ghost',
            onClick: () => {
              showArchived.value = true;
              redraw();
            },
          }),
        );
      }
    }

    list.replaceChildren(...rows);
  };

  redraw();

  const modal = el(
    'div',
    { class: 'modal' },
    el('h2', { text: 'Workspace' }),
    el(
      'p',
      { class: 'hint' },
      input.storageDescription ??
        'Ideas are stored in this browser. Opening another idea keeps this one — nothing is discarded.',
    ),
    list,
    el(
      'div',
      { class: 'modal-actions' },
      button('New idea', {
        variant: 'primary',
        onClick: () => {
          input.onNewIdea();
          input.onClose();
        },
      }),
      button('Close', { class: 'btn-ghost', onClick: () => input.onClose() }),
    ),
  );

  backdrop.appendChild(modal);
  return backdrop;
}

function showArchivedLabel(count: number): string {
  return `Show ${count} archived idea${count === 1 ? '' : 's'}`;
}

function renderIdeaRow(entry: WorkspaceIndexEntry, isActive: boolean, input: WorkspaceModalInput): HTMLElement {
  const pendingBadge =
    entry.pending > 0
      ? el('span', {
          class: 'badge',
          title: `${entry.pending} change(s) waiting for review`,
          text: String(entry.pending),
        })
      : null;

  return el(
    'div',
    { class: isActive ? 'idea-row idea-row-active' : 'idea-row' },
    el(
      'button',
      {
        class: 'idea-open',
        type: 'button',
        disabled: isActive || entry.archived,
        title: isActive
          ? 'This is the open idea.'
          : entry.archived
            ? 'Unarchive this idea to open it.'
            : `Open "${entry.title}"`,
        onClick: () => {
          if (!isActive && !entry.archived) input.onOpen(entry.session_id);
        },
      },
      el('span', { class: 'idea-title', text: entry.title }),
      el(
        'span',
        { class: 'idea-meta' },
        el('span', { class: 'chip chip-phase', text: IDEA_PHASE_LABELS[entry.phase] }),
        el('span', { text: `${entry.versions} versions` }),
        el('span', { text: formatTime(entry.updated_at) }),
        entry.archived ? el('span', { class: 'chip', text: 'archived' }) : null,
      ),
    ),
    pendingBadge,
    entry.archived
      ? button('Unarchive', {
          class: 'btn-sm btn-ghost',
          onClick: () => input.onArchive(entry.session_id, false),
        })
      : button('Archive', {
          class: 'btn-sm btn-ghost',
          title: 'Retire this idea from the list. Its files are kept and it can be unarchived.',
          onClick: () => input.onArchive(entry.session_id, true),
        }),
  );
}
