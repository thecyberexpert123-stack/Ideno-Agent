import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeSet, IdeaCase } from '../core/schemas.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { buildServices } from '../server/container.js';
import { MemoryCaseStore } from '../core/store/memory_store.js';
import { silentLogger } from '../core/logger.js';
import { ScriptedProvider, json } from './support/scripted_provider.js';

/**
 * The HTTP surface, exercised over a real socket.
 *
 * The app is assembled by the same `buildServices` the production entry point
 * uses, with only the store and the provider swapped. That means routing,
 * validation, the error taxonomy mapping and the orchestration wiring are all
 * genuinely under test — not a parallel test-only assembly.
 */

const UNDERSTAND = json({
  turn_intent: 'new_idea',
  intent_summary: 'You want a self-watering balcony greenhouse.',
  goal: 'A compact greenhouse that keeps plants alive without daily attention.',
  title_suggestion: 'Self-watering balcony greenhouse',
  phase: 'capturing',
  requirements: [
    {
      text: 'Waters the plants without daily human attention.',
      basis: 'stated',
      source_quote: 'waters itself',
    },
  ],
  constraints: [
    { text: 'Must fit within a balcony footprint.', basis: 'implied' },
  ],
  assumptions: [{ text: 'Mains power is available on the balcony.', basis: 'inferred' }],
  unknowns: [
    {
      text: 'The usable balcony width is unknown.',
      basis: 'inferred',
      impact: 0.8,
      blocks: ['enclosure'],
    },
  ],
  evidence: [],
  rejections: [],
  affected_item_ids: [],
  needs_critique: true,
  needs_exploration: false,
  needs_research: false,
});

const IMPACT = json({
  impacts: [],
  affected_areas: ['enclosure'],
  newly_relevant_unknowns: [],
  summary: 'This is the opening description, so nothing existing is affected.',
});

const CRITIQUE = json({
  findings: [
    {
      kind: 'missing_requirement',
      text: 'Nothing says what happens when the water reservoir runs dry.',
      severity: 'medium',
      related_item_ids: [],
      record_as: 'open_question',
      impact: 0.6,
    },
  ],
  summary: 'The failure behaviour of the watering loop is undefined.',
});

const EXPLORE = json({
  alternatives: [],
  adjacent_possibilities: [],
  research_questions: [],
  summary: '',
});

function scripted(): ScriptedProvider {
  return new ScriptedProvider({
    replies: {},
    fallback: (request) => {
      switch (request.purpose) {
        case 'understand':
          return UNDERSTAND;
        case 'impact':
          return IMPACT;
        case 'critique':
          return CRITIQUE;
        case 'explore':
          return EXPLORE;
        default:
          return new Error(`unexpected purpose "${request.purpose}"`);
      }
    },
  });
}

