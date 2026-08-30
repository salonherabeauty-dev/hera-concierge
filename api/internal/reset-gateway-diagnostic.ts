import { gateway } from "@ai-sdk/gateway";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateText } from "ai";

const DIAGNOSTIC_BRANCH = "repair/reset-v3-gateway-diagnostic";
const MODEL_ID = "openai/gpt-5.6-sol";

type Failure = {
  name: string;
  type: string | null;
  statusCode: number | null;
  retryable: boolean | null;
  generationId: string | null;
  message: string;
  cause: string | null;
};

function clean(value: unknown, limit = 500): string {
  return String(value ?? "")
    .replace(/(?:Bearer|token|key|secret)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, limit);
}

function failure(error: unknown): Failure {
  const value = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const cause = value.cause && typeof value.cause === "object"
    ? value.cause as Record<string, unknown>
    : null;
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    type: typeof value.type === "string" ? value.type : null,
    statusCode:
      typeof value.statusCode === "number" ? value.statusCode : null,
    retryable:
      typeof value.isRetryable === "boolean" ? value.isRetryable : null,
    generationId:
      typeof value.generationId === "string" ? value.generationId : null,
    message: clean(error instanceof Error ? error.message : error),
    cause: cause
      ? clean(
          `${String(cause.name ?? "")} ${String(cause.type ?? "")} ${String(cause.statusCode ?? "")} ${String(cause.message ?? "")}`,
        )
      : null,
  };
}

async function run(input: {
  reasoningEffort: "max" | "xhigh";
  priority: boolean;
}) {
  try {
    const result = await generateText({
      model: gateway(MODEL_ID),
      prompt: "Return exactly the word READY.",
      maxOutputTokens: 400,
      maxRetries: 0,
      timeout: 90_000,
      providerOptions: {
        gateway: {
          order: ["openai"],
          only: ["openai"],
          disallowPromptTraining: true,
          ...(input.priority ? { serviceTier: "priority" as const } : {}),
        },
        openai: {
          reasoningEffort: input.reasoningEffort,
          store: false,
        },
      },
    });
    return {
      ok: true as const,
      reasoningEffort: input.reasoningEffort,
      priority: input.priority,
      responseModelId: result.response.modelId,
      finishReason: result.finishReason,
      text: clean(result.text, 50),
      usage: result.usage,
    };
  } catch (error) {
    return {
      ok: false as const,
      reasoningEffort: input.reasoningEffort,
      priority: input.priority,
      failure: failure(error),
    };
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (
    process.env.VERCEL_ENV !== "preview" ||
    process.env.VERCEL_GIT_COMMIT_REF !== DIAGNOSTIC_BRANCH
  ) {
    return response.status(404).json({ error: "Not found" });
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const solMaxDefaultTier = await run({
    reasoningEffort: "max",
    priority: false,
  });
  if (solMaxDefaultTier.ok) {
    return response.status(200).json({
      model: MODEL_ID,
      diagnosis: "sol_max_default_tier_passed",
      attempts: [solMaxDefaultTier],
    });
  }

  const solXHighDefaultTier = await run({
    reasoningEffort: "xhigh",
    priority: false,
  });
  return response.status(200).json({
    model: MODEL_ID,
    diagnosis: solXHighDefaultTier.ok
      ? "max_specific_failure"
      : "gateway_or_model_access_failure",
    attempts: [solMaxDefaultTier, solXHighDefaultTier],
  });
}
