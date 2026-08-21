import { z } from "zod";

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

const operationsSchema = z.object({
  WHATSAPP_SEND_MODE: z.enum(["shadow", "live"]).default("shadow"),
  HERA_MANAGEMENT_WHATSAPP_ID: z.string().trim().optional(),
  CRON_SECRET: nonEmpty.min(24),
});

export function getOperationsConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = parse(operationsSchema, env, "operations");
  return {
    sendMode: value.WHATSAPP_SEND_MODE,
    managementWaId: value.HERA_MANAGEMENT_WHATSAPP_ID || null,
    cronSecret: value.CRON_SECRET,
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
