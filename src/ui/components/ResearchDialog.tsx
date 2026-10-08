import { useState } from 'react';
import type { ResearchItem } from '../../core/schemas.js';
import type { ResearchResponse } from '../api.js';

/**
 * Research is explicit and source-first.
 *
 * You give Ideno a URL; it fetches the page and only keeps claims whose
 * verbatim excerpt is actually present in what it fetched. There is no
 * "search the web and tell me" path, because that is exactly how unsourced
 * model output gets laundered into evidence.
 */
export function ResearchDialog({
  item,
  busy,
  result,
  error,
  onClose,
  onSubmit,
}: {
  item: ResearchItem | null;
  busy: boolean;
  result: ResearchResponse | null;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: { url: string; question?: string; researchItemId?: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [question, setQuestion] = useState('');

  if (!item) return null;

  const submit = () => {
    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0 || busy) return;
    onSubmit({
      url: trimmedUrl,
      researchItemId: item.id,
      ...(question.trim().length > 0 ? { question: question.trim() } : {}),
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Research a source"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Research a source</h2>
        <p className="muted">{item.question}</p>

        <label className="field">
          <span>Source URL</span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.org/spec"
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>Narrow the question (optional)</span>
          <input
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={item.question}
            disabled={busy}
          />
        </label>

        <p className="modal__note">
          Ideno fetches the page server-side, blocks private network addresses, and discards any
          claim whose quoted excerpt it cannot find in the retrieved text.
        </p>

        {error ? <p className="modal__error">{error}</p> : null}

        {result ? (
          <div className="modal__result">
            <p>
              <strong>{result.claimsAccepted}</strong> claim(s) verified from{' '}
              {result.sourceTitle ?? 'the page'}
              {result.claimsRejected > 0 ? (
                <>
                  , <strong>{result.claimsRejected}</strong> discarded as unverifiable
                </>
              ) : null}
              .
            </p>
            <p className="muted">{result.researchSummary}</p>
            {result.warnings.map((warning) => (
              <p key={warning} className="modal__warning">
                {warning}
              </p>
            ))}
          </div>
        ) : null}

        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={onClose} disabled={busy}>
            {result ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={busy || url.trim().length === 0}
          >
            {busy ? 'Fetching…' : 'Fetch and extract'}
          </button>
        </div>
      </div>
    </div>
  );
}
