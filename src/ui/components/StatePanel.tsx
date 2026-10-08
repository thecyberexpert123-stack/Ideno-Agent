import { useState } from 'react';
import type {
  Alternative,
  Decision,
  Evidence,
  IdeaCase,
  IdeaItem,
  OpenItem,
  ResearchItem,
} from '../../core/schemas.js';
import { EpistemicBadge, ItemStatusBadge } from './EpistemicBadge.js';

/**
 * The right-hand Idea State panel — the actual product.
 *
 * Everything here is read from structured state. Nothing is parsed out of the
 * conversation, which is why a reload, a different provider, or a long gap
 * changes none of it.
 */

function Section({
  title,
  count,
  hint,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  hint: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`state-section ${open ? '' : 'is-collapsed'}`}>
      <button type="button" className="state-section__header" onClick={() => setOpen((v) => !v)}>
        <span className="state-section__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <h3>{title}</h3>
        <span className="state-section__count">{count}</span>
      </button>
      {open ? (
        count === 0 ? (
          <p className="state-section__empty">{hint}</p>
        ) : (
          <div className="state-section__body">{children}</div>
        )
      ) : null}
    </section>
  );
}

function ItemRow({ item, children }: { item: IdeaItem; children?: React.ReactNode }) {
  return (
    <article className={`item item--${item.status}`} id={item.id}>
      <div className="item__text">{item.text}</div>
      <div className="item__meta">
        <EpistemicBadge status={item.epistemic_status} origin={item.origin} confidence={item.confidence} />
        <ItemStatusBadge status={item.status} {...(item.status_reason ? { reason: item.status_reason } : {})} />
        {item.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        <code className="item__id" title="Stable identifier used by reasoning and relations">
          {item.id}
        </code>
      </div>
      {item.rationale ? <p className="item__rationale">{item.rationale}</p> : null}
      {children}
    </article>
  );
}

function OpenItemRow({ item }: { item: OpenItem }) {
  return (
    <ItemRow item={item}>
      <div className="item__footer">
        <span className="impact" title="How much the current design hinges on resolving this">
          impact {Math.round(item.impact * 100)}%
        </span>
        {item.blocks.map((area) => (
          <span key={area} className="tag tag--blocks">
            blocks {area}
          </span>
        ))}
      </div>
    </ItemRow>
  );
}

function EvidenceRow({ item }: { item: Evidence }) {
  const source = item.source;
  return (
    <article className={`item item--${item.status}`} id={item.id}>
      <div className="item__text">{item.claim}</div>
      <div className="item__meta">
        <EpistemicBadge status={item.epistemic_status} origin={item.origin} confidence={item.confidence} />
        {source.type === 'url' ? (
          <a className="source-link" href={source.url} target="_blank" rel="noreferrer noopener">
            {source.title ?? new URL(source.url).hostname}
          </a>
        ) : source.type === 'user' ? (
          <span className="source-link source-link--plain">cited by you: {source.description}</span>
        ) : (
          <span className="source-link source-link--plain">document: {source.name}</span>
        )}
        {source.type === 'url' && source.fetched_by_ideno ? (
          <span className="tag tag--verified" title="Ideno fetched this page and matched the excerpt in it">
            read by Ideno
          </span>
        ) : (
          <span className="tag tag--unverified" title="Ideno did not retrieve this source itself">
            not retrieved
          </span>
        )}
      </div>
      <p className="item__rationale">Relevance: {item.relevance}</p>
      {item.excerpt ? <blockquote className="excerpt">“{item.excerpt}”</blockquote> : null}
    </article>
  );
}

function ResearchRow({ item, onResearch }: { item: ResearchItem; onResearch: (item: ResearchItem) => void }) {
  return (
    <article className={`item item--${item.status}`} id={item.id}>
      <div className="item__text">{item.question}</div>
      <div className="item__meta">
        <span className={`badge badge--research-${item.research_status}`}>{item.research_status}</span>
        {item.evidence_ids.length > 0 ? (
          <span className="tag">{item.evidence_ids.length} evidence</span>
        ) : null}
        <button type="button" className="link-button" onClick={() => onResearch(item)}>
          research a source
        </button>
      </div>
      {item.why_it_matters ? <p className="item__rationale">{item.why_it_matters}</p> : null}
      {item.error ? <p className="item__error">Last attempt failed: {item.error}</p> : null}
    </article>
  );
}

function AlternativeRow({ item }: { item: Alternative }) {
  return (
    <article className={`item item--${item.status} ${item.selected ? 'item--selected' : ''}`} id={item.id}>
      <div className="item__text">
        {item.selected ? <span className="chosen-mark">chosen</span> : null}
        {item.text}
      </div>
      <p className="item__rationale">{item.approach}</p>
      <div className="alt-grid">
        {item.pros.length > 0 ? (
          <div>
            <h5>Pros</h5>
            <ul>
              {item.pros.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {item.cons.length > 0 ? (
          <div>
            <h5>Cons</h5>
            <ul>
              {item.cons.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {item.tradeoffs.length > 0 ? (
          <div>
            <h5>Trade-offs</h5>
            <ul>
              {item.tradeoffs.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="item__meta">
        <EpistemicBadge status={item.epistemic_status} origin={item.origin} confidence={item.confidence} />
        <ItemStatusBadge status={item.status} {...(item.status_reason ? { reason: item.status_reason } : {})} />
        {item.violates_constraints.length > 0 ? (
          <span className="tag tag--danger">violates {item.violates_constraints.length} constraint(s)</span>
        ) : null}
        <code className="item__id">{item.id}</code>
      </div>
    </article>
  );
}

function DecisionRow({ item }: { item: Decision }) {
  return (
    <article className={`item item--${item.status}`} id={item.id}>
      <div className="item__text">{item.chosen}</div>
      <p className="item__rationale">In answer to: {item.question}</p>
      <div className="item__meta">
        <EpistemicBadge status={item.epistemic_status} origin={item.origin} />
        <span className="tag">{new Date(item.decided_at).toLocaleString()}</span>
        <code className="item__id">{item.id}</code>
      </div>
    </article>
  );
}

export function StatePanel({
  ideaCase,
  onResearch,
}: {
  ideaCase: IdeaCase;
  onResearch: (item: ResearchItem) => void;
}) {
  const visible = <T extends { status: string }>(items: T[]): T[] =>
    items.filter((item) => item.status !== 'superseded');

  return (
    <div className="state-panel">
      <section className="state-goal">
        <h3>Goal</h3>
        <p>{ideaCase.current_intent || ideaCase.original_idea}</p>
        {ideaCase.current_state.summary ? (
          <p className="state-goal__summary">{ideaCase.current_state.summary}</p>
        ) : null}
        <div className="item__meta">
          <span className={`phase phase--${ideaCase.current_state.phase}`}>
            {ideaCase.current_state.phase}
          </span>
          <span className="tag">v{ideaCase.version_history.at(-1)?.index ?? 0}</span>
        </div>
      </section>

      <Section
        title="Requirements"
        count={visible(ideaCase.requirements).length}
        hint="What the idea must do. Added as you describe the outcome you want."
      >
        {visible(ideaCase.requirements).map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Constraints"
        count={visible(ideaCase.constraints).length}
        hint="Hard limits: space, budget, regulation, connectivity."
      >
        {visible(ideaCase.constraints).map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Assumptions"
        count={visible(ideaCase.assumptions).length}
        hint="What Ideno is taking for granted. Challenge any of these at any time."
      >
        {visible(ideaCase.assumptions).map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Unknowns"
        count={visible(ideaCase.unknowns).length}
        hint="Named gaps, ranked by how much the design depends on them."
      >
        {visible(ideaCase.unknowns).map((item) => (
          <OpenItemRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Evidence"
        count={visible(ideaCase.evidence).length}
        hint="Only claims with a real source. A model guess never lands here."
      >
        {visible(ideaCase.evidence).map((item) => (
          <EvidenceRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Research queue"
        count={visible(ideaCase.research_items).length}
        hint="Questions worth checking against a source."
        defaultOpen={false}
      >
        {visible(ideaCase.research_items).map((item) => (
          <ResearchRow key={item.id} item={item} onResearch={onResearch} />
        ))}
      </Section>

      <Section
        title="Alternatives"
        count={visible(ideaCase.alternatives).length}
        hint="Ask for alternative approaches once the constraints are in place."
      >
        {visible(ideaCase.alternatives).map((item) => (
          <AlternativeRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Decisions"
        count={visible(ideaCase.decisions).length}
        hint="Choices you have made. These are authoritative and steer everything after them."
      >
        {visible(ideaCase.decisions).map((item) => (
          <DecisionRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Open questions"
        count={visible(ideaCase.open_questions).length}
        hint="Conflicts and gaps raised by critique."
        defaultOpen={false}
      >
        {visible(ideaCase.open_questions).map((item) => (
          <OpenItemRow key={item.id} item={item} />
        ))}
      </Section>

      <Section
        title="Rejected approaches"
        count={visible(ideaCase.rejected_approaches).length}
        hint="Nothing has been ruled out yet."
        defaultOpen={false}
      >
        {visible(ideaCase.rejected_approaches).map((item) => (
          <ItemRow key={item.id} item={item}>
            <p className="item__rationale">Reason: {item.reason}</p>
          </ItemRow>
        ))}
      </Section>
    </div>
  );
}
