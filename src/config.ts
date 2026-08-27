import { z } from "zod";
import { assessReleaseMode } from "./governance/preProduction.js";

const nonEmpty = z.string().trim().min(1);

function parse<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv, label: string): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid ${label} configuration: ${fields}`);
  }
  return result.data;
}

const databaseSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty.min(20),
});

export function getDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(databaseSchema, env, "database");
  return {
    url: value.SUPABASE_URL,
    serviceRoleKey: value.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export const WHATSAPP_PROVIDERS = ["meta", "360dialog"] as const;
export type WhatsAppProvider = (typeof WHATSAPP_PROVIDERS)[number];

const whatsappProviderSchema = z.object({
  WHATSAPP_PROVIDER: z.enum(WHATSAPP_PROVIDERS).default("meta"),
});

export function getWhatsAppProviderConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(whatsappProviderSchema, env, "WhatsApp provider");
  return { provider: value.WHATSAPP_PROVIDER };
}

const webhookSchema = z.object({
  META_APP_SECRET: nonEmpty.min(16),
  WHATSAPP_VERIFY_TOKEN: nonEmpty.min(16),
});

export function getWebhookConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(webhookSchema, env, "Meta webhook");
  return {
    appSecret: value.META_APP_SECRET,
    verifyToken: value.WHATSAPP_VERIFY_TOKEN,
  };
}

const metaSchema = z.object({
  META_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/),
  WHATSAPP_ACCESS_TOKEN: nonEmpty.min(20),
  WHATSAPP_PHONE_NUMBER_ID: nonEmpty,
  WHATSAPP_BUSINESS_ACCOUNT_ID: nonEmpty,
});

export function getMetaConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(metaSchema, env, "Meta Cloud API");
  return {
    graphApiVersion: value.META_GRAPH_API_VERSION,
    accessToken: value.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: value.WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: value.WHATSAPP_BUSINESS_ACCOUNT_ID,
  };
}

function normalizeD360BaseUrl(value: string): string {
  const url = new URL(value);
  const allowedHosts = new Set([
    "waba-v2.360dialog.io",
    "waba-sandbox.360dialog.io",
  ]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error("Invalid 360dialog configuration: D360_API_BASE_URL");
  }
  return url.origin;
}

const d360Schema = z.object({
  D360_API_KEY: nonEmpty.min(20),
  D360_API_BASE_URL: z
    .string()
    .url()
    .default("https://waba-v2.360dialog.io"),
  D360_WEBHOOK_USERNAME: nonEmpty.min(3).max(64).default("hera-receptionist"),
  D360_WEBHOOK_PASSWORD: nonEmpty.min(24).max(256),
  D360_HUMAN_TAKEOVER_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(1440)
    .default(120),
});

export function getD360Config(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(d360Schema, env, "360dialog");
  return {
    apiKey: value.D360_API_KEY,
    baseUrl: normalizeD360BaseUrl(value.D360_API_BASE_URL),
    webhookUsername: value.D360_WEBHOOK_USERNAME,
    webhookPassword: value.D360_WEBHOOK_PASSWORD,
    humanTakeoverMinutes: value.D360_HUMAN_TAKEOVER_MINUTES,
  };
}

const aiSchema = z.object({
  HERA_AI_PRIMARY_MODEL: nonEmpty.default("openai/gpt-5.6-sol"),
  HERA_AI_FALLBACK_MODELS: z
    .string()
    .default("anthropic/claude-opus-5,openai/gpt-5.6-terra"),
  HERA_AI_VERIFIER_MODEL: nonEmpty.default("anthropic/claude-opus-5"),
  HERA_AI_TRANSCRIPTION_MODEL: nonEmpty.default("openai/gpt-4o-transcribe"),
});

export function getAiConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(aiSchema, env, "AI");
  const fallbackModels = value.HERA_AI_FALLBACK_MODELS.split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return {
    primaryModel: value.HERA_AI_PRIMARY_MODEL,
    fallbackModels,
    verifierModel: value.HERA_AI_VERIFIER_MODEL,
    transcriptionModel: value.HERA_AI_TRANSCRIPTION_MODEL,
  };
}

export const WHATSAPP_SEND_MODES = ["shadow", "pilot", "live"] as const;
export type WhatsAppSendMode = (typeof WHATSAPP_SEND_MODES)[number];

const operationsSchema = z.object({
  WHATSAPP_SEND_MODE: z.enum(WHATSAPP_SEND_MODES).default("shadow"),
  WHATSAPP_LIVE_CONFIRMATION: z.string().trim().optional(),
  WHATSAPP_PILOT_CONFIRMATION: z.string().trim().optional(),
  HERA_INTERNAL_PILOT_ALLOWLIST: z.string().trim().optional(),
  HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS: z.string().trim().optional(),
  HERA_MANAGEMENT_WHATSAPP_ID: z.string().trim().optional(),
  VERCEL_ENV: z.string().trim().optional(),
  VERCEL_GIT_COMMIT_REF: z.string().trim().optional(),
  CRON_SECRET: nonEmpty.min(24),
});

export const WHATSAPP_LIVE_CONFIRMATION_VALUE = "ENABLE_HERA_WHATSAPP_LIVE";
export const WHATSAPP_PILOT_CONFIRMATION_VALUE =
  "ENABLE_HERA_INTERNAL_PILOT";
export const HERA_INTERNAL_PILOT_BRANCH = "pilot/urgent-green-lane";
export const HERA_INTERNAL_PILOT_ID = "urgent-green-lane-2026-08-27";
export const HERA_INTERNAL_PILOT_MAX_ALLOWED_SEND_ATTEMPTS = 10;

function parseInternalPilotAllowlist(value: string | undefined): string[] {
  const waIds = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (
    waIds.length < 1 ||
    waIds.length > 5 ||
    waIds.some((waId) => !/^[1-9][0-9]{7,14}$/.test(waId)) ||
    new Set(waIds).size !== waIds.length
  ) {
    throw new Error(
      "Invalid operations configuration: HERA_INTERNAL_PILOT_ALLOWLIST",
    );
  }
  return waIds;
}

export function getOperationsConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(operationsSchema, env, "operations");

  if (value.WHATSAPP_SEND_MODE === "pilot") {
    if (
      value.WHATSAPP_PILOT_CONFIRMATION !==
      WHATSAPP_PILOT_CONFIRMATION_VALUE
    ) {
      throw new Error(
        "Invalid operations configuration: WHATSAPP_PILOT_CONFIRMATION",
      );
    }
    if (value.WHATSAPP_LIVE_CONFIRMATION) {
      throw new Error(
        "Invalid operations configuration: WHATSAPP_LIVE_CONFIRMATION",
      );
    }
    if (value.VERCEL_ENV !== "preview") {
      throw new Error("Invalid operations configuration: VERCEL_ENV");
    }
    if (value.VERCEL_GIT_COMMIT_REF !== HERA_INTERNAL_PILOT_BRANCH) {
      throw new Error(
        "Invalid operations configuration: VERCEL_GIT_COMMIT_REF",
      );
    }

    const allowlistedWaIds = parseInternalPilotAllowlist(
      value.HERA_INTERNAL_PILOT_ALLOWLIST,
    );
    const maxRaw = value.HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS ?? "";
    if (!/^[1-9][0-9]*$/.test(maxRaw)) {
      throw new Error(
        "Invalid operations configuration: HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS",
      );
    }
    const maxSendAttempts = Number(maxRaw);
    if (
      !Number.isSafeInteger(maxSendAttempts) ||
      maxSendAttempts < 1 ||
      maxSendAttempts > HERA_INTERNAL_PILOT_MAX_ALLOWED_SEND_ATTEMPTS
    ) {
      throw new Error(
        "Invalid operations configuration: HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS",
      );
    }

    return {
      sendMode: value.WHATSAPP_SEND_MODE,
      managementWaId: value.HERA_MANAGEMENT_WHATSAPP_ID || null,
      cronSecret: value.CRON_SECRET,
      internalPilot: {
        pilotId: HERA_INTERNAL_PILOT_ID,
        allowlistedWaIds,
        maxSendAttempts,
      },
    };
  }

  const releaseMode = assessReleaseMode(
    value.WHATSAPP_SEND_MODE,
    value.WHATSAPP_LIVE_CONFIRMATION,
    WHATSAPP_LIVE_CONFIRMATION_VALUE,
  );

  if (!releaseMode.allowed) {
    if (releaseMode.reason === "live_confirmation_missing_or_incorrect") {
      throw new Error(
        "Invalid operations configuration: WHATSAPP_LIVE_CONFIRMATION",
      );
    }
    throw new Error(
      `Invalid operations configuration: ${releaseMode.reason ?? "release_mode_blocked"}`,
    );
  }

  return {
    sendMode: value.WHATSAPP_SEND_MODE,
    managementWaId: value.HERA_MANAGEMENT_WHATSAPP_ID || null,
    cronSecret: value.CRON_SECRET,
    internalPilot: null,
  };
}

const knowledgeSyncSchema = z.object({
  HERA_WEBSITE_SITEMAP_URL: z
    .string()
    .url()
    .default("https://www.herabeauty.sg/sitemap.xml"),
  AUTO_APPROVE_HERA_WEBSITE_KNOWLEDGE: z
    .enum(["true", "false"])
    .default("false"),
});

export function getKnowledgeSyncConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(knowledgeSyncSchema, env, "knowledge sync");
  return {
    sitemapUrl: value.HERA_WEBSITE_SITEMAP_URL,
    autoApprove: value.AUTO_APPROVE_HERA_WEBSITE_KNOWLEDGE === "true",
  };
}
