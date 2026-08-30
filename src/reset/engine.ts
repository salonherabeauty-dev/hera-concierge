import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  tool,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import type { JsonValue } from "../types.js";
import {
  RESET_INTENTS,
  RESET_REVIEW_PRIORITIES,
  type ResetDraftDecision,
  type ResetDraftResult,
  type ResetEvidenceBundle,
} from "./types.js";
import { validateResetDraft } from "./validator.js";

export const RESET_OPENAI_MODEL_ID = "openai/gpt-5.6-sol";
export const RESET_OPENAI_PROVIDER_MODEL_ID = "gpt-5.6-sol";
export const RESET_OPENAI_REASONING_EFFORT = "max";
export const RESET_DRAFT_ENGINE_VERSION =
  "hera-receptionist-reset-engine-1.2.0";
export const RESET_MAX_MODEL_CALLS = 2;
export const RESET_MAX_TRANSPORT_RETRIES = 1;
export const RESET_MODEL_TIMEOUT_MS = 240_000;
export const RESET_MAX_OUTPUT_TOKENS = 24_000;
export const RESET_SUBMIT_TOOL_NAME = "submitReceptionistDraft";

const decisionSchema = z.object({
  replyRecommended: z.boolean(),
  finalReply: z.string().trim().min(1).max(3500),
  intent: z.enum(RESET_INTENTS),
  currentEmergency: z.boolean(),
  currentEmergencyReason: z.string().trim().min(1).max(300).nullable(),
  reviewPriority: z.enum(RESET_REVIEW_PRIORITIES),
  verifiedFactsUsed: z
    .array(
      z.object({
        sourceId: z.string().trim().min(1).max(200),
        claim: z.string().trim().min(1).max(300),
      }),
    )
    .max(20),
  factsStillMissing: z.array(z.string().trim().min(1).max(240)).max(10),
  rationaleSummary: z.string().trim().min(1).max(400),
});

const submitReceptionistDraft = tool({
  description:
    "Submit the complete Hera client-facing reply and its concise review metadata. This tool must be called exactly once and is the only permitted final output.",
  inputSchema: decisionSchema,
  strict: true,
});

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function directOpenAIModel(
  sourceFactory?: (modelId: string) => LanguageModel,
): LanguageModel {
  if (sourceFactory) return sourceFactory(RESET_OPENAI_MODEL_ID);

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error(
      "The Preview OpenAI credential is not configured for Reset v3.",
    );
    error.name = "ResetOpenAIConfigurationError";
    throw error;
  }

  return createOpenAI({ apiKey }).responses(RESET_OPENAI_PROVIDER_MODEL_ID);
}

