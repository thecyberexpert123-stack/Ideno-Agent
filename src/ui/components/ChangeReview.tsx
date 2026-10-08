import { useEffect, useMemo, useState } from 'react';
import type { ChangeSet, ChangeSetEntry, StateOperation } from '../../core/schemas.js';

/**
 * Pending change review.
 *
 * Spec §8: changes are never applied silently. Every proposed operation is
 * shown with what it does, what it touches, and an individual accept/reject.
 * Rejecting part of a proposal is normal, not an error path.
 */

function operationKindLabel(operation: StateOperation): string {
  switch (operation.op) {
    case 'add':
      return `add → ${operation.collection}`;
    case 'update':
      return `update → ${operation.target_id}`;
    case 'invalidate':
      return `invalidate → ${operation.target_id}`;
    case 'relate':
      return `link ${operation.type}`;
    case 'set_field':
      return `set ${operation.field}`;
    default:
      return 'change';
  }
}

function operationDetail(operation: StateOperation): string | null {
  switch (operation.op) {
    case 'add':
      return operation.item.rationale ?? null;
    case 'update':
      return Object.entries(operation.changes)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(' · ');
    case 'invalidate':
      return operation.reason;
    case 'relate':
      return operation.note ?? `${operation.from} → ${operation.to}`;
    case 'set_field':
      return operation.field === 'current_state'
        ? operation.value.summary
        : String(operation.value);
    default:
      return null;
  }
}

export function ChangeReview({
  changeset,
  busy,
  onDecide,
}: {
  changeset: ChangeSet;
  busy: boolean;
  onDecide: (decision: { acceptAll?: boolean; acceptedEntryIds?: string[] }) => void;
}) {
  const pendingEntries = useMemo(
    () => changeset.entries.filter((entry) => entry.status === 'pending'),
    [changeset],
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(pendingEntries.map((entry) => entry.id)),
  );

  // A new proposal starts fully selected: accepting everything is the common
  // case, and the user opts out of individual items.
  useEffect(() => {
    setSelected(new Set(changeset.entries.filter((e) => e.status === 'pending').map((e) => e.id)));
  }, [changeset.id, changeset.entries]);

  if (changeset.status !== 'pending' || pendingEntries.length === 0) return null;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const affectedAreas = [...new Set(pendingEntries.flatMap((entry) => entry.affected_areas))];
  const selectedCount = selected.size;

  return (
    <section className="review" aria-label="Proposed changes">
      <header className="review__header">
        <div>
          <h3>Proposed changes</h3>
          <p className="review__summary">{changeset.summary}</p>
        </div>
        <span className="review__count">
          {selectedCount}/{pendingEntries.length}
        </span>
      </header>

      {changeset.reasoning_summary ? (
        <p className="review__reasoning">{changeset.reasoning_summary}</p>
      ) : null}

      {affectedAreas.length > 0 ? (
        <div className="review__areas">
          <span className="muted">Affects:</span>
          {affectedAreas.map((area) => (
            <span key={area} className="tag">
              {area}
            </span>
          ))}
        </div>
      ) : null}

      <ul className="review__list">
        {pendingEntries.map((entry: ChangeSetEntry) => {
          const detail = operationDetail(entry.operation);
          return (
            <li key={entry.id} className={selected.has(entry.id) ? 'is-selected' : 'is-deselected'}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  disabled={busy}
                />
                <span className="review__entry">
                  <span className="review__label">{entry.label}</span>
                  <span className="review__kind">{operationKindLabel(entry.operation)}</span>
                  {detail ? <span className="review__detail">{detail}</span> : null}
                  {entry.affected_item_ids.length > 0 ? (
                    <span className="review__refs">
                      touches {entry.affected_item_ids.map((id) => <code key={id}>{id}</code>)}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {changeset.warnings.length > 0 ? (
        <ul className="review__warnings">
          {changeset.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <footer className="review__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || selectedCount === 0}
          onClick={() => onDecide({ acceptedEntryIds: [...selected] })}
        >
          {selectedCount === pendingEntries.length
            ? 'Accept all'
            : `Accept ${selectedCount} of ${pendingEntries.length}`}
        </button>
        <button
          type="button"
          className="button button--ghost"
          disabled={busy}
          onClick={() => onDecide({ acceptedEntryIds: [] })}
        >
          Reject all
        </button>
      </footer>
    </section>
  );
}
