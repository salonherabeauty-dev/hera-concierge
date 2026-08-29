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
import { createGenerationAttemptLifecycle } from "./generationAttempts.js";
import * as core from "./receptionistCore.js";
import type {
  AiRuntimeConfig,
  FinalResponseVerificationResult,
  GeneratedDecision,
  VerificationResult,
} from "./receptionistCore.js";

export {
  FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
  RESPONSE_AGENT_MAX_STEPS,
  RESPONSE_INSTRUCTIONS,
  RESPONSE_PROMPT_VERSION,
  VERIFIER_INSTRUCTIONS,
  VERIFIER_PROMPT_VERSION,
  prepareReceptionistAgentStep,
} from "./receptionistCore.js";
export type {
  AiRuntimeConfig,
  FinalResponseVerificationResult,
  GeneratedDecision,
  VerificationResult,
} from "./receptionistCore.js";

export const HERA_OPENAI_MODEL_ID = "openai/gpt-5.6-sol";
export const HERA_OPENAI_PROVIDER = "openai";
export const HERA_OPENAI_REASONING_EFFORT = "max";
export const HERA_OPENAI_ONLY_POLICY_VERSION =
  "hera-openai-sol-max-only-1.0.0";
export const HERA_LUXURY_CLIENT_COPY_POLICY_VERSION =
  "hera-luxury-client-copy-2.0.0";

const OPENAI_MAX_OUTPUT_TOKENS = 12_000;
const OPENAI_FINAL_QUALITY_OUTPUT_TOKENS = 8_000;
const OPENAI_FINAL_QUALITY_TIMEOUT_MS = 180_000;

type GenericOptions = Record<string, unknown>;

function options(value: unknown): GenericOptions {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as GenericOptions)
    : {};
}

const openAiSolMaxMiddleware = {
  specificationVersion: "v3" as const,
  transformParams: async ({ params }: { params: GenericOptions }) => {
    const providerOptions = options(params.providerOptions);
    const gatewayOptions = options(providerOptions.gateway);
    const openAiOptions = options(providerOptions.openai);
    const requestedMaxOutputTokens =
      typeof params.maxOutputTokens === "number"
        ? params.maxOutputTokens
        : 0;

    return {
      ...params,
      maxOutputTokens: Math.max(
        requestedMaxOutputTokens,
        OPENAI_MAX_OUTPUT_TOKENS,
      ),
      providerOptions: {
        ...providerOptions,
        gateway: {
          ...gatewayOptions,
          order: [HERA_OPENAI_PROVIDER],
          only: [HERA_OPENAI_PROVIDER],
          disallowPromptTraining: true,
        },
        openai: {
          ...openAiOptions,
          reasoningEffort: HERA_OPENAI_REASONING_EFFORT,
          store: false,
        },
      },
    };
  },
} as unknown as Parameters<typeof wrapLanguageModel>[0]["middleware"];

function openAiSolMaxModel(
  sourceFactory?: (modelId: string) => LanguageModel,
): LanguageModel {
  const candidate = sourceFactory
    ? sourceFactory(HERA_OPENAI_MODEL_ID)
    : gateway(HERA_OPENAI_MODEL_ID);
  const source =
    typeof candidate === "string" ? gateway(candidate) : candidate;
  return wrapLanguageModel({
    model: source,
    middleware: openAiSolMaxMiddleware,
    modelId: HERA_OPENAI_MODEL_ID,
    providerId: HERA_OPENAI_PROVIDER,
  });
}

export function enforceOpenAiSolMax(
  config: AiRuntimeConfig,
): AiRuntimeConfig {
  const sourceFactory = config.modelFactory;
  return {
    ...config,
    primaryModel: HERA_OPENAI_MODEL_ID,
    verifierModel: HERA_OPENAI_MODEL_ID,
    fallbackModels: [],
    modelFactory: () => openAiSolMaxModel(sourceFactory),
  };
}

