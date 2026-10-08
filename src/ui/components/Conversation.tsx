import { useEffect, useRef } from 'react';
import type { ConversationTurn } from '../../core/schemas.js';

/**
 * The conversation.
 *
 * Intentionally the *smaller* half of the product: it is the input channel to
 * the Idea State, not the record of it. Nothing of substance lives only here.
 */
export function Conversation({
  turns,
  pending,
  question,
}: {
  turns: ConversationTurn[];
  pending: string | null;
  question: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, pending]);

  return (
    <div className="conversation">
      {turns.map((turn) => (
        <article key={turn.id} className={`turn turn--${turn.role}`}>
          <div className="turn__role">{turn.role === 'ideno' ? 'Ideno' : turn.role}</div>
          <div className="turn__text">
            {turn.text.split('\n').map((line, index) =>
              line.trim().length === 0 ? (
                <br key={index} />
              ) : (
                <p key={index}>{line}</p>
              ),
            )}
          </div>
          {turn.degraded ? (
            <div className="turn__flag" title="One or more reasoning stages failed on this turn">
              partial result
            </div>
          ) : null}
        </article>
      ))}

      {pending ? (
        <>
          <article className="turn turn--user">
            <div className="turn__role">user</div>
            <div className="turn__text">
              <p>{pending}</p>
            </div>
          </article>
          <article className="turn turn--ideno turn--thinking">
            <div className="turn__role">Ideno</div>
            <div className="turn__text">
              <span className="thinking">
                <span />
                <span />
                <span />
              </span>
              <p className="muted">
                Understanding, checking impact, critiquing, and exploring alternatives…
              </p>
            </div>
          </article>
        </>
      ) : null}

      {question && !pending ? (
        <div className="open-question">
          <strong>Highest-impact unknown</strong>
          <p>{question}</p>
        </div>
      ) : null}

      <div ref={bottomRef} />
    </div>
  );
}
