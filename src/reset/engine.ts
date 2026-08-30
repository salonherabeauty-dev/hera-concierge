import { gateway } from "@ai-sdk/gateway";
import {
  isStepCount,
  Output,
  ToolLoopAgent,
  wrapLanguageModel,
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
export const RESET_OPENAI_REASONING_EFFORT = "max";
export const RESET_DRAFT_ENGINE_VERSION =
  "hera-receptionist-reset-engine-1.0.0";
export const RESET_MAX_MODEL_CALLS = 2;
export const RESET_MODEL_TIMEOUT_MS = 240_000;

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

type GenericOptions = Record<string, unknown>;

function objectOptions(value: unknown): GenericOptions {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as GenericOptions
    : {};
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function resetModel(
  sourceFactory: ((modelId: string) => LanguageModel) | undefined,
  abortSignal: AbortSignal,
): LanguageModel {
  const candidate = sourceFactory
    ? sourceFactory(RESET_OPENAI_MODEL_ID)
    : gateway(RESET_OPENAI_MODEL_ID);
  const source = typeof candidate === "string" ? gateway(candidate) : candidate;
  const middleware = {
    specificationVersion: "v3" as const,
    transformParams: async ({ params }: { params: GenericOptions }) => {
      const providerOptions = objectOptions(params.providerOptions);
      const gatewayOptions = objectOptions(providerOptions.gateway);
      const openAiOptions = objectOptions(providerOptions.openai);
      return {
        ...params,
        abortSignal,
        maxOutputTokens: Math.max(
          typeof params.maxOutputTokens === "number" ? params.maxOutputTokens : 0,
          8_000,
        ),
        providerOptions: {
          ...providerOptions,
          gateway: {
            ...gatewayOptions,
            order: ["openai"],
            only: ["openai"],
            serviceTier: "priority",
            disallowPromptTraining: true,
          },
          openai: {
            ...openAiOptions,
            reasoningEffort: RESET_OPENAI_REASONING_EFFORT,
            store: false,
          },
        },
      };
    },
  } as unknown as Parameters<typeof wrapLanguageModel>[0]["middleware"];

  return wrapLanguageModel({
    model: source,
    middleware,
    modelId: RESET_OPENAI_MODEL_ID,
    providerId: "openai",
  });
}

const BASE_INSTRUCTIONS = [
  "You are Hera Hair Beauty's senior AI receptionist for the Tanglin Mall WhatsApp channel.",
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
  "Output only the required structured object. The rationaleSummary must be a concise decision summary, not hidden chain-of-thought.",
].join("\n");

const REWRITE_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  "This is the single permitted rewrite. Correct every listed hard validation issue while preserving all supported facts and the client's language and intent. Return a complete replacement reply, not editing notes. If a fact cannot be verified, remove or qualify it rather than guessing.",
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
  const abortSignal = AbortSignal.timeout(RESET_MODEL_TIMEOUT_MS);
  const agent = new ToolLoopAgent({
    id: `hera-receptionist-reset-v3-${input.callNumber}`,
    model: resetModel(input.modelFactory, abortSignal),
    instructions: input.instructions,
    tools: {},
    output: Output.object({ schema: decisionSchema }),
    stopWhen: isStepCount(1),
    maxRetries: 0,
    maxOutputTokens: 8_000,
    temperature: 0.1,
    reasoning: "xhigh",
    providerOptions: {
      gateway: {
        tags: [
          "hera",
          "tanglin-whatsapp",
          "receptionist-reset-v3",
          input.callNumber === 1 ? "draft" : "single-rewrite",
        ],
        user: `hera-reset-turn-${input.evidence.turnId}`,
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  const result = await agent.generate({
    prompt: JSON.stringify({
      engineVersion: RESET_DRAFT_ENGINE_VERSION,
      callNumber: input.callNumber,
      evidence: promptEvidence(input.evidence),
      priorDecision: input.priorDecision ?? null,
      hardValidationIssues: input.validationIssues ?? [],
    }),
    timeout: RESET_MODEL_TIMEOUT_MS,
  });

  return {
    decision: result.output,
    modelId:
      typeof result.response.modelId === "string"
        ? result.response.modelId
        : RESET_OPENAI_MODEL_ID,
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

export async function generateResetDraft(input: {
  evidence: ResetEvidenceBundle;
  modelFactory?: (modelId: string) => LanguageModel;
}): Promise<ResetDraftResult> {
  const overallStartedAt = Date.now();
  const first = await oneModelCall({
    evidence: input.evidence,
    instructions: BASE_INSTRUCTIONS,
    modelFactory: input.modelFactory,
    callNumber: 1,
  });
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

  const second = await oneModelCall({
    evidence: input.evidence,
    instructions: REWRITE_INSTRUCTIONS,
    priorDecision: first.decision,
    validationIssues: firstValidation.issues,
    modelFactory: input.modelFactory,
    callNumber: 2,
  });
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
