import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { JsonValue } from "../types.js";
import {
  WEBSITE_CONCIERGE_ACTIONS,
  WEBSITE_CONCIERGE_INTENTS,
  WEBSITE_CONCIERGE_OUTLETS,
  type WebsiteConciergeDecision,
  type WebsiteConciergeEvidenceBundle,
  type WebsiteConciergeResult,
} from "./types.js";
import { validateWebsiteConciergeDecision } from "./validator.js";

export const WEBSITE_CONCIERGE_MODEL_ID = "openai/gpt-5.6-sol";
export const WEBSITE_CONCIERGE_PROVIDER_MODEL_ID = "gpt-5.6-sol";
export const WEBSITE_CONCIERGE_REASONING_EFFORT = "max";
export const WEBSITE_CONCIERGE_ENGINE_VERSION =
  "hera-website-concierge-engine-1.0.1";
export const WEBSITE_CONCIERGE_MAX_MODEL_CALLS = 2;
export const WEBSITE_CONCIERGE_MAX_TRANSPORT_RETRIES = 1;
export const WEBSITE_CONCIERGE_MAX_OUTPUT_TOKENS = 24_000;
export const WEBSITE_CONCIERGE_TIMEOUT_MS = 240_000;
export const WEBSITE_CONCIERGE_SUBMIT_TOOL = "submitWebsiteConciergeReply";

const decisionSchema = z.object({
  reply: z.string().trim().min(1).max(4000),
  intent: z.enum(WEBSITE_CONCIERGE_INTENTS),
  resolvedOutlet: z.enum(WEBSITE_CONCIERGE_OUTLETS),
  needsOutletClarification: z.boolean(),
  suggestedActions: z.array(z.enum(WEBSITE_CONCIERGE_ACTIONS)).max(4),
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

const submitWebsiteConciergeReply = tool({
  description:
    "Submit the complete visitor-facing Hera website concierge reply and concise review metadata. Call this exactly once.",
  inputSchema: decisionSchema,
  strict: true,
});

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function model(factory?: (modelId: string) => LanguageModel): LanguageModel {
  if (factory) return factory(WEBSITE_CONCIERGE_MODEL_ID);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("Preview OpenAI credential is unavailable.");
    error.name = "WebsiteConciergeOpenAIConfigurationError";
    throw error;
  }
  return createOpenAI({ apiKey }).responses(WEBSITE_CONCIERGE_PROVIDER_MODEL_ID);
}

function canonicalModelId(value: unknown): string {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : WEBSITE_CONCIERGE_PROVIDER_MODEL_ID;
  return raw.startsWith("openai/") ? raw : `openai/${raw}`;
}

const BASE_INSTRUCTIONS = [
  "You are Hera Hair Beauty's senior digital concierge on the public Hera website.",
  `Call ${WEBSITE_CONCIERGE_SUBMIT_TOOL} exactly once. Do not return ordinary assistant text outside the required tool call.`,
  "Write the exact answer that should appear to the visitor. Be warm, polished, commercially intelligent, natural and concise. Do not mention any hospitality brand or internal technology.",
  "Use the approved Hera evidence for every Hera-specific service, price, staff, outlet or policy claim. Never invent a service, price, stylist expertise, schedule, booking outcome, refund decision or policy.",
  "The website serves both Tanglin Mall and Quayside Isle, Sentosa Cove. Do not assume Tanglin. If the visitor already states an outlet, respect it. If an outlet is genuinely required for availability, location-specific pricing or a named-stylist request and is not known, answer all safe general parts first and ask one short outlet question at the end.",
  "For general hair and beauty education, you may provide cautious professional guidance beyond Hera-specific facts, but distinguish general guidance from a confirmed Hera service outcome and recommend consultation or strand testing when condition, colour history or suitability matters.",
  "The website cannot create, change, cancel or confirm appointments. It cannot verify live availability. Offer Book Online or the correct outlet contact as an action rather than claiming anything was completed.",
  "Never approve or promise refunds, vouchers, compensation or complimentary work. A complaint reply should acknowledge the concern, ask only for the minimum useful information and direct the visitor to the appropriate Hera team without admitting liability.",
  "Never diagnose a medical condition. For current breathing difficulty, facial or throat swelling, chemical exposure to the eyes or another clear emergency, advise urgent medical attention before salon follow-up.",
  "For questions unrelated to Hera, hair, beauty or the visitor's salon experience, politely explain that you are Hera's hair and beauty concierge and invite a relevant question.",
  "Use short paragraphs suitable for a compact chat window. Do not repeat the visitor's full question. Avoid robotic process language, excessive disclaimers, exclamation marks and unnecessary questions.",
  "The suggestedActions field controls buttons outside the reply. Use book_online for new bookings; contact_tanglin for Tanglin follow-up; contact_sentosa for Sentosa follow-up; contact_management for complaints, refunds or legal concerns; and seek_urgent_medical_care for a current emergency.",
  "Every verifiedFactsUsed sourceId must exactly match a source in the supplied evidence. The rationaleSummary is a concise review summary, not hidden reasoning.",
].join("\n");

const RECOVERY_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  "The first call did not submit a valid response. This is the final permitted call. Keep the answer focused and call the required submission tool exactly once.",
].join("\n");

const REWRITE_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  "This is the single permitted rewrite. Correct every listed validation issue while preserving supported facts and the visitor's intent. Submit a complete replacement reply.",
].join("\n");

function compactEvidence(bundle: WebsiteConciergeEvidenceBundle): JsonValue {
  return asJson({
    ...bundle,
    history: bundle.history.slice(-12),
    knowledge: bundle.knowledge.map((item) => ({
      ...item,
      excerpt: item.excerpt.slice(0, 1_800),
    })),
  });
}

