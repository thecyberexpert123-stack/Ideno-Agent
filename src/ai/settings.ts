/**
 * Provider settings — the half of configuration that knows providers exist.
 *
 * This lives in `src/ai`, not `src/core`, so that the rule "Ideno Core contains no
 * provider-specific logic" is literally checkable: `grep -i puter src/core` returns
 * nothing. `BehaviourSettings` (in `core/schemas/settings.ts`) is the part the
 * orchestrator reads; this file extends it with what the adapters need.
 *
 * ## Secrets
 *
 * Two secrets can exist: an agent's API key and a Tavily key. Neither is written to
 * storage unless the user explicitly opts in, because anything in `localStorage` is
 * readable by every script on the same origin. Both are optional — an agent with no
 * key is a legitimate configuration (a local model server needs none), and Tavily
 * simply does not run without one.
 *
 * ## Custom agents
 *
 * `agents` is a list of named OpenAI-compatible profiles and `active_agent_id` selects
 * one. The older single `openai` object is still accepted and is folded into the list
 * by `migrateSettings`, so a stored v0.2 configuration keeps working unchanged.
 */
import { z } from 'zod';

import { BehaviourSettingsSchema } from '../core/schemas/settings.js';

export const ProviderIdSchema = z.enum(['puter', 'openai_compatible', 'scripted']);
export type ProviderId = z.infer<typeof ProviderIdSchema>

/** Hard cap on saved agent profiles. A list without a ceiling is a list that grows. */
export const MAX_AGENT_PROFILES = 12;

/**
 * One custom agent: an OpenAI-compatible endpoint plus how Ideno should talk to it.
 *
 * `base_url` and `model` are the only fields that matter for a call, and both may be
 * empty in storage — an unfinished profile is normal while somebody is setting one up.
 * Whether a profile is *usable* is decided by `validateConfig` in the provider, not by
 * this schema: the schema checks shape, the provider checks readiness. That split is
 * deliberate, and is the same one the research sources use.
 */
