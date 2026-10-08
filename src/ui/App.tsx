import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IdeaCase, ResearchItem } from '../core/schemas.js';
import type { CaseSummary } from '../core/store/store.js';
import { ApiError, api, type Capabilities, type ResearchResponse } from './api.js';
import { CaseSidebar } from './components/CaseSidebar.js';
import { ChangeReview } from './components/ChangeReview.js';
import { Composer } from './components/Composer.js';
import { Conversation } from './components/Conversation.js';
import { ProviderStatus } from './components/ProviderStatus.js';
import { ResearchDialog } from './components/ResearchDialog.js';
import { StatePanel } from './components/StatePanel.js';
import { VersionTimeline } from './components/VersionTimeline.js';

type Tab = 'state' | 'versions';

const AUTO_ACCEPT_KEY = 'ideno.autoAccept';

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'provider_unavailable' || error.code === 'provider_not_configured') {
      return `${error.message} Open the provider panel in the header for setup details.`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function App() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [ideaCase, setIdeaCase] = useState<IdeaCase | null>(null);
  const [tab, setTab] = useState<Tab>('state');
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [autoAccept, setAutoAccept] = useState(
    () => globalThis.localStorage?.getItem(AUTO_ACCEPT_KEY) === '1',
  );

  const [researchItem, setResearchItem] = useState<ResearchItem | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchResult, setResearchResult] = useState<ResearchResponse | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);

  useEffect(() => {
    globalThis.localStorage?.setItem(AUTO_ACCEPT_KEY, autoAccept ? '1' : '0');
  }, [autoAccept]);

  const refreshCases = useCallback(async () => {
    const { cases: list } = await api.listCases();
    setCases(list);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [caps, list] = await Promise.all([api.capabilities(), api.listCases()]);
        if (cancelled) return;
        setCapabilities(caps);
        setCases(list.cases);
        const first = list.cases[0];
        if (first) {
          const loaded = await api.getCase(first.id);
          if (!cancelled) setIdeaCase(loaded.case);
        }
      } catch (caught) {
        if (!cancelled) setError(describeError(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectCase = useCallback(async (id: string) => {
    setError(null);
    setQuestion(null);
    try {
      const loaded = await api.getCase(id);
      setIdeaCase(loaded.case);
      setTab('state');
    } catch (caught) {
      setError(describeError(caught));
    }
  }, []);

  const createCase = useCallback(
    async (idea: string) => {
      setBusy(true);
      setError(null);
      try {
        const created = await api.createCase(idea);
        setIdeaCase(created.case);
        await refreshCases();
        // The opening idea is immediately processed as the first turn, so a
        // new case never sits there as an empty shell.
        setPendingMessage(idea);
        const outcome = await api.sendTurn(created.case.id, idea, autoAccept);
        setIdeaCase(outcome.case);
        setQuestion(outcome.question?.text ?? null);
        if (outcome.degraded) {
          setError(outcome.failures.map((failure) => `${failure.stage}: ${failure.message}`).join(' · '));
        }
        await refreshCases();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setPendingMessage(null);
        setBusy(false);
      }
    },
    [autoAccept, refreshCases],
  );

  const deleteCase = useCallback(
    async (id: string) => {
      if (!globalThis.confirm?.('Delete this idea case and its history? This cannot be undone.')) {
        return;
      }
      setBusy(true);
      try {
        await api.deleteCase(id);
        const list = await refreshCases();
        if (ideaCase?.id === id) {
          const next = list[0];
          setIdeaCase(next ? (await api.getCase(next.id)).case : null);
        }
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [ideaCase?.id, refreshCases],
  );

  const sendMessage = useCallback(
    async (message: string) => {
      if (!ideaCase) return;
      setBusy(true);
      setError(null);
      setQuestion(null);
      setPendingMessage(message);
      try {
        const outcome = await api.sendTurn(ideaCase.id, message, autoAccept);
        setIdeaCase(outcome.case);
        setQuestion(outcome.question?.text ?? null);
        if (outcome.degraded && outcome.failures.length > 0) {
          setError(
            `Partial result — ${outcome.failures
              .map((failure) => `${failure.stage}: ${failure.message}`)
              .join(' · ')}`,
          );
        }
        await refreshCases();
      } catch (caught) {
        setError(describeError(caught));
        // Re-read the case: the user turn was persisted even if reasoning failed.
        try {
          setIdeaCase((await api.getCase(ideaCase.id)).case);
        } catch {
          /* keep the stale view rather than blanking the screen */
        }
      } finally {
        setPendingMessage(null);
        setBusy(false);
      }
    },
    [autoAccept, ideaCase, refreshCases],
  );

  const pendingChangeSet = useMemo(
    () => ideaCase?.changesets.find((changeset) => changeset.status === 'pending') ?? null,
    [ideaCase],
  );

  const decide = useCallback(
    async (decision: { acceptAll?: boolean; acceptedEntryIds?: string[] }) => {
      if (!ideaCase || !pendingChangeSet) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.decideChangeSet(ideaCase.id, pendingChangeSet.id, decision);
        setIdeaCase(result.case);
        await refreshCases();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setBusy(false);
      }
    },
    [ideaCase, pendingChangeSet, refreshCases],
  );

  const runResearch = useCallback(
    async (input: { url: string; question?: string; researchItemId?: string }) => {
      if (!ideaCase) return;
      setResearchBusy(true);
      setResearchError(null);
      setResearchResult(null);
      try {
        const result = await api.research(ideaCase.id, input);
        setIdeaCase(result.case);
        setResearchResult(result);
      } catch (caught) {
        setResearchError(describeError(caught));
      } finally {
        setResearchBusy(false);
      }
    },
    [ideaCase],
  );

  const closeResearch = useCallback(() => {
    setResearchItem(null);
    setResearchResult(null);
    setResearchError(null);
  }, []);

  const aiReady = capabilities?.ai.ready ?? true;

  return (
    <div className="layout">
      <CaseSidebar
        cases={cases}
        activeId={ideaCase?.id ?? null}
        busy={busy}
        onSelect={(id) => void selectCase(id)}
        onCreate={(idea) => void createCase(idea)}
        onDelete={(id) => void deleteCase(id)}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">
            <h2>{ideaCase?.title ?? 'No idea selected'}</h2>
            {ideaCase ? (
              <p className="muted">
                {ideaCase.requirements.filter((i) => i.status === 'active').length} requirements ·{' '}
                {ideaCase.constraints.filter((i) => i.status === 'active').length} constraints ·{' '}
                {ideaCase.evidence.length} evidence · v{ideaCase.version_history.at(-1)?.index ?? 0}
              </p>
            ) : null}
          </div>
          <ProviderStatus capabilities={capabilities} />
        </header>

        {!aiReady ? (
          <div className="banner banner--warn">
            No AI provider is configured, so Ideno cannot reason yet. Set
            <code>IDENO_OPENAI_BASE_URL</code> and <code>IDENO_OPENAI_MODEL</code> (any
            OpenAI-compatible endpoint, including a local one), or
            <code>IDENO_PUTER_AUTH_TOKEN</code>, then restart the server.
          </div>
        ) : null}

        {error ? (
          <div className="banner banner--error">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ) : null}

        {ideaCase ? (
          <div className="workspace">
            <section className="pane pane--conversation">
              <Conversation
                turns={ideaCase.conversation}
                pending={pendingMessage}
                question={question}
              />
              <Composer
                disabled={busy || !aiReady}
                autoAccept={autoAccept}
                onAutoAcceptChange={setAutoAccept}
                onSend={(message) => void sendMessage(message)}
              />
            </section>

            <section className="pane pane--state">
              <div className="tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'state'}
                  className={tab === 'state' ? 'is-active' : ''}
                  onClick={() => setTab('state')}
                >
                  Idea State
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'versions'}
                  className={tab === 'versions' ? 'is-active' : ''}
                  onClick={() => setTab('versions')}
                >
                  Versions
                  <span className="tab__count">{ideaCase.version_history.length}</span>
                </button>
              </div>

              {pendingChangeSet ? (
                <ChangeReview
                  changeset={pendingChangeSet}
                  busy={busy}
                  onDecide={(decision) => void decide(decision)}
                />
              ) : null}

              <div className="pane__scroll">
                {tab === 'state' ? (
                  <StatePanel ideaCase={ideaCase} onResearch={setResearchItem} />
                ) : (
                  <VersionTimeline ideaCase={ideaCase} />
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="empty-state">
            <h3>Start with one sentence.</h3>
            <p>
              Ideno turns it into a structured Idea State — requirements, constraints, assumptions,
              unknowns, evidence and alternatives — and keeps that state, not the chat log, as the
              source of truth.
            </p>
          </div>
        )}
      </main>

      <ResearchDialog
        item={researchItem}
        busy={researchBusy}
        result={researchResult}
        error={researchError}
        onClose={closeResearch}
        onSubmit={(input) => void runResearch(input)}
      />
    </div>
  );
}
