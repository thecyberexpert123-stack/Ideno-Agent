import type { ChangeSet, IdeaCase, VersionRecord } from '../core/schemas.js';
import type { ProviderDescription } from '../ai/types.js';
import type { PluginDescriptor } from '../plugins/registry.js';
import type { CaseSummary } from '../core/store/store.js';
import type { StageFailure, TurnPlan } from '../core/orchestrator.js';
import type { VersionChange } from '../core/versioning.js';

/**
 * Typed client for the Ideno API.
 *
 * Types are imported from the server modules as types only, so the client and
 * the API cannot drift: a change to the Idea State schema fails the client
 * type-check. Nothing from those modules is bundled.
 */

export interface StateSummaryDto {
  requirements: number;
  assumptions: number;
  constraints: number;
  unknowns: number;
  evidence: number;
  alternatives: number;
  decisions: number;
  openQuestions: number;
  invalidated: number;
  version: number;
  pendingChangeSets: number;
}

export interface Capabilities {
  version: string;
  config: Record<string, unknown>;
  ai: {
    ready: boolean;
    activeProvider: string | null;
    providers: ProviderDescription[];
  };
  plugins: PluginDescriptor[];
}

export interface TurnResponse {
  case: IdeaCase;
  summary: StateSummaryDto;
  reply: string;
  changeset: ChangeSet | null;
  plan: TurnPlan;
  degraded: boolean;
  failures: StageFailure[];
  question: { id: string; text: string } | null;
}

export interface DecisionResponse {
  case: IdeaCase;
  summary: StateSummaryDto;
  changeset: ChangeSet;
  version: VersionRecord | null;
}

export interface ResearchResponse {
  case: IdeaCase;
  summary: StateSummaryDto;
  changeset: ChangeSet | null;
  sourceTitle: string | null;
  claimsAccepted: number;
  claimsRejected: number;
  answersQuestion: boolean;
  researchSummary: string;
  warnings: string[];
}

export interface VersionWithChanges extends VersionRecord {
  changes: VersionChange[];
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new ApiError({
      code: 'network_error',
      message: 'The Ideno server is unreachable. Is it running?',
      status: 0,
      retryable: true,
      details: error,
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } })
      ?.error;
    throw new ApiError({
      code: error?.code ?? 'internal_error',
      message: error?.message ?? `Request failed with HTTP ${response.status}.`,
      status: response.status,
      retryable: error?.retryable ?? false,
      details: error?.details,
    });
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: 'internal_error', message: text.slice(0, 300) } };
  }
}

export const api = {
  capabilities: () => request<Capabilities>('/capabilities'),

  listCases: () => request<{ cases: CaseSummary[] }>('/cases'),

  createCase: (idea: string) =>
    request<{ case: IdeaCase; summary: StateSummaryDto }>('/cases', {
      method: 'POST',
      body: JSON.stringify({ idea }),
    }),

  getCase: (caseId: string) => request<{ case: IdeaCase; summary: StateSummaryDto }>(`/cases/${caseId}`),

  deleteCase: (caseId: string) => request<void>(`/cases/${caseId}`, { method: 'DELETE' }),

  sendTurn: (caseId: string, message: string, autoAccept: boolean) =>
    request<TurnResponse>(`/cases/${caseId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ message, autoAccept }),
    }),

  decideChangeSet: (
    caseId: string,
    changesetId: string,
    decision: { acceptAll?: boolean; acceptedEntryIds?: string[] },
  ) =>
    request<DecisionResponse>(`/cases/${caseId}/changesets/${changesetId}/decision`, {
      method: 'POST',
      body: JSON.stringify(decision),
    }),

  versions: (caseId: string) => request<{ versions: VersionWithChanges[] }>(`/cases/${caseId}/versions`),

  research: (caseId: string, input: { url: string; question?: string; researchItemId?: string }) =>
    request<ResearchResponse>(`/cases/${caseId}/research`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
