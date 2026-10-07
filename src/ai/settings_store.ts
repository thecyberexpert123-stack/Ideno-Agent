/**
 * Settings persistence.
 *
 * Lives beside the provider settings it stores, in the AI layer, because reading
 * and writing them is a provider-configuration concern. The workspace itself is
 * persisted by the State Manager and never contains a key.
 *
 * ## Secrets
 *
 * Three secrets can exist: a legacy single API key, one key per custom agent, and a
 * Tavily key. Each is written to storage **only** when the user has opted into
 * persisting it, and each is stripped on save when they have not — the opt-in is
 * enforced here rather than trusted to the caller, because a UI that forgets to check
 * would silently write a secret to disk.
 *
 * ## Migration
 *
 * A stored v0.2 configuration has `openai` and `openai_api_key` and no `agents`. On
 * load that is folded into a single agent profile by `migrateSettings`, and on the next
 * save the legacy key slot is written back as null so the secret lives in exactly one
 * place. Loading is idempotent: migrating twice cannot duplicate a profile.
 */
import { formatZodIssuesInline } from '../core/schemas/index.js';
import type { Store } from '../core/state_manager/store.js';
import {
  PersistedSettingsSchema,
  SETTINGS_STORAGE_KEY,
  SettingsSchema,
  activeAgent,
  migrateSettings,
  type PersistedSettings,
  type Settings,
} from './settings.js';

export { SETTINGS_STORAGE_KEY };

/**
 * Secrets handed to `saveSettings`.
 *
 * Every field is optional, and a missing field means "leave whatever is stored alone"
 * only for keys the caller does not manage — see the note in `saveSettings`, because
 * the distinction between "not supplied" and "supplied as null" is the one that decides
 * whether an in-memory key survives a save that did not touch it.
 */
export interface SettingsSecrets {
  /** Legacy single-endpoint key. Applied to the active agent. */
  apiKey?: string | null;
  /** Per-agent keys, by agent id. A null value clears that agent's stored key. */
  agentApiKeys?: Record<string, string | null>;
  tavilyApiKey?: string | null;
}

export interface LoadedSettings {
  settings: Settings;
  /**
   * The active agent's key, present in memory only unless persistence was opted into.
   * Kept as a top-level field so callers that manage one endpoint need not know about
   * the profile list.
   */
  apiKey: string | null;
  /** Every persisted agent key, by agent id. */
  agentApiKeys: Record<string, string>;
  /** Present only when persisting the Tavily key was opted into. */
  tavilyApiKey: string | null;
  /** Set when stored settings were unreadable and defaults were used. */
  warning: string | null;
}

export function loadSettings(store: Store, key: string = SETTINGS_STORAGE_KEY): LoadedSettings {
  const empty: LoadedSettings = {
    settings: SettingsSchema.parse({}),
    apiKey: null,
    agentApiKeys: {},
    tavilyApiKey: null,
    warning: null,
  };

  const raw = safeRead(store, key);
  if (raw === null) return empty;

  const parsed = PersistedSettingsSchema.safeParse(safeJsonParse(raw));
  if (!parsed.success) {
    return {
      ...empty,
      warning: `Stored settings could not be read (${formatZodIssuesInline(parsed.error, 1)}); defaults were used.`,
    };
  }

  // `persist_tavily_api_key` is deliberately NOT destructured out: it is part of
  // `Settings`, so removing it here would drop the user's preference and let the schema
  // default silently replace it on every load.
  const { openai_api_key, agent_api_keys, tavily_api_key, ...rest } = parsed.data;

  // A profile list that fails to parse must not take the rest of the settings with it,
  // but neither should it be silently dropped: a user who saved four agents and gets
  // back none deserves to be told.
  const baseSettings = SettingsSchema.safeParse(rest);
  if (!baseSettings.success) {
    return {
      ...empty,
      warning: `Stored settings could not be read (${formatZodIssuesInline(baseSettings.error, 1)}); defaults were used.`,
    };
  }

  const migrated = migrateSettings(baseSettings.data, openai_api_key);
  const settings = migrated.settings;

  // Keys a profile is not allowed to persist are dropped even if storage holds them —
  // a user who switched persistence off must not find the key still being read back.
  const agentApiKeys: Record<string, string> = {};
  const storedKeys = { ...agent_api_keys, ...migrated.agentApiKeys };
  for (const agent of settings.agents) {
    const stored = storedKeys[agent.id];
    if (agent.persist_api_key && typeof stored === 'string' && stored.length > 0) {
      agentApiKeys[agent.id] = stored;
    }
  }

  const active = activeAgent(settings);
  const apiKey = active ? agentApiKeys[active.id] ?? null : null;
  const tavilyApiKey =
    settings.persist_tavily_api_key && typeof tavily_api_key === "string" && tavily_api_key.length > 0
      ? tavily_api_key
      : null;

  return { settings, apiKey, agentApiKeys, tavilyApiKey, warning: null };
}

