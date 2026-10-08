import { useState } from 'react';
import type { CaseSummary } from '../../core/store/store.js';

export function CaseSidebar({
  cases,
  activeId,
  busy,
  onSelect,
  onCreate,
  onDelete,
}: {
  cases: CaseSummary[];
  activeId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (idea: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || busy) return;
    onCreate(trimmed);
    setDraft('');
    setComposing(false);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo" aria-hidden="true">
          ◈
        </span>
        <div>
          <h1>Ideno</h1>
          <p>idea development system</p>
        </div>
      </div>

      {composing ? (
        <div className="sidebar__new">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="I want to build a small autonomous greenhouse."
            rows={4}
            autoFocus
            disabled={busy}
          />
          <div className="sidebar__new-actions">
            <button type="button" className="button button--ghost" onClick={() => setComposing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={submit}
              disabled={busy || draft.trim().length === 0}
            >
              Start
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button button--primary sidebar__cta"
          onClick={() => setComposing(true)}
          disabled={busy}
        >
          New idea
        </button>
      )}

      <nav className="sidebar__list" aria-label="Idea cases">
        {cases.length === 0 ? (
          <p className="muted sidebar__empty">No ideas yet. Start with a single sentence.</p>
        ) : (
          cases.map((summary) => (
            <div
              key={summary.id}
              className={`case-row ${summary.id === activeId ? 'is-active' : ''}`}
            >
              <button type="button" className="case-row__main" onClick={() => onSelect(summary.id)}>
                <span className="case-row__title">{summary.title}</span>
                <span className="case-row__meta">
                  v{summary.version} · {summary.phase}
                  {summary.pending_changesets > 0 ? (
                    <span className="case-row__pending">{summary.pending_changesets} to review</span>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                className="case-row__delete"
                title="Delete this case"
                aria-label={`Delete ${summary.title}`}
                onClick={() => onDelete(summary.id)}
                disabled={busy}
              >
                ×
              </button>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
