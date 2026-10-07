/**
 * Settings persistence.
 *
 * Lives beside the provider settings it stores, in the AI layer, because reading
 * and writing them is a provider-configuration concern. The workspace itself is
 * persisted by the State Manager and never contains a key.
 */
import { formatZodIssuesInline } from '../core/schemas/index.js';
import type { Store } from '../core/state_manager/store.js';
import {
  PersistedSettingsSchema,
  SETTINGS_STORAGE_KEY,
  SettingsSchema,
  type PersistedSettings,
  type Settings,
} from './settings.js';

export { SETTINGS_STORAGE_KEY };

export interface LoadedSettings {
  settings: Settings;
  /** Present in memory only unless the user opted into persisting it. */
  apiKey: string | null;
  /** Set when stored settings were unreadable and defaults were used. */
  warning: string | null;
}

export function loadSettings(store: Store, key: string = SETTINGS_STORAGE_KEY): LoadedSettings {
  const raw = safeRead(store, key);
  if (raw === null) return { settings: SettingsSchema.parse({}), apiKey: null, warning: null };

  const parsed = PersistedSettingsSchema.safeParse(safeJsonParse(raw));
  if (!parsed.success) {
    return {
      settings: SettingsSchema.parse({}),
      apiKey: null,
      warning: `Stored settings could not be read (${formatZodIssuesInline(parsed.error, 1)}); defaults were used.`,
    };
  }

  const { openai_api_key, ...rest } = parsed.data;
  const settings = SettingsSchema.parse(rest);
  const keyAllowed = settings.openai.persist_api_key && typeof openai_api_key === 'string';
  return { settings, apiKey: keyAllowed && openai_api_key ? openai_api_key : null, warning: null };
}

export function saveSettings(
  store: Store,
  settings: Settings,
  apiKey: string | null,
  key: string = SETTINGS_STORAGE_KEY,
): { saved: boolean; reason?: string } {
  const payload: PersistedSettings = {
    ...settings,
    openai_api_key: settings.openai.persist_api_key ? apiKey : null,
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
