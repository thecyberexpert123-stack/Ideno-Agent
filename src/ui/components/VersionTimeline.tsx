import { useState } from 'react';
import type { IdeaCase } from '../../core/schemas.js';

/**
 * Version history with per-version diffs.
 *
 * Versions are linear in v0.1 (`parent_id` already exists in the schema so
 * branching can be added without a migration). Each entry lists the exact
 * operations that were accepted into it.
 */
export function VersionTimeline({ ideaCase }: { ideaCase: IdeaCase }) {
  const versions = [...ideaCase.version_history].reverse();
  const [openId, setOpenId] = useState<string | null>(versions[0]?.id ?? null);

  if (versions.length === 0) {
    return <p className="state-section__empty">No versions yet.</p>;
  }

  return (
    <ol className="timeline">
      {versions.map((version) => {
        const changeset = version.changeset_id
          ? ideaCase.changesets.find((entry) => entry.id === version.changeset_id)
          : undefined;
        const accepted = changeset?.entries.filter((entry) => entry.status === 'accepted') ?? [];
        const rejected = changeset?.entries.filter((entry) => entry.status === 'rejected') ?? [];
        const open = openId === version.id;

        return (
          <li key={version.id} className={`timeline__item ${open ? 'is-open' : ''}`}>
            <button
              type="button"
              className="timeline__header"
              onClick={() => setOpenId(open ? null : version.id)}
            >
              <span className="timeline__version">v{version.index}</span>
              <span className="timeline__label">{version.label}</span>
              <time dateTime={version.created_at}>
                {new Date(version.created_at).toLocaleTimeString()}
              </time>
            </button>

            {open ? (
              <div className="timeline__body">
                {version.summary ? <p className="muted">{version.summary}</p> : null}
                {accepted.length > 0 ? (
                  <ul className="diff">
                    {accepted.map((entry) => (
                      <li key={entry.id} className="diff__add">
                        <span className="diff__sign">+</span>
                        <span>
                          {entry.label}
                          {entry.applier_note ? (
                            <em className="diff__note"> — {entry.applier_note}</em>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="diff">
                    {version.operations.map((operation, index) => (
                      <li key={`${version.id}-${index}`} className="diff__add">
                        <span className="diff__sign">+</span>
                        <span>{operation.op}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {rejected.length > 0 ? (
                  <ul className="diff">
                    {rejected.map((entry) => (
                      <li key={entry.id} className="diff__remove">
                        <span className="diff__sign">−</span>
                        <span>{entry.label} (you rejected this)</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