function canonicalModelId(value: unknown): string {
  const model = typeof value === "string" && value.trim()
    ? value.trim()
    : RESET_OPENAI_PROVIDER_MODEL_ID;
  return model.startsWith("openai/") ? model : `openai/${model}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerPayload(error: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [error.data, error.responseBody, error.cause];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const value = candidate as Record<string, unknown>;
      if (value.error && typeof value.error === "object" && !Array.isArray(value.error)) {
        return value.error as Record<string, unknown>;
      }
      return value;
    }
    if (typeof candidate === "string" && candidate.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        if (parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
          return parsed.error as Record<string, unknown>;
        }
        return parsed;
      } catch {
        // Do not log or expose an unparsed provider body.
      }
    }
  }
  return null;
}

function nestedValue(error: unknown, key: string): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const value = record(current);
    if (!value) return null;
    if (value[key] != null) return value[key];
    current = value.cause;
  }
  return null;
}

function nestedErrorSignature(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const value = record(current);
    const name = current instanceof Error
      ? current.name
      : typeof value?.name === "string"
        ? value.name
        : "";
    const message = current instanceof Error
      ? current.message
      : typeof value?.message === "string"
        ? value.message
        : "";
    parts.push(`${name} ${message}`.trim());
    if (!value?.cause || value.cause === current) break;
    current = value.cause;
  }
  return parts.join(" | ").slice(0, 1_000);
}

function recoverableStructuredOutputFailure(error: unknown): boolean {
  return /(?:NoOutputGenerated|NoObjectGenerated|NoToolCall|InvalidToolInput|structured output|submitReceptionistDraft)/i.test(
    nestedErrorSignature(error),
  );
}

export interface ResetProviderFailureDiagnostic {
  name: string;
  statusCode: number | null;
  retryable: boolean | null;
  providerErrorType: string | null;
  providerErrorCode: string | null;
  requestId: string | null;
  finishReason: string | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  generatedTextLength: number | null;
  causeName: string | null;
}

export function resetProviderFailureDiagnostic(
  error: unknown,
): ResetProviderFailureDiagnostic {
  const value = record(error) ?? {};
  const payload = providerPayload(value);
  const statusCode =
    typeof value.statusCode === "number"
      ? value.statusCode
      : typeof value.status === "number"
        ? value.status
        : typeof nestedValue(error, "statusCode") === "number"
          ? nestedValue(error, "statusCode") as number
          : null;
  const usage = record(nestedValue(error, "usage"));
  const outputDetails = record(usage?.outputTokenDetails);
  const rawText = nestedValue(error, "text");
  const cause = record(value.cause);
  return {
    name: error instanceof Error && error.name
      ? error.name.slice(0, 120)
      : "UnknownError",
    statusCode,
    retryable:
      typeof value.isRetryable === "boolean" ? value.isRetryable : null,
    providerErrorType:
      typeof payload?.type === "string" ? payload.type.slice(0, 120) : null,
    providerErrorCode:
      typeof payload?.code === "string" ? payload.code.slice(0, 120) : null,
    requestId:
      typeof value.requestId === "string"
        ? value.requestId.slice(0, 160)
        : typeof value.request_id === "string"
          ? value.request_id.slice(0, 160)
          : null,
    finishReason:
      typeof nestedValue(error, "finishReason") === "string"
        ? String(nestedValue(error, "finishReason")).slice(0, 80)
        : null,
    outputTokens:
      typeof usage?.outputTokens === "number" ? usage.outputTokens : null,
    reasoningTokens:
      typeof outputDetails?.reasoningTokens === "number"
        ? outputDetails.reasoningTokens
        : null,
    generatedTextLength:
      typeof rawText === "string" ? rawText.length : null,
    causeName:
      typeof cause?.name === "string"
        ? cause.name.slice(0, 120)
        : value.cause instanceof Error
          ? value.cause.name.slice(0, 120)
          : null,
  };
}

const BASE_INSTRUCTIONS = [
  "You are Hera Hair Beauty's senior AI receptionist for the Tanglin Mall WhatsApp channel.",
  `You must call ${RESET_SUBMIT_TOOL_NAME} exactly once. Do not return ordinary assistant text outside that tool call.`,
  "Write the exact client-facing WhatsApp reply that an exceptional, commercially intelligent luxury-service professional would send. Be warm, natural, cohesive, specific and calm. Do not mention any hospitality brand.",
  "The supplied evidence bundle is authoritative. Use approved Hera knowledge, the current client turn and verified current-client appointment records. Never invent Hera services, prices, staff expertise, live availability, appointment outcomes or policies.",
  "Tanglin Mall is already known from this WhatsApp channel. Never ask which outlet, never offer Tanglin versus Sentosa, and never route the client to Sentosa. Continue the conversation here.",
  "The AI prepares a draft only. A human receptionist will review, edit and decide whether to send it. Never say that the AI has booked, changed, cancelled, confirmed, refunded, compensated or completed an operational action unless the evidence explicitly proves that outcome.",
  "For a booking or appointment request, answer what is known and state the precise next check required. Do not claim live availability or completion. Ask only the minimum genuinely missing detail.",
  "For complaints, recognise the actual experience and emotional impact, take calm ownership of the next useful step and avoid defensive, bureaucratic or legalistic phrasing. Do not argue with threats, admit liability, blame anyone or promise a refund, voucher, complimentary service or compensation.",
  "For legal correspondence, acknowledge receipt and preserve clearly stated references or deadlines without debating the merits or treating historical allegations as a current medical emergency.",
  "For medical or scalp concerns, distinguish a present first-person emergency from past, third-party or documentary allegations. Give urgent medical guidance only when the current client is describing genuinely current urgent symptoms. Never diagnose.",
  "For several rapid messages or attachments, answer the consolidated client turn as one request. An unreadable attachment note is context, not a separate client instruction.",
  "For an acknowledgement such as OK or thank you, a short optional courtesy reply is acceptable. Set replyRecommended false when no reply is genuinely needed, but still provide a polished editable reply for the human reviewer.",
  "Use concise paragraphs suitable for WhatsApp. Answer every material part that can be answered safely. Avoid exclamation marks, sales pressure, robotic process language and internal terms such as handoff, queue, verifier, policy engine, candidate or database.",
  "Every item in verifiedFactsUsed must cite an exact sourceId present in the supplied evidence bundle. Do not cite sources that were not supplied. Use current-client-appointments only for the read-only appointment records included in the bundle.",
  "The rationaleSummary must be a concise decision summary, not hidden chain-of-thought.",
].join("\n");

const REWRITE_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  "This is the single permitted rewrite. Correct every listed hard validation issue while preserving all supported facts and the client's language and intent. Return a complete replacement reply through the required tool call, not editing notes. If a fact cannot be verified, remove or qualify it rather than guessing.",
].join("\n");

const NO_OUTPUT_RECOVERY_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  "The first generation did not submit a usable structured draft. This is the final permitted content call. Keep the analysis focused, call the required submission tool exactly once, and provide a complete client-ready reply grounded only in the supplied evidence.",
].join("\n");

function promptEvidence(bundle: ResetEvidenceBundle): JsonValue {
  return asJson({
    ...bundle,
    knowledge: bundle.knowledge.map((item) => ({
      ...item,
      excerpt: item.excerpt.slice(0, 2_400),
    })),
    recentConversation: bundle.recentConversation.slice(-20),
  });
}

export class ResetDraftSubmissionError extends Error {
  readonly modelAttempts: 1 | 2;
  readonly finishReason: string | null;
  readonly usage: JsonValue;

  constructor(input: {
    modelAttempts: 1 | 2;
    finishReason?: string | null;
    usage?: unknown;
    cause?: unknown;
  }) {
    super("GPT-5.6 Sol did not submit a valid structured receptionist draft.");
    this.name = "ResetDraftSubmissionError";
    this.modelAttempts = input.modelAttempts;
    this.finishReason = input.finishReason ?? null;
    this.usage = asJson(input.usage ?? null);
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

async function oneModelCall(input: {
  evidence: ResetEvidenceBundle;
  instructions: string;
  priorDecision?: ResetDraftDecision;
  validationIssues?: string[];
  modelFactory?: (modelId: string) => LanguageModel;
  callNumber: 1 | 2;
}): Promise<{
  decision: ResetDraftDecision;
  modelId: string;
  usage: JsonValue;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  const result = await generateText({
    model: directOpenAIModel(input.modelFactory),
    system: input.instructions,
    prompt: JSON.stringify({
      engineVersion: RESET_DRAFT_ENGINE_VERSION,
      callNumber: input.callNumber,
      evidence: promptEvidence(input.evidence),
      priorDecision: input.priorDecision ?? null,
      hardValidationIssues: input.validationIssues ?? [],
    }),
    tools: { submitReceptionistDraft },
    toolChoice: {
      type: "tool",
      toolName: RESET_SUBMIT_TOOL_NAME,
    },
    maxRetries: RESET_MAX_TRANSPORT_RETRIES,
    maxOutputTokens: RESET_MAX_OUTPUT_TOKENS,
    timeout: RESET_MODEL_TIMEOUT_MS,
    providerOptions: {
      openai: {
        reasoningEffort: RESET_OPENAI_REASONING_EFFORT,
        store: false,
        strictJsonSchema: true,
        parallelToolCalls: false,
      },
    },
  });

  const submission = result.toolCalls.find(
    (call) => call.toolName === RESET_SUBMIT_TOOL_NAME,
  );
  if (!submission) {
    throw new ResetDraftSubmissionError({
      modelAttempts: input.callNumber,
      finishReason: result.finishReason,
      usage: result.usage,
    });
  }
  const parsed = decisionSchema.safeParse(submission.input);
  if (!parsed.success) {
    throw new ResetDraftSubmissionError({
      modelAttempts: input.callNumber,
      finishReason: result.finishReason,
      usage: result.usage,
      cause: parsed.error,
    });
  }

  return {
    decision: parsed.data,
    modelId: canonicalModelId(result.response.modelId),
    usage: asJson(result.usage),
    latencyMs: Date.now() - startedAt,
  };
}

export class ResetDraftValidationError extends Error {
  readonly issues: string[];
  readonly modelAttempts: 1 | 2;

  constructor(issues: string[], modelAttempts: 1 | 2) {
    super("The AI reply did not pass the bounded hard-safety validation.");
    this.name = "ResetDraftValidationError";
    this.issues = issues;
    this.modelAttempts = modelAttempts;
  }
}

export class ResetDraftGenerationError extends Error {
  readonly modelAttempts: 1 | 2;

  constructor(modelAttempts: 1 | 2, cause: unknown) {
    super("GPT-5.6 Sol could not complete the receptionist draft generation.");
    this.name = "ResetDraftGenerationError";
    this.modelAttempts = modelAttempts;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export async function generateResetDraft(input: {
  evidence: ResetEvidenceBundle;
  modelFactory?: (modelId: string) => LanguageModel;
}): Promise<ResetDraftResult> {
  const overallStartedAt = Date.now();
  let first: Awaited<ReturnType<typeof oneModelCall>>;
  try {
    first = await oneModelCall({
      evidence: input.evidence,
      instructions: BASE_INSTRUCTIONS,
      modelFactory: input.modelFactory,
      callNumber: 1,
    });
  } catch (error) {
    if (!recoverableStructuredOutputFailure(error)) {
      throw new ResetDraftGenerationError(1, error);
    }

    let recovery: Awaited<ReturnType<typeof oneModelCall>>;
    try {
      recovery = await oneModelCall({
        evidence: input.evidence,
        instructions: NO_OUTPUT_RECOVERY_INSTRUCTIONS,
        validationIssues: [
          "The first model call did not submit a usable structured draft.",
        ],
        modelFactory: input.modelFactory,
        callNumber: 2,
      });
    } catch (recoveryError) {
      throw new ResetDraftGenerationError(2, recoveryError);
    }

    const recoveryValidation = validateResetDraft({
      decision: recovery.decision,
      evidence: input.evidence,
    });
    if (!recoveryValidation.passed) {
      throw new ResetDraftValidationError(recoveryValidation.issues, 2);
    }

    return {
      decision: recovery.decision,
      finalReply: recovery.decision.finalReply.trim(),
      modelId: recovery.modelId,
      modelAttempts: 2,
      evidence: input.evidence,
      validation: recoveryValidation,
      usage: asJson({
        first: null,
        recovery: recovery.usage,
        firstFailure: resetProviderFailureDiagnostic(error),
      }),
      latencyMs: Date.now() - overallStartedAt,
    };
  }

  const firstValidation = validateResetDraft({
    decision: first.decision,
    evidence: input.evidence,
  });

  if (firstValidation.passed) {
    return {
      decision: first.decision,
      finalReply: first.decision.finalReply.trim(),
      modelId: first.modelId,
      modelAttempts: 1,
      evidence: input.evidence,
      validation: firstValidation,
      usage: asJson({ first: first.usage, rewrite: null }),
      latencyMs: Date.now() - overallStartedAt,
    };
  }

  let second: Awaited<ReturnType<typeof oneModelCall>>;
  try {
    second = await oneModelCall({
      evidence: input.evidence,
      instructions: REWRITE_INSTRUCTIONS,
      priorDecision: first.decision,
      validationIssues: firstValidation.issues,
      modelFactory: input.modelFactory,
      callNumber: 2,
    });
  } catch (error) {
    throw new ResetDraftGenerationError(2, error);
  }

  const secondValidation = validateResetDraft({
    decision: second.decision,
    evidence: input.evidence,
  });

  if (!secondValidation.passed) {
    throw new ResetDraftValidationError(secondValidation.issues, 2);
  }

  return {
    decision: second.decision,
    finalReply: second.decision.finalReply.trim(),
    modelId: second.modelId,
    modelAttempts: 2,
    evidence: input.evidence,
    validation: secondValidation,
    usage: asJson({ first: first.usage, rewrite: second.usage }),
    latencyMs: Date.now() - overallStartedAt,
  };
}