export class WebsiteConciergeSubmissionError extends Error {
  readonly modelAttempts: 1 | 2;

  constructor(modelAttempts: 1 | 2) {
    super("GPT-5.6 Sol did not submit a valid website concierge response.");
    this.name = "WebsiteConciergeSubmissionError";
    this.modelAttempts = modelAttempts;
  }
}

export class WebsiteConciergeValidationError extends Error {
  readonly modelAttempts: 1 | 2;
  readonly issues: string[];

  constructor(modelAttempts: 1 | 2, issues: string[]) {
    super("The website concierge response did not pass validation.");
    this.name = "WebsiteConciergeValidationError";
    this.modelAttempts = modelAttempts;
    this.issues = issues;
  }
}

async function oneCall(input: {
  evidence: WebsiteConciergeEvidenceBundle;
  instructions: string;
  callNumber: 1 | 2;
  previous?: WebsiteConciergeDecision;
  issues?: string[];
  modelFactory?: (modelId: string) => LanguageModel;
}): Promise<{
  decision: WebsiteConciergeDecision;
  modelId: string;
  usage: JsonValue;
}> {
  const result = await generateText({
    model: model(input.modelFactory),
    system: input.instructions,
    prompt: JSON.stringify({
      engineVersion: WEBSITE_CONCIERGE_ENGINE_VERSION,
      callNumber: input.callNumber,
      evidence: compactEvidence(input.evidence),
      previousResponse: input.previous ?? null,
      validationIssues: input.issues ?? [],
    }),
    tools: { submitWebsiteConciergeReply },
    toolChoice: {
      type: "tool",
      toolName: WEBSITE_CONCIERGE_SUBMIT_TOOL,
    },
    maxRetries: WEBSITE_CONCIERGE_MAX_TRANSPORT_RETRIES,
    maxOutputTokens: WEBSITE_CONCIERGE_MAX_OUTPUT_TOKENS,
    timeout: WEBSITE_CONCIERGE_TIMEOUT_MS,
    providerOptions: {
      openai: {
        reasoningEffort: WEBSITE_CONCIERGE_REASONING_EFFORT,
        store: false,
        strictJsonSchema: true,
        parallelToolCalls: false,
      },
    },
  });

  const submission = result.toolCalls.find(
    (call) => call.toolName === WEBSITE_CONCIERGE_SUBMIT_TOOL,
  );
  const parsed = decisionSchema.safeParse(submission?.input);
  if (!submission || !parsed.success) {
    throw new WebsiteConciergeSubmissionError(input.callNumber);
  }

  return {
    decision: parsed.data,
    modelId: canonicalModelId(result.response.modelId),
    usage: asJson(result.usage),
  };
}

export async function generateWebsiteConciergeReply(input: {
  evidence: WebsiteConciergeEvidenceBundle;
  modelFactory?: (modelId: string) => LanguageModel;
}): Promise<WebsiteConciergeResult> {
  const startedAt = Date.now();
  let first: Awaited<ReturnType<typeof oneCall>>;

  try {
    first = await oneCall({
      evidence: input.evidence,
      instructions: BASE_INSTRUCTIONS,
      callNumber: 1,
      modelFactory: input.modelFactory,
    });
  } catch (error) {
    if (!(error instanceof WebsiteConciergeSubmissionError)) throw error;
    const recovered = await oneCall({
      evidence: input.evidence,
      instructions: RECOVERY_INSTRUCTIONS,
      callNumber: 2,
      issues: ["The first call did not submit a valid structured response."],
      modelFactory: input.modelFactory,
    });
    const validation = validateWebsiteConciergeDecision({
      decision: recovered.decision,
      evidence: input.evidence,
    });
    if (!validation.passed) {
      throw new WebsiteConciergeValidationError(2, validation.issues);
    }
    return {
      decision: recovered.decision,
      reply: recovered.decision.reply.trim(),
      modelId: recovered.modelId,
      modelAttempts: 2,
      evidence: input.evidence,
      validation,
      usage: asJson({ first: null, recovery: recovered.usage }),
      latencyMs: Date.now() - startedAt,
    };
  }

  const firstValidation = validateWebsiteConciergeDecision({
    decision: first.decision,
    evidence: input.evidence,
  });
  if (firstValidation.passed) {
    return {
      decision: first.decision,
      reply: first.decision.reply.trim(),
      modelId: first.modelId,
      modelAttempts: 1,
      evidence: input.evidence,
      validation: firstValidation,
      usage: asJson({ first: first.usage, rewrite: null }),
      latencyMs: Date.now() - startedAt,
    };
  }

  const rewritten = await oneCall({
    evidence: input.evidence,
    instructions: REWRITE_INSTRUCTIONS,
    callNumber: 2,
    previous: first.decision,
    issues: firstValidation.issues,
    modelFactory: input.modelFactory,
  });
  const secondValidation = validateWebsiteConciergeDecision({
    decision: rewritten.decision,
    evidence: input.evidence,
  });
  if (!secondValidation.passed) {
    throw new WebsiteConciergeValidationError(2, secondValidation.issues);
  }

  return {
    decision: rewritten.decision,
    reply: rewritten.decision.reply.trim(),
    modelId: rewritten.modelId,
    modelAttempts: 2,
    evidence: input.evidence,
    validation: secondValidation,
    usage: asJson({ first: first.usage, rewrite: rewritten.usage }),
    latencyMs: Date.now() - startedAt,
  };
}
