import { resolve } from 'node:path';
import { z } from 'zod';
import type { LogLevel } from '../core/logger.js';

/**
 * Environment configuration.
 *
 * Parsed and validated once at startup so a typo fails immediately with a
 * clear message rather than at the first model call. Credentials are read
 * here and never leave the server process: the browser client has no provider
 * configuration at all.
 */

const BooleanFromEnv = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()));

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(8787),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  storeKind: z.enum(['file', 'memory']).default('file'),
  dataDir: z.string().default('data/cases'),

  defaultProviderId: z.string().optional(),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(600_000).default(90_000),
  maxAttempts: z.coerce.number().int().min(1).max(5).default(2),

  openaiBaseUrl: z.string().optional(),
  openaiApiKey: z.string().optional(),
  openaiModel: z.string().optional(),
  openaiResponseFormat: z.enum(['json_object', 'json_schema', 'none']).default('json_object'),
  openaiTokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),

  puterAuthToken: z.string().optional(),
  puterModel: z.string().optional(),

  researchEnabled: z.boolean().default(true),
  /** Only for local testing against a private address. Off by default. */
  researchAllowPrivateAddresses: z.boolean().default(false),

  /** Directory of the built client, served in production. */
  uiDir: z.string().default('dist/ui'),
  serveUi: z.boolean().default(true),
});

export type IdenoConfig = z.infer<typeof ConfigSchema> & {
  readonly resolvedDataDir: string;
  readonly resolvedUiDir: string;
};

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const trimmed = optional(value);
  if (trimmed === undefined) return fallback;
  return BooleanFromEnv.parse(trimmed);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IdenoConfig {
  const parsed = ConfigSchema.safeParse({
    port: optional(env.IDENO_PORT),
    host: optional(env.IDENO_HOST),
    logLevel: optional(env.IDENO_LOG_LEVEL) as LogLevel | undefined,

    storeKind: optional(env.IDENO_STORE),
    dataDir: optional(env.IDENO_DATA_DIR),

    defaultProviderId: optional(env.IDENO_AI_PROVIDER),
    requestTimeoutMs: optional(env.IDENO_REQUEST_TIMEOUT_MS),
    maxAttempts: optional(env.IDENO_AI_MAX_ATTEMPTS),

    openaiBaseUrl: optional(env.IDENO_OPENAI_BASE_URL),
    openaiApiKey: optional(env.IDENO_OPENAI_API_KEY),
    openaiModel: optional(env.IDENO_OPENAI_MODEL),
    openaiResponseFormat: optional(env.IDENO_OPENAI_RESPONSE_FORMAT),
    openaiTokenLimitField: optional(env.IDENO_OPENAI_TOKEN_LIMIT_FIELD),

    puterAuthToken: optional(env.IDENO_PUTER_AUTH_TOKEN),
    puterModel: optional(env.IDENO_PUTER_MODEL),

    researchEnabled: flag(env.IDENO_RESEARCH_ENABLED, true),
    researchAllowPrivateAddresses: flag(env.IDENO_RESEARCH_ALLOW_PRIVATE_ADDRESSES, false),

    uiDir: optional(env.IDENO_UI_DIR),
    serveUi: flag(env.IDENO_SERVE_UI, true),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid Ideno configuration:\n${issues}`);
  }

  return {
    ...parsed.data,
    resolvedDataDir: resolve(process.cwd(), parsed.data.dataDir),
    resolvedUiDir: resolve(process.cwd(), parsed.data.uiDir),
  };
}

/** Redacted view of the configuration, safe to log and to expose over the API. */
export function describeConfig(config: IdenoConfig): Record<string, unknown> {
  return {
    port: config.port,
    host: config.host,
    store: config.storeKind,
    dataDir: config.storeKind === 'file' ? config.resolvedDataDir : null,
    defaultProvider: config.defaultProviderId ?? null,
    requestTimeoutMs: config.requestTimeoutMs,
    research: config.researchEnabled,
    openaiConfigured: Boolean(config.openaiBaseUrl && config.openaiModel),
    openaiApiKeySet: Boolean(config.openaiApiKey),
    puterConfigured: Boolean(config.puterAuthToken),
  };
}