/**
 * Writes settings plus whichever secrets the caller supplied.
 *
 * `secrets` accepts the legacy `string | null` form so existing callers keep working,
 * and the richer `SettingsSecrets` object for callers that manage several agents.
 *
 * The rule that keeps this honest: a key is stored **only** if its owner has opted into
 * persistence. An agent with `persist_api_key: false` contributes nothing to the written
 * document no matter what the caller passes, and the same applies to Tavily.
 */
export function saveSettings(
  store: Store,
  settings: Settings,
  secrets: string | null | SettingsSecrets = null,
  key: string = SETTINGS_STORAGE_KEY,
): { saved: boolean; reason?: string } {
  const normalised = typeof secrets === 'string' || secrets === null ? { apiKey: secrets } : secrets;

  // Start from what is already allowed to be stored, then apply what the caller supplied.
  // Without this, saving from a panel that only edits one agent would erase the keys of
  // every other agent — a data loss bug that is invisible until somebody switches profiles.
  const existing = safeReadPersistedKeys(store, key);
  const mergedKeys: Record<string, string> = { ...existing.agentApiKeys };

  if (normalised.agentApiKeys) {
    for (const [agentId, value] of Object.entries(normalised.agentApiKeys)) {
      if (typeof value === 'string' && value.length > 0) mergedKeys[agentId] = value;
      else delete mergedKeys[agentId];
    }
  }
  if (normalised.apiKey !== undefined) {
    const active = activeAgent(settings);
    if (active) {
      if (typeof normalised.apiKey === 'string' && normalised.apiKey.length > 0) {
        mergedKeys[active.id] = normalised.apiKey;
      } else {
        delete mergedKeys[active.id];
      }
    }
  }

  // Strip anything whose owner has not opted into persistence.
  const agentApiKeys: Record<string, string> = {};
  for (const agent of settings.agents) {
    const stored = mergedKeys[agent.id];
    if (agent.persist_api_key && stored) agentApiKeys[agent.id] = stored;
  }

  const tavilyKey =
    normalised.tavilyApiKey !== undefined ? normalised.tavilyApiKey : existing.tavilyApiKey;

  const payload: PersistedSettings = {
    ...settings,
    // Cleared on every save: the legacy slot is read once by the migration and must not
    // keep a second copy of a secret that now belongs to a profile.
    openai_api_key: null,
    agent_api_keys: agentApiKeys,
    tavily_api_key: settings.persist_tavily_api_key ? tavilyKey : null,
    persist_tavily_api_key: settings.persist_tavily_api_key,
  };

  const parsed = PersistedSettingsSchema.safeParse(payload);
  if (!parsed.success) {
    return { saved: false, reason: `Settings are not valid: ${formatZodIssuesInline(parsed.error, 1)}` };
  }
  try {
    store.write(key, JSON.stringify(parsed.data));
    return { saved: true };
  } catch (error) {
    return { saved: false, reason: `Settings could not be saved (${messageOf(error)}).` };
  }
}

/** Reads back only the secrets already in storage, so a partial save cannot drop them. */
function safeReadPersistedKeys(
  store: Store,
  key: string,
): { agentApiKeys: Record<string, string>; tavilyApiKey: string | null } {
  const raw = safeRead(store, key);
  if (raw === null) return { agentApiKeys: {}, tavilyApiKey: null };
  const parsed = PersistedSettingsSchema.safeParse(safeJsonParse(raw));
  if (!parsed.success) return { agentApiKeys: {}, tavilyApiKey: null };
  return {
    agentApiKeys: { ...parsed.data.agent_api_keys },
    tavilyApiKey: parsed.data.tavily_api_key,
  };
}

function safeRead(store: Store, key: string): string | null {
  try {
    return store.read(key);
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}