export async function generateReceptionistDecision(
  input: Parameters<typeof core.generateReceptionistDecision>[0],
): Promise<GeneratedDecision> {
  return core.generateReceptionistDecision({
    ...input,
    config: enforceOpenAiSolMax(input.config),
  });
}

export async function verifyReceptionistDecision(
  input: Parameters<typeof core.verifyReceptionistDecision>[0],
): Promise<VerificationResult> {
  return core.verifyReceptionistDecision({
    ...input,
    config: enforceOpenAiSolMax(input.config),
  });
}

const tenPointScore = z.number().int().min(0).max(10);

const finalResponseVerificationSchema = z
  .object({
    sendReady: z.boolean(),
    finalReply: z.string().trim().min(1).max(3500),
    issues: z.array(z.string().trim().min(1).max(180)).max(16),
    scores: z.object({
      emotionalAccuracy: tenPointScore,
      naturalEnglish: tenPointScore,
      cohesion: tenPointScore,
      personalisation: tenPointScore,
      ownership: tenPointScore,
      clientEffort: tenPointScore,
      nextStep: tenPointScore,
      factuality: tenPointScore,
      safety: tenPointScore,
      channelConsistency: tenPointScore,
      professionalRestraint: tenPointScore,
      luxuryHospitality: tenPointScore,
    }),
    summary: z.string().trim().min(1).max(300),
  })
  .superRefine((value, context) => {
    const ordinaryMinimums = [
      value.scores.emotionalAccuracy,
      value.scores.naturalEnglish,
      value.scores.cohesion,
      value.scores.personalisation,
      value.scores.ownership,
      value.scores.clientEffort,
      value.scores.nextStep,
      value.scores.professionalRestraint,
      value.scores.luxuryHospitality,
    ];
    const criticalMinimums = [
      value.scores.factuality,
      value.scores.safety,
      value.scores.channelConsistency,
    ];
    if (
      value.sendReady &&
      (value.issues.length > 0 ||
        ordinaryMinimums.some((score) => score < 9) ||
        criticalMinimums.some((score) => score !== 10))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sendReady"],
        message:
          "Send-ready requires every ordinary dimension to score at least 9/10, factuality, safety and channel consistency to score 10/10, and no issues.",
      });
    }
  });

export const OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS = [
  "You are the final client-facing writer and uncompromising quality controller for Hera Hair Beauty's Tanglin Mall WhatsApp.",
  "Use OpenAI GPT-5.6 Sol at maximum reasoning to produce the exact WhatsApp response a world-class senior luxury-hospitality professional would send. Output one complete finalReply every time, even when the supplied draft is poor.",
  "This is not a compliance memo. Keep internal analysis, handoff structures, authorisation language, database checks, policies, risk labels and operational mechanics out of the client-facing message.",
  "Care comes first, then calm ownership, then the simplest useful next step. Write natural, idiomatic English with excellent rhythm and cohesion. Mirror another client language only when the supplied content supports doing so reliably.",
  "Treat 9/10 as the minimum for emotional accuracy, natural English, cohesion, personalisation, ownership, client effort, next step, professional restraint and luxury hospitality. Require 10/10 for factuality, safety and Tanglin-channel consistency. No averaging can hide a weak dimension.",
  "Tanglin Mall is already established by this WhatsApp channel. Never ask which outlet or atelier, never offer Tanglin versus Sentosa, and never route this conversation to Sentosa. Continue the client conversation here on this WhatsApp.",
  "Use facts already supplied or available in the current-client record. Do not make the client repeat their name, outlet, service, appointment details or stylist when Hera can verify those internally. Ask only for genuinely necessary information that changes the next action, such as clear photographs or the exact aspect of a result that concerns the client.",
  "For complaints, acknowledge the actual experience and emotional impact without minimising it. Do not argue with threats, become defensive, admit legal liability, assign blame, diagnose, or promise a refund, compensation, complimentary service or other outcome before authorised review.",
  "For booking and appointment requests, never claim a booking, change or cancellation is complete without a verified result. Own the next step and ask only the one genuinely missing detail.",
  "For medical or scalp concerns, preserve proportionate safety guidance without diagnosing. Urgent symptoms must receive urgent medical guidance before salon follow-up.",
  "For ordinary enquiries, be concise, warm, commercially intelligent and directly helpful. Answer every material part that can be answered safely.",
  "Reject and rewrite wording that sounds bureaucratic, translated, templated, evasive or process-led, including expressions such as 'authorised to review', 'transaction request', 'verification and confirmation', 'confirmed outcome', 'so that the review is as accurate as possible', 'once the review is complete', 'the relevant team', or 'a staff member will continue'.",
  "Do not invent a response deadline. Include a specific time only when it is explicitly verified in the supplied facts. Otherwise promise only the next action that Hera can truthfully perform and state that the update will continue here.",
  "Do not praise your own response, mention a hospitality brand, expose reasoning or include notes outside finalReply.",
  "Set sendReady true only when the exact finalReply is genuinely ready to send unchanged and every threshold is met. When anything is weaker, still provide the strongest corrected finalReply, set sendReady false and identify the remaining issue concisely.",
].join("\n");