describe('HTTP API', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const config = loadConfig({
      IDENO_STORE: 'memory',
      IDENO_SERVE_UI: '0',
      IDENO_LOG_LEVEL: 'error',
    });
    const services = buildServices(config, {
      store: new MemoryCaseStore(),
      logger: silentLogger,
      providers: [scripted()],
    });

    server = createApp(services).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
  };

  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', body: JSON.stringify(body) });

  it('reports health', async () => {
    const response = await call('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', aiReady: true });
  });

  it('sets conservative security headers and hides the server stack', async () => {
    const response = await call('/api/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('lists capabilities including registered plugins', async () => {
    const response = await call('/api/capabilities');
    expect(response.status).toBe(200);

    const body = response.body as {
      ai: { ready: boolean; providers: { id: string }[] };
      plugins: { id: string; available: boolean }[];
      config: Record<string, unknown>;
    };
    expect(body.ai.ready).toBe(true);
    expect(body.plugins.map((plugin) => plugin.id)).toContain('research.url');
    // Credential *state* may be reported; credential *values* may not.
    expect(body.config).toMatchObject({ openaiApiKeySet: false, puterConfigured: false });
  });

  it('returns 404 as JSON for an unknown API route', async () => {
    const response = await call('/api/nope');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('rejects a malformed create request with 422 and field details', async () => {
    const response = await post('/api/cases', { idea: '   ' });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'validation_failed' } });
    expect((response.body as { error: { details: unknown[] } }).error.details.length).toBeGreaterThan(0);
  });

  it('rejects a body that is not JSON', async () => {
    const response = await call('/api/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toHaveProperty('error');
  });

  it('404s on a case that does not exist', async () => {
    const response = await call('/api/cases/8d1a0a8e-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('runs the full create → turn → review → accept → version cycle', async () => {
    const created = await post('/api/cases', {
      idea: 'A balcony greenhouse that waters itself.',
    });
    expect(created.status).toBe(201);
    const ideaCase = (created.body as { case: IdeaCase }).case;
    expect(ideaCase.original_idea).toBe('A balcony greenhouse that waters itself.');
    expect(ideaCase.version_history).toHaveLength(1);

    // --- a turn, left pending for review (the default) --------------------
    const turn = await post(`/api/cases/${ideaCase.id}/turns`, {
      message: 'A balcony greenhouse that waters itself.',
    });
    expect(turn.status).toBe(200);

    const turnBody = turn.body as {
      case: IdeaCase;
      reply: string;
      changeset: ChangeSet | null;
      degraded: boolean;
      plan: { stages: string[] };
    };
    expect(turnBody.degraded).toBe(false);
    expect(turnBody.reply.length).toBeGreaterThan(0);
    expect(turnBody.plan.stages).toContain('understand');
    expect(turnBody.changeset?.status).toBe('pending');

    // Nothing is applied before review.
    expect(turnBody.case.requirements).toHaveLength(0);
    expect(turnBody.case.version_history).toHaveLength(1);
    expect(turnBody.case.conversation.length).toBeGreaterThanOrEqual(2);

    const changeset = turnBody.changeset as ChangeSet;
    expect(changeset.entries.length).toBeGreaterThan(0);
    expect(changeset.entries.every((entry) => entry.label.length > 0)).toBe(true);

    // --- accept part of it ------------------------------------------------
    const requirementEntry = changeset.entries.find(
      (entry) => entry.operation.op === 'add' && entry.operation.collection === 'requirements',
    );
    const assumptionEntry = changeset.entries.find(
      (entry) => entry.operation.op === 'add' && entry.operation.collection === 'assumptions',
    );
    expect(requirementEntry).toBeDefined();
    expect(assumptionEntry).toBeDefined();

    const decision = await post(
      `/api/cases/${ideaCase.id}/changesets/${changeset.id}/decision`,
      { acceptedEntryIds: [requirementEntry!.id] },
    );
    expect(decision.status).toBe(200);

    const decided = decision.body as { case: IdeaCase; changeset: ChangeSet; version: unknown };
    expect(decided.changeset.status).toBe('partially_accepted');
    expect(decided.case.requirements).toHaveLength(1);
    expect(decided.case.assumptions).toHaveLength(0);
    expect(decided.case.version_history).toHaveLength(2);
    expect(decided.version).not.toBeNull();

    // The accepted requirement came from the user's own words, so it is
    // `known` rather than a model suggestion.
    expect(decided.case.requirements[0]?.epistemic_status).toBe('known');

    // --- the version is inspectable --------------------------------------
    const versions = await call(`/api/cases/${ideaCase.id}/versions`);
    expect(versions.status).toBe(200);
    const versionList = (versions.body as { versions: { index: number; changes: unknown[] }[] })
      .versions;
    expect(versionList).toHaveLength(2);
    expect(versionList[1]?.changes.length).toBeGreaterThan(0);

    const single = await call(`/api/cases/${ideaCase.id}/versions/1`);
    expect(single.status).toBe(200);
    expect(single.body).toHaveProperty('version.index', 1);

    expect((await call(`/api/cases/${ideaCase.id}/versions/99`)).status).toBe(404);

    // --- the case shows up in the list with its new version ---------------
    const list = await call('/api/cases');
    const summary = (list.body as { cases: { id: string; version: number }[] }).cases.find(
      (entry) => entry.id === ideaCase.id,
    );
    expect(summary?.version).toBe(1);

    // --- deletion ---------------------------------------------------------
    expect((await call(`/api/cases/${ideaCase.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/cases/${ideaCase.id}`)).status).toBe(404);
  });

  it('applies immediately when the caller opts into autoAccept', async () => {
    const created = await post('/api/cases', { idea: 'A rooftop rainwater collector.' });
    const ideaCase = (created.body as { case: IdeaCase }).case;

    const turn = await post(`/api/cases/${ideaCase.id}/turns`, {
      message: 'A rooftop rainwater collector that waters itself.',
      autoAccept: true,
    });

    const body = turn.body as { case: IdeaCase; changeset: ChangeSet };
    expect(body.changeset.status).toBe('accepted');
    expect(body.case.requirements.length).toBeGreaterThan(0);
    expect(body.case.version_history).toHaveLength(2);
  });

  it('rejects a decision that names no entries at all', async () => {
    const created = await post('/api/cases', { idea: 'A worm composter for a flat.' });
    const ideaCase = (created.body as { case: IdeaCase }).case;
    const turn = await post(`/api/cases/${ideaCase.id}/turns`, { message: 'A worm composter.' });
    const changeset = (turn.body as { changeset: ChangeSet }).changeset;

    const response = await post(
      `/api/cases/${ideaCase.id}/changesets/${changeset.id}/decision`,
      {},
    );
    expect(response.status).toBe(422);
  });

  it('rejects everything when an empty accept list is sent', async () => {
    const created = await post('/api/cases', { idea: 'A desk-sized hydroponics tray.' });
    const ideaCase = (created.body as { case: IdeaCase }).case;
    const turn = await post(`/api/cases/${ideaCase.id}/turns`, { message: 'A hydroponics tray.' });
    const changeset = (turn.body as { changeset: ChangeSet }).changeset;

    const response = await post(
      `/api/cases/${ideaCase.id}/changesets/${changeset.id}/decision`,
      { acceptedEntryIds: [] },
    );

    const body = response.body as { case: IdeaCase; changeset: ChangeSet; version: unknown };
    expect(body.changeset.status).toBe('rejected');
    expect(body.case.requirements).toHaveLength(0);
    // A fully rejected changeset must not create a version.
    expect(body.case.version_history).toHaveLength(1);
    expect(body.version).toBeNull();
  });

  it('404s when deciding a changeset that does not belong to the case', async () => {
    const created = await post('/api/cases', { idea: 'A seed-starting cabinet.' });
    const ideaCase = (created.body as { case: IdeaCase }).case;

    const response = await post(
      `/api/cases/${ideaCase.id}/changesets/cs-00000000/decision`,
      { acceptAll: true },
    );
    expect(response.status).toBe(404);
  });

  it('validates the research URL before touching the network', async () => {
    const created = await post('/api/cases', { idea: 'A mushroom fruiting chamber.' });
    const ideaCase = (created.body as { case: IdeaCase }).case;

    expect((await post(`/api/cases/${ideaCase.id}/research`, { url: 'not-a-url' })).status).toBe(422);

    const blocked = await post(`/api/cases/${ideaCase.id}/research`, {
      url: 'http://127.0.0.1:8787/api/capabilities',
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body).toMatchObject({ error: { code: 'bad_request' } });
  });
});

describe('credential handling', () => {
  it('never serialises a configured secret into the capabilities payload', async () => {
    const secret = 'sk-test-DO-NOT-LEAK-0123456789';
    const config = loadConfig({
      IDENO_STORE: 'memory',
      IDENO_SERVE_UI: '0',
      IDENO_LOG_LEVEL: 'error',
      IDENO_OPENAI_BASE_URL: 'https://api.example.test/v1',
      IDENO_OPENAI_MODEL: 'test-model',
      IDENO_OPENAI_API_KEY: secret,
      IDENO_PUTER_AUTH_TOKEN: 'puter-secret-token',
    });
    const services = buildServices(config, { store: new MemoryCaseStore(), logger: silentLogger });

    const server = createApp(services).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
      const text = await response.text();

      expect(text).not.toContain(secret);
      expect(text).not.toContain('puter-secret-token');

      const body = JSON.parse(text) as { config: Record<string, unknown>; ai: { ready: boolean } };
      // The fact that a key is set is reported, because the UI must be able
      // to tell "misconfigured" from "not configured".
      expect(body.config.openaiApiKeySet).toBe(true);
      expect(body.ai.ready).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('HTTP API without a provider', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    const config = loadConfig({ IDENO_STORE: 'memory', IDENO_SERVE_UI: '0', IDENO_LOG_LEVEL: 'error' });
    const services = buildServices(config, {
      store: new MemoryCaseStore(),
      logger: silentLogger,
      providers: [new ScriptedProvider({ id: 'off', configured: false, replies: {} })],
    });

    server = createApp(services).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('still creates and reads cases', async () => {
    const response = await fetch(`${origin}/api/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'A quiet indoor compost bin.' }),
    });
    expect(response.status).toBe(201);
  });

  it('explains that no provider is configured instead of failing opaquely', async () => {
    const created = await fetch(`${origin}/api/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idea: 'A solar herb dryer.' }),
    });
    const ideaCase = ((await created.json()) as { case: IdeaCase }).case;

    const turn = await fetch(`${origin}/api/cases/${ideaCase.id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Tell me more.' }),
    });

    expect(turn.status).toBe(503);
    const body = (await turn.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('provider_not_configured');

    // The failed turn is still recorded, and the state is not corrupted.
    const after = await fetch(`${origin}/api/cases/${ideaCase.id}`);
    const state = ((await after.json()) as { case: IdeaCase }).case;
    expect(state.version_history).toHaveLength(1);
    expect(state.conversation.some((entry) => entry.role === 'user')).toBe(true);
  });

  it('reports aiReady false', async () => {
    const response = await fetch(`${origin}/api/health`);
    expect(await response.json()).toMatchObject({ aiReady: false });
  });
});