export const AgentProfileSchema = z.object({
  /** Stable identity, minted by `newAgentId`. Never shown to the user. */
  id: z.string().trim().min(1).max(40),
  /** What the user calls it: "Local llama.cpp", "OpenRouter", "Work vLLM". */
  name: z.string().trim().min(1).max(80),
  /** e.g. `https://openrouter.ai/api/v1` or `http://127.0.0.1:8080/v1`. */
  base_url: z.string().trim().max(400).default(''),
  /** May be empty until models are discovered from the endpoint. */
  model: z.string().trim().max(160).default(''),
  /**
   * Whether the endpoint implements `response_format: { type: "json_object" }`.
   * Off by default because it is not universal across OpenAI-compatible servers,
   * and Ideno validates the output either way.
   */
  json_mode: z.boolean().default(false),
  /**
   * Persisting a browser-side API key means any script on this origin can read it.
   * Off by default; the key then lives in memory for this tab only.
   */
  persist_api_key: z.boolean().default(false),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * The legacy single-endpoint settings, kept so a stored v0.2 configuration still
 * parses. New writes go through `agents`; this object is read only by `migrateSettings`.
 */
export const OpenAiCompatibleSettingsSchema = z.object({
  base_url: z.string().trim().max(400).default(''),
  model: z.string().trim().max(160).default(''),
  json_mode: z.boolean().default(false),
  persist_api_key: z.boolean().default(false),
});
export type OpenAiCompatibleSettings = z.infer<typeof OpenAiCompatibleSettingsSchema>;

/**
 * Which automated research sources are switched on.
 *
 * This lives in `src/ai` rather than `core/schemas/settings.ts` because two of the
 * three are provider- or vendor-specific, and `src/core` is not allowed to know that
 * any provider exists — a rule the architecture tests enforce by reading the sources.
 *
 * Each default has a reason:
 *  - **Wikipedia on.** No account, no key, so it works the moment Ideno is opened. It
 *    does send the question to a third party, which the Settings panel says in terms.
 *  - **Puter web search off.** Only produces anything when the provider is Puter, the
 *    user is signed in, and the model is OpenAI-routed.
 *  - **Tavily off.** It needs a paid key, so switching it on by default would make the
 *    first research turn fail for anybody who has not signed up.
 */
export const ResearchSourceSettingsSchema = z.object({
  wikipedia: z.boolean().default(true),
  puter_web_search: z.boolean().default(false),
  tavily: z.boolean().default(false),
});
export type ResearchSourceSettings = z.infer<typeof ResearchSourceSettingsSchema>;

export const SettingsSchema = BehaviourSettingsSchema.extend({
  provider_id: ProviderIdSchema.default('puter'),
  /** Null means "use the provider's own default model". */
  puter_model: z.string().trim().max(160).nullable().default(null),
  /** Legacy single endpoint. Superseded by `agents`; see `migrateSettings`. */
  openai: OpenAiCompatibleSettingsSchema.default({
    base_url: '',
    model: '',
    json_mode: false,
    persist_api_key: false,
  }),
  /** Named custom agent profiles, all OpenAI-compatible. */
  agents: z.array(AgentProfileSchema).max(MAX_AGENT_PROFILES).default([]),
  /** Which profile is live. Null means "the first one", resolved by `activeAgent`. */
  active_agent_id: z.string().trim().max(40).nullable().default(null),
  research: ResearchSourceSettingsSchema.default({
    wikipedia: true,
    puter_web_search: false,
    tavily: false,
  }),
  /**
   * Whether the Tavily key may be written to storage.
   *
   * Sits here rather than on `PersistedSettingsSchema` because it is a preference the UI
   * edits and the store enforces — the same shape as an agent's `persist_api_key`. A flag
   * that only existed in the persisted form could not be read from a `Settings` value,
   * which is what the save path has to consult.
   */
  persist_tavily_api_key: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Settings as persisted.
 *
 * Both secret maps are keyed by agent id, and a key appears in `agent_api_keys` only
 * when that profile has `persist_api_key` set. `openai_api_key` is the legacy slot,
 * read once by `migrateSettings` and then written back as null.
 */
export const PersistedSettingsSchema = SettingsSchema.extend({
  /** Legacy slot. Read once by `migrateSettings`, then written back as null. */
  openai_api_key: z.string().max(400).nullable().default(null),
  /** Persisted agent keys, by agent id. Only profiles that opted in appear here. */
  agent_api_keys: z.record(z.string().max(40), z.string().max(400)).default({}),
  tavily_api_key: z.string().max(400).nullable().default(null),
});
export type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;

export const SETTINGS_STORAGE_KEY = 'ideno.settings.v1';

/** Creates a profile id. Exported so the UI and tests mint ids the same way. */
export function newAgentId(random: Pick<Crypto, 'randomUUID'> = globalThis.crypto): string {
  return `agent_${random.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * The profile a call should use.
 *
 * Falls back to the first profile when `active_agent_id` names one that no longer
 * exists — a stale pointer must not leave the provider with no configuration, because
 * deleting a profile is not the same act as asking Ideno to stop working.
 */
export function activeAgent(settings: Settings): AgentProfile | null {
  if (settings.agents.length === 0) return null;
  const wanted = settings.active_agent_id;
  if (wanted) {
    const found = settings.agents.find((agent) => agent.id === wanted);
    if (found) return found;
  }
  return settings.agents[0] ?? null;
}

/**
 * Folds the legacy single endpoint into the agent list.
 *
 * Idempotent: once `agents` is non-empty this returns its input untouched, so loading
 * settings twice cannot duplicate a profile. Runs on every load rather than as a
 * stored-format bump, because the legacy shape has to keep parsing for as long as any
 * user's browser still holds one.
 *
 * The legacy API key travels with the profile it belonged to, and only if that profile
 * had opted into persisting it — migrating a secret into storage that did not already
 * hold it would be a quiet change to a security decision somebody else made.
 */
export function migrateSettings(settings: Settings, legacyApiKey: string | null): {
  settings: Settings;
  agentApiKeys: Record<string, string>;
} {
  if (settings.agents.length > 0) return { settings, agentApiKeys: {} };

  const legacy = settings.openai;
  if (!legacy.base_url && !legacy.model) return { settings, agentApiKeys: {} };

  const id = newAgentId();
  const profile = AgentProfileSchema.parse({
    id,
    name: describeLegacyAgent(legacy.base_url),
    base_url: legacy.base_url,
    model: legacy.model,
    json_mode: legacy.json_mode,
    persist_api_key: legacy.persist_api_key,
  });

  const next: Settings = {
    ...settings,
    agents: [profile],
    active_agent_id: id,
    // Cleared so a second migration cannot re-read it, and so the secret lives in
    // exactly one place.
    openai: OpenAiCompatibleSettingsSchema.parse({}),
  };
  const agentApiKeys =
    legacy.persist_api_key && legacyApiKey ? { [id]: legacyApiKey } : {};
  return { settings: next, agentApiKeys };
}

/** Names a migrated profile after its host, which is the part a user recognises. */
export function describeLegacyAgent(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || 'Custom agent';
  } catch {
    return 'Custom agent';
  }
}
