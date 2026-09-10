import { z } from "zod";

/**
 * Environment configuration with per-feature validation.
 *
 * Core vars are validated eagerly on first access. Feature-specific groups
 * (Meta, AI, email) are validated lazily by their accessors so the app can
 * boot and clearly tell the admin which feature is unconfigured instead of
 * crashing everything.
 */

const coreSchema = z.object({
  APP_URL: z.string().url().transform((u) => u.replace(/\/$/, "")),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const metaSchema = z.object({
  META_APP_ID: z.string().min(1, "META_APP_ID missing"),
  META_APP_SECRET: z.string().min(1, "META_APP_SECRET missing"),
  META_REDIRECT_URI: z.string().url("META_REDIRECT_URI must be a URL"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8, "META_WEBHOOK_VERIFY_TOKEN too short (min 8 chars)"),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
});

const emailSchema = z.object({
  EMAIL_HOST: z.string().min(1, "EMAIL_HOST missing"),
  EMAIL_PORT: z.coerce.number().int().positive().default(587),
  EMAIL_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  EMAIL_USER: z.string().min(1, "EMAIL_USER missing"),
  EMAIL_PASSWORD: z.string().min(1, "EMAIL_PASSWORD missing"),
  EMAIL_FROM: z.string().min(3, "EMAIL_FROM missing"),
  LEAD_NOTIFICATION_EMAIL: z.string().email("LEAD_NOTIFICATION_EMAIL must be an email"),
});

export class ConfigError extends Error {
  readonly feature: string;
  constructor(feature: string, details: string) {
    super(`${feature} is not configured: ${details}`);
    this.name = "ConfigError";
    this.feature = feature;
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, feature: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues.map((i) => i.message).join("; ");
    throw new ConfigError(feature, details);
  }
  return result.data;
}

let coreCache: z.infer<typeof coreSchema> | null = null;

export function coreEnv() {
  if (!coreCache) coreCache = parse(coreSchema, "Core environment");
  return coreCache;
}

/** Test hook: drop the cached core env so a changed process.env is re-read. */
export function _resetCoreEnvCache() {
  coreCache = null;
}

export function metaEnv() {
  return parse(metaSchema, "Meta integration");
}

export function emailEnv() {
  return parse(emailSchema, "Email (SMTP)");
}

/** Non-throwing check — used by health/capability endpoints. */
export function isMetaConfigured(): boolean {
  return metaSchema.safeParse(process.env).success;
}

export function isEmailConfigured(): boolean {
  return emailSchema.safeParse(process.env).success;
}

export type AIProviderName = "anthropic" | "openai" | "google";

/** Resolve the API key for a given provider, falling back to AI_API_KEY when it is the default provider. */
export function aiKeyFor(provider: AIProviderName): string | null {
  const specific = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GOOGLE_AI_API_KEY,
  }[provider];
  if (specific) return specific;
  const def = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  if (def === provider && process.env.AI_API_KEY) return process.env.AI_API_KEY;
  return null;
}

export function defaultAiProvider(): AIProviderName {
  const p = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  return p === "openai" || p === "google" ? p : "anthropic";
}

export function embeddingConfig(): { provider: "openai" | "google"; apiKey: string } | null {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "none").toLowerCase();
  if (provider !== "openai" && provider !== "google") return null;
  const apiKey =
    process.env.EMBEDDING_API_KEY ?? aiKeyFor(provider) ?? undefined;
  if (!apiKey) return null;
  return { provider, apiKey };
}

export const isProd = () => coreEnv().NODE_ENV === "production";
export const isDev = () => coreEnv().NODE_ENV === "development";