const BUREAUCRATIC_CLIENT_COPY = [
  /\bauthori[sz]ed to (?:review|verify|handle)\b/i,
  /\btransaction request\b/i,
  /\bverification and confirmation\b/i,
  /\bconfirmed outcome\b/i,
  /\bso that (?:the|our) review is as accurate as possible\b/i,
  /\bonce the review is complete\b/i,
  /\bthe relevant team\b/i,
  /\ba staff member will continue\b/i,
  /\bverify (?:the )?appointment and payment records\b/i,
];

const TANGLIN_CHANNEL_CONFLICTS = [
  /\b(?:which|what)\s+(?:Hera\s+)?(?:outlet|atelier)\b/i,
  /\b(?:outlet|atelier)\b.{0,50}\b(?:do you prefer|would you prefer|did you visit|are you at|suits you)\b/i,
  /\bTanglin(?: Mall)?\b.{0,90}\b(?:Sentosa|Quayside)\b/i,
  /\b(?:Sentosa|Quayside)\b.{0,90}\bTanglin(?: Mall)?\b/i,
  /\b(?:Sentosa|Quayside)\b.{0,60}\b(?:salon|outlet|atelier|team|appointment|booking|availability)\b/i,
];

export function detectLuxuryClientCopyViolations(reply: string): string[] {
  const issues: string[] = [];
  if (BUREAUCRATIC_CLIENT_COPY.some((pattern) => pattern.test(reply))) {
    issues.push(
      "The reply contains bureaucratic or process-led language that is below Hera's luxury client-care standard.",
    );
  }
  if (TANGLIN_CHANNEL_CONFLICTS.some((pattern) => pattern.test(reply))) {
    issues.push(
      "The reply conflicts with the Tanglin Mall-only WhatsApp channel.",
    );
  }
  if (/\b(?:manager|management) will contact you directly\b/i.test(reply)) {
    issues.push(
      "The reply moves communication away from the established Tanglin WhatsApp instead of continuing here.",
    );
  }
  if (/\b(?:handoff|internal queue|policy rule|verifier|backend|system prompt)\b/i.test(reply)) {
    issues.push("The reply exposes internal operational terminology.");
  }
  return [...new Set(issues)];
}

