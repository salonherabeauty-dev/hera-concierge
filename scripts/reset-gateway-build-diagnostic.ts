import { gateway } from "@ai-sdk/gateway";
import { generateText } from "ai";

const MODEL_ID = "openai/gpt-5.6-sol";

function safeError(error: unknown) {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const cause = value.cause && typeof value.cause === "object"
    ? value.cause as Record<string, unknown>
    : null;
  const clean = (input: unknown) => String(input ?? "")
    .replace(/(?:Bearer|token|key|secret)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 800);
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    type: typeof value.type === "string" ? value.type : null,
    statusCode: typeof value.statusCode === "number" ? value.statusCode : null,
    retryable: typeof value.isRetryable === "boolean" ? value.isRetryable : null,
    generationId: typeof value.generationId === "string" ? value.generationId : null,
    message: clean(error instanceof Error ? error.message : error),
    cause: cause ? {
      name: clean(cause.name),
      type: clean(cause.type),
      statusCode: typeof cause.statusCode === "number" ? cause.statusCode : null,
      message: clean(cause.message),
    } : null,
  };
}

console.log("RESET_GATEWAY_BUILD_DIAGNOSTIC_ENV", JSON.stringify({
  vercelEnv: process.env.VERCEL_ENV ?? null,
  commitRef: process.env.VERCEL_GIT_COMMIT_REF ?? null,
  aiGatewayApiKeyPresent: Boolean(process.env.AI_GATEWAY_API_KEY),
  vercelOidcTokenPresent: Boolean(process.env.VERCEL_OIDC_TOKEN),
  openAiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
  cronSecretPresent: Boolean(process.env.CRON_SECRET),
  cronSecretLengthValid: (process.env.CRON_SECRET?.length ?? 0) >= 24,
}));

try {
  const result = await generateText({
    model: gateway(MODEL_ID),
    prompt: "Return exactly the word READY.",
    maxOutputTokens: 400,
    maxRetries: 1,
    timeout: 120_000,
    providerOptions: {
      gateway: {
        order: ["openai"],
        only: ["openai"],
        disallowPromptTraining: true,
      },
      openai: {
        reasoningEffort: "max",
        store: false,
      },
    },
  });
  console.log("RESET_GATEWAY_BUILD_DIAGNOSTIC_PASS", JSON.stringify({
    model: result.response.modelId,
    finishReason: result.finishReason,
    text: result.text.trim().slice(0, 50),
    usage: result.usage,
  }));
} catch (error) {
  console.error("RESET_GATEWAY_BUILD_DIAGNOSTIC_FAIL", JSON.stringify(safeError(error)));
  process.exitCode = 1;
}
