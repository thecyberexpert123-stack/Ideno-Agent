/**
 * Provider settings — the half of configuration that knows providers exist.
 *
 * This lives in `src/ai`, not `src/core`, so that the rule "Ideno Core contains no
 * provider-specific logic" is literally checkable: `grep -i puter src/core` returns
 * nothing. `BehaviourSettings` (in `core/schemas/settings.ts`) is the part the
 * orchestrator reads; this file extends it with what the adapters need.
 *
 * The one secret in the system — an OpenAI-compatible API key — is only written to
 * storage when the user explicitly opts in, because anything in `localStorage` is
 * readable by every script on the same origin.
 */
import { z } from 'zod';

import { BehaviourSettingsSchema } from '../core/schemas/settings.js';

export const ProviderIdSchema = z.enum(['puter', 'openai_compatible', 'scripted']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const OpenAiCompatibleSettingsSchema = z.object({
  base_url: z.string().trim().max(400).default(''),
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
export type OpenAiCompatibleSettings = z.infer<typeof OpenAiCompatibleSettingsSchema>;

/**
 * Which automated research sources are switched on.
 *
 * This lives in `src/ai` rather than `core/schemas/settings.ts` because one of the
 * two is provider-specific, and `src/core` is not allowed to know that any provider
 * exists — a rule the architecture tests enforce by reading the sources.
 *
 * Both default the way they do for a reason:
 *  - **Wikipedia on.** It needs no account and no key, so it is the only source that
 *    works the moment Ideno is opened. It does send the research question to a third
 *    party, which the Settings panel says in terms.
 *  - **Puter web search off.** It only produces anything when the provider is Puter,
 *    the user is signed in, and the model is routed to OpenAI — and when it produces
 *    nothing it must not be allowed to look like a failure of the question.
 */
export const ResearchSourceSettingsSchema = z.object({
  wikipedia: z.boolean().default(true),
  puter_web_search: z.boolean().default(false),
});
export type ResearchSourceSettings = z.infer<typeof ResearchSourceSettingsSchema>;

export const SettingsSchema = BehaviourSettingsSchema.extend({
  provider_id: ProviderIdSchema.default('puter'),
  /** Null means "use the provider's own default model". */
  puter_model: z.string().trim().max(160).nullable().default(null),
  openai: OpenAiCompatibleSettingsSchema.default({
    base_url: '',
    model: '',
    json_mode: false,
    persist_api_key: false,
  }),
  research: ResearchSourceSettingsSchema.default({
    wikipedia: true,
    puter_web_search: false,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Settings as persisted — the API key is present only when the user opted in. */
export const PersistedSettingsSchema = SettingsSchema.extend({
  openai_api_key: z.string().max(400).nullable().default(null),
});
export type PersistedSettings = z.infer<typeof PersistedSettingsSchema>;

export const SETTINGS_STORAGE_KEY = 'ideno.settings.v1';