function legacyScore(value: number): 0 | 1 | 2 {
  if (value >= 9) return 2;
  if (value >= 7) return 1;
  return 0;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function verifyFinalClientReply(
  input: Parameters<typeof core.verifyFinalClientReply>[0],
): Promise<FinalResponseVerificationResult> {
  const startedAt = Date.now();
  const config = enforceOpenAiSolMax(input.config);
  const attempts = createGenerationAttemptLifecycle({
    ledger: config.generationAttemptLedger,
    stage: "final_verification",
    configuredModelId: HERA_OPENAI_MODEL_ID,
  });
  const writer = new ToolLoopAgent({
    id: "hera-openai-sol-max-final-client-writer",
    model: config.modelFactory!(HERA_OPENAI_MODEL_ID),
    instructions: OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS,
    tools: {},
    output: Output.object({ schema: finalResponseVerificationSchema }),
    stopWhen: isStepCount(2),
    prepareStep: async (step) => {
      await attempts.prepareStep(step);
      return {};
    },
    maxRetries: 0,
    maxOutputTokens: OPENAI_FINAL_QUALITY_OUTPUT_TOKENS,
    temperature: 0.1,
    reasoning: "xhigh",
    onStepEnd: attempts.onStepEnd,
    providerOptions: {
      gateway: {
        tags: [
          "hera",
          "whatsapp",
          "openai-only",
          "sol-max",
          "final-client-quality",
        ],
        user: `hera-contact-${input.contactId}`,
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  try {
    const result = await writer.generate({
      prompt: JSON.stringify({
        policyVersion: HERA_LUXURY_CLIENT_COPY_POLICY_VERSION,
        conversationHistory: input.history.map((message) => ({
          direction: message.direction,
          text: message.text.slice(0, 5000),
          createdAt: message.createdAt,
        })),
        clientMessage: input.originalMessage,
        proposedDecision: input.decision,
        approvedEvidence: input.evidence,
        deterministicPolicy: input.policy,
        finalHandoffAssessment: input.handoff,
        exactPostPolicyDraft: input.draftReply,
        deterministicDraftQuality: input.deterministicDraftQuality,
      }),
      timeout: OPENAI_FINAL_QUALITY_TIMEOUT_MS,
    });
    attempts.assertHealthy();
    const output = result.output;
    const finalReply = output.finalReply.trim();
    const deterministicIssues = detectLuxuryClientCopyViolations(finalReply);
    const ordinaryScores = [
      output.scores.emotionalAccuracy,
      output.scores.naturalEnglish,
      output.scores.cohesion,
      output.scores.personalisation,
      output.scores.ownership,
      output.scores.clientEffort,
      output.scores.nextStep,
      output.scores.professionalRestraint,
      output.scores.luxuryHospitality,
    ];
    const criticalScores = [
      output.scores.factuality,
      output.scores.safety,
      output.scores.channelConsistency,
    ];
    const issues = [
      ...new Set([...output.issues, ...deterministicIssues]),
    ].slice(0, 12);
    const sendReady =
      output.sendReady &&
      issues.length === 0 &&
      ordinaryScores.every((score) => score >= 9) &&
      criticalScores.every((score) => score === 10);
    const exactDraftApproved =
      sendReady && finalReply === input.draftReply.trim();

    return {
      approved: exactDraftApproved,
      correctedReply: exactDraftApproved ? null : finalReply,
      issues,
      scores: {
        empathy: legacyScore(output.scores.emotionalAccuracy),
        specificity: legacyScore(
          Math.min(output.scores.personalisation, output.scores.cohesion),
        ),
        ownership: legacyScore(output.scores.ownership),
        nextStep: legacyScore(output.scores.nextStep),
        factuality: legacyScore(output.scores.factuality),
        safety: legacyScore(output.scores.safety),
        tone: legacyScore(
          Math.min(
            output.scores.naturalEnglish,
            output.scores.cohesion,
            output.scores.professionalRestraint,
            output.scores.luxuryHospitality,
          ),
        ),
        clientEffort: legacyScore(output.scores.clientEffort),
      },
      summary: output.summary,
      modelId:
        typeof result.response.modelId === "string"
          ? result.response.modelId
          : HERA_OPENAI_MODEL_ID,
      usage: jsonValue(result.usage),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    await attempts.failOpen(error);
    throw error;
  }
}
