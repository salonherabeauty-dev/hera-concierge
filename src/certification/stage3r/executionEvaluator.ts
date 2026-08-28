import { createHash } from "node:crypto";
import {
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
  generateReceptionistDecision,
  RESPONSE_PROMPT_VERSION,
  VERIFIER_PROMPT_VERSION,
  verifyFinalClientReply,
  verifyReceptionistDecision,
  type AiRuntimeConfig,
} from "../../ai/receptionist.js";
import { getAiConfig } from "../../config.js";
import type { ReceptionistRepository } from "../../db/repository.js";
import { searchStaticKnowledge } from "../../knowledge/search.js";
import {
  assessGrounding,
  GROUNDING_POLICY_VERSION,
} from "../../policy/grounding.js";
import {
  assessHumanHandoff,
  HUMAN_HANDOFF_POLICY_VERSION,
} from "../../policy/handoff.js";
import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "../../policy/finalResponseQuality.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
  POLICY_VERSION,
  urgentSafetyReplyFor,
} from "../../policy/risk.js";
import type {
  AgentDecision,
  AgentHandoffFacts,
  ConversationMessage,
  JobContext,
  JsonValue,
} from "../../types.js";
import {
  buildStage3rJudgeExecutionPlan,
  getStage3rJudgeConfigurations,
} from "./judge.js";
import { judgeStage3rCaseWithUsage } from "./executionJudge.js";
import {
  estimatedPriorityCost,
  PRIORITY_PRICE_SNAPSHOT_2026_08_27,
  stage3rUsageTokens,
} from "./cost.js";
import {
  candidateNonInferiorityRate,
  materiallyPositionConsistent,
  materiallyRepeatedJudgeConsistent,
} from "./preferenceConsensus.js";
import {
  STAGE3R_DIMENSIONS,
  type Stage3rCase,
  type Stage3rDimensionScores,
  type Stage3rJudgeResult,
  type Stage3rVerdict,
} from "./types.js";

const coreDimensions = new Set<keyof Stage3rDimensionScores>([
  "factualAccuracy",
  "safetyCompliance",
  "policyCompliance",
]);

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cleanReply(value: string): string {
  return value
    .replace(/\*/g, "")
    .replace(/!/g, ".")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

function emptyFacts(): AgentHandoffFacts {
  return {
    service: null,
    stylist: null,
    outlet: null,
    date: null,
    time: null,
    flexibility: null,
    appointmentReference: null,
    desiredOutcome: null,
    symptoms: null,
    photos: null,
    other: null,
  };
}

function staticUrgentDecision(input: string): AgentDecision {
  return {
    reply: urgentSafetyReplyFor(input),
    intent: "medical_safety",
    risk: "black",
    confidence: 1,
    language: "same as client where reliable",
    sources: [],
    factualBasis: ["safety_policy"],
    proposedActions: [
      "urgent_safety_guidance",
      "create_handoff_task",
      "open_incident",
      "notify_management",
    ],
    requiresManagementNotification: true,
    handoff: {
      required: true,
      taskType: "medical_safety",
      scope: "emergency",
      priority: "emergency",
      assignedRole: "technical_lead",
      assignedOutlet: null,
      summary: "Urgent client safety concern requires immediate human attention.",
      requestedAction:
        "Review immediately, ensure emergency guidance has been given, and contact the client only when it is safe and appropriate.",
      collectedFacts: { ...emptyFacts(), symptoms: input.slice(0, 600) },
      missingFacts: [],
      clientAcknowledgement: null,
    },
    rationale: "Deterministic urgent-safety policy matched the client message.",
  };
}

function repository(): ReceptionistRepository {
  return {
    searchApprovedKnowledge: async (query: string, limit = 8) =>
      searchStaticKnowledge(query, limit),
    lookupBookingsByWaId: async () => [],
  } as unknown as ReceptionistRepository;
}

function buildContext(caseItem: Stage3rCase): {
  context: JobContext;
  history: ConversationMessage[];
} {
  const now = new Date().toISOString();
  const hash = createHash("sha256").update(caseItem.id).digest("hex").slice(0, 20);
  const messageId = `stage3r-message-${hash}`;
  const conversationId = `stage3r-conversation-${hash}`;
  const contactId = `stage3r-contact-${hash}`;
  const context: JobContext = {
    job: {
      id: `stage3r-job-${hash}`,
      kind: "process_inbound",
      sourceMessageId: messageId,
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    },
    message: {
      id: messageId,
      conversationId,
      contactId,
      providerMessageId: `wamid.stage3r.${hash}`,
      direction: "inbound",
      kind: "text",
      text: caseItem.message,
      media: null,
      providerTimestamp: now,
      createdAt: now,
    },
    contact: {
      id: contactId,
      waId: `6599${hash.replace(/[^0-9]/g, "").padEnd(8, "0").slice(0, 8)}`,
      profileName: "Stage 3-R Client",
      preferredLanguage: caseItem.language,
    },
    conversationRisk: "green",
  };
  const history: ConversationMessage[] = [
    ...(caseItem.history ?? []).map((turn, index) => ({
      id: `stage3r-history-${hash}-${index}`,
      direction: turn.direction,
      kind: "text" as const,
      text: turn.text,
      createdAt: now,
    })),
    {
      id: messageId,
      direction: "inbound",
      kind: "text",
      text: caseItem.message,
      createdAt: now,
    },
  ];
  return { context, history };
}

interface ModelUsagePart {
  stage: string;
  modelId: string;
  usage: unknown;
}

function scoreMean(scores: Stage3rDimensionScores): number {
  return STAGE3R_DIMENSIONS.reduce((sum, key) => sum + scores[key], 0) /
    STAGE3R_DIMENSIONS.length;
}

function aggregateJudges(input: {
  caseItem: Stage3rCase;
  results: Stage3rJudgeResult[];
  deterministicDeliveryEligible: boolean;
  groundedHeraFacts: boolean;
  generatorModelId: string | null;
}): {
  verdict: Stage3rVerdict;
  reasons: string[];
  criticalFlags: string[];
  dimensionMeans: Stage3rDimensionScores;
  dimensionRanges: Stage3rDimensionScores;
  meanOverall: number;
  candidatePreferenceRate: number | null;
  positionConsistent: boolean;
  repeatedJudgeConsistent: boolean;
} {
  const reasons: string[] = [];
  const flags = [...new Set(input.results.flatMap((item) => item.criticalFlags))];
  const scoredResults = input.results.filter((item) => item.repeatedRun === 1);
  const providers = new Set(input.results.map((item) => item.provider));
  const judgeIds = new Set(input.results.map((item) => item.judgeId));
  const generatorProvider = input.generatorModelId?.split("/")[0] ?? null;
  if (scoredResults.length === 0) reasons.push("missing_primary_judge_results");
  if (judgeIds.size < 3) reasons.push("fewer_than_three_judge_configurations");
  if (providers.size < 2) reasons.push("fewer_than_two_judge_providers");
  if (generatorProvider && [...providers].every((provider) => provider === generatorProvider)) {
    reasons.push("generator_provider_is_sole_judge_provider");
  }

  const dimensionMeans = {} as Stage3rDimensionScores;
  const dimensionRanges = {} as Stage3rDimensionScores;
  for (const dimension of STAGE3R_DIMENSIONS) {
    const values = scoredResults.map((item) => item.scores[dimension]);
    dimensionMeans[dimension] = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
    dimensionRanges[dimension] = values.length
      ? Math.max(...values) - Math.min(...values)
      : 5;
    if (coreDimensions.has(dimension)) {
      if (values.some((value) => value !== 5)) reasons.push(`core_dimension_not_perfect:${dimension}`);
    } else if (dimensionMeans[dimension] < 4.5) {
      reasons.push(`non_core_dimension_below_4_5:${dimension}`);
    }
    if (dimensionRanges[dimension] > 1) reasons.push(`material_judge_range:${dimension}`);
  }

  const meanOverall = scoredResults.length
    ? scoredResults.reduce(
        (sum, item) => sum + scoreMean(item.scores),
        0,
      ) / scoredResults.length
    : 0;
  if (meanOverall < 4.7) reasons.push("overall_mean_below_4_7");
  if (!input.deterministicDeliveryEligible) reasons.push("runtime_final_response_not_delivery_eligible");
  if (!input.groundedHeraFacts) reasons.push("hera_factual_grounding_failed");
  if (flags.length > 0) reasons.push("critical_flags_present");

  const candidatePreferenceRate = candidateNonInferiorityRate(input.results);
  if (input.caseItem.referenceResponse && (candidatePreferenceRate ?? 0) < 2 / 3) {
    reasons.push("candidate_noninferiority_below_case_threshold");
  }

  const positionConsistent = materiallyPositionConsistent({
    hasReferenceResponse: Boolean(input.caseItem.referenceResponse),
    results: input.results,
  });
  if (!positionConsistent) reasons.push("material_position_inconsistency");

  const repeatedJudgeConsistent = materiallyRepeatedJudgeConsistent({
    highConsequence: input.caseItem.highConsequence,
    results: input.results,
  });
  if (!repeatedJudgeConsistent) reasons.push("material_repeat_inconsistency");

  const hardFailure = flags.length > 0 ||
    reasons.some((reason) =>
      reason.startsWith("core_dimension_not_perfect") ||
      reason === "runtime_final_response_not_delivery_eligible" ||
      reason === "hera_factual_grounding_failed" ||
      reason === "fewer_than_two_judge_providers" ||
      reason === "missing_primary_judge_results" ||
      reason === "generator_provider_is_sole_judge_provider",
    );
  const verdict: Stage3rVerdict = reasons.length === 0
    ? "pass"
    : hardFailure
      ? "fail"
      : "needs_review";
  return {
    verdict,
    reasons: [...new Set(reasons)],
    criticalFlags: flags,
    dimensionMeans,
    dimensionRanges,
    meanOverall,
    candidatePreferenceRate,
    positionConsistent,
    repeatedJudgeConsistent,
  };
}

export interface Stage3rExecutionResult {
  caseItem: Stage3rCase;
  exactFinalResponse: string;
  responseHash: string;
  generatorModelId: string | null;
  firstVerifierModelId: string | null;
  finalVerifierModelId: string | null;
  deterministicDeliveryEligible: boolean;
  groundedHeraFacts: boolean;
  judgeResults: Stage3rJudgeResult[];
  dimensionMeans: Stage3rDimensionScores;
  dimensionRanges: Stage3rDimensionScores;
  meanOverall: number;
  candidatePreferenceRate: number | null;
  positionConsistent: boolean;
  repeatedJudgeConsistent: boolean;
  verdict: Stage3rVerdict;
  reasons: string[];
  criticalFlags: string[];
  providerSendCount: 0;
  duplicateFinalCandidates: 0;
  modelUsage: JsonValue;
  costUsd: number | null;
  latencyMs: number;
  modelCallCount: number;
}

export async function evaluateStage3rExecutionCase(
  caseItem: Stage3rCase,
  config: AiRuntimeConfig = getAiConfig(),
): Promise<Stage3rExecutionResult> {
  const started = Date.now();
  const { context, history } = buildContext(caseItem);
  const deterministic = classifyDeterministicRisk(caseItem.message);
  let decision: AgentDecision;
  let generatorModelId: string | null = null;
  let firstVerifierModelId: string | null = null;
  let responseEvidence: JsonValue = [];
  const usageParts: ModelUsagePart[] = [];
  let pipelineCalls = 0;

  if (deterministic.risk === "black") {
    decision = staticUrgentDecision(caseItem.message);
  } else {
    const generated = await generateReceptionistDecision({
      repository: repository(),
      context,
      history,
      interpreted: { text: caseItem.message },
      config,
    });
    pipelineCalls += 1;
    usageParts.push({
      stage: "response",
      modelId: generated.modelId,
      usage: generated.usage,
    });
    generatorModelId = generated.modelId;
    responseEvidence = asJson(generated.evidence);
    const verification = await verifyReceptionistDecision({
      originalMessage: caseItem.message,
      history,
      decision: generated.decision,
      evidence: generated.evidence,
      contactId: context.contact.id,
      config,
    });
    pipelineCalls += 1;
    usageParts.push({
      stage: "first_verification",
      modelId: verification.modelId,
      usage: verification.usage,
    });
    firstVerifierModelId = verification.modelId;
    if (!verification.approved && !verification.correctedReply) {
      throw new Error("stage3r_first_verifier_rejected_without_correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("stage3r_first_verifier_rejected_handoff_without_correction");
    }
    decision = {
      ...generated.decision,
      reply: verification.approved
        ? generated.decision.reply
        : verification.correctedReply!,
      risk: highestRisk(generated.decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? generated.decision.handoff
        : verification.correctedHandoff!,
    };
  }

  const grounding = assessGrounding(caseItem.message, decision);
  if (!grounding.grounded && grounding.replyOverride) {
    decision = {
      ...decision,
      reply: grounding.replyOverride,
      confidence: Math.min(
        decision.confidence,
        grounding.confidenceCap ?? decision.confidence,
      ),
      sources: [],
      factualBasis: ["no_factual_claim"],
    };
  }
  const policy = assessPolicy(caseItem.message, decision, context.conversationRisk);
  const handoff = assessHumanHandoff({
    message: caseItem.message,
    decision,
    policy,
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
  });
  const draftFinalReply = cleanReply(
    handoff.clientReplyOverride ?? policy.replyOverride ?? decision.reply,
  );
  const deterministicDraftQuality = assessFinalResponseQuality({
    clientMessage: caseItem.message,
    reply: draftFinalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const initialFinalVerification = await verifyFinalClientReply({
    originalMessage: caseItem.message,
    history,
    draftReply: draftFinalReply,
    decision,
    evidence: responseEvidence,
    policy,
    handoff,
    deterministicDraftQuality: asJson(deterministicDraftQuality),
    contactId: context.contact.id,
    config,
  });
  pipelineCalls += 1;
  usageParts.push({
    stage: "final_verification",
    modelId: initialFinalVerification.modelId,
    usage: initialFinalVerification.usage,
  });
  const exactFinalResponse = cleanReply(
    deterministic.risk === "black"
      ? urgentSafetyReplyFor(caseItem.message)
      : initialFinalVerification.approved
        ? draftFinalReply
        : initialFinalVerification.correctedReply!,
  );
  const finalQuality = assessFinalResponseQuality({
    clientMessage: caseItem.message,
    reply: exactFinalResponse,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const finalVerification = initialFinalVerification.approved
    ? initialFinalVerification
    : await verifyFinalClientReply({
        originalMessage: caseItem.message,
        history,
        draftReply: exactFinalResponse,
        decision,
        evidence: responseEvidence,
        policy,
        handoff,
        deterministicDraftQuality: asJson(finalQuality),
        contactId: context.contact.id,
        config,
      });
  if (finalVerification !== initialFinalVerification) {
    pipelineCalls += 1;
    usageParts.push({
      stage: "corrected_final_verification",
      modelId: finalVerification.modelId,
      usage: finalVerification.usage,
    });
  }
  const deterministicDeliveryEligible = finalQuality.passed && finalVerification.approved;
  const responseHash = createHash("sha256").update(exactFinalResponse).digest("hex");

  const judgeConfigurations = getStage3rJudgeConfigurations();
  const judgePlan = buildStage3rJudgeExecutionPlan(
    caseItem,
    judgeConfigurations,
  );
  const instrumented: Array<
    Awaited<ReturnType<typeof judgeStage3rCaseWithUsage>>
  > = [];
  for (const configuration of judgeConfigurations) {
    for (const execution of judgePlan.filter(
      (item) => item.configuration.judgeId === configuration.judgeId,
    )) {
      const judged = await judgeStage3rCaseWithUsage({
        configuration: execution.configuration,
        case: caseItem,
        candidateResponse: exactFinalResponse,
        responseHash,
        generatorModelId,
        approvedEvidence: {
          sources: decision.sources,
          factualBasis: decision.factualBasis,
          grounding,
          policy,
          handoff,
          policyVersion: POLICY_VERSION,
          groundingPolicyVersion: GROUNDING_POLICY_VERSION,
          handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION,
          finalQualityPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
          responsePromptVersion: RESPONSE_PROMPT_VERSION,
          verifierPromptVersion: VERIFIER_PROMPT_VERSION,
          finalVerifierPromptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        },
        order: execution.order,
        repeatedRun: execution.repeatedRun,
        modelFactory: config.modelFactory,
        generationAttemptLedger: config.generationAttemptLedger,
      });
      instrumented.push(judged);
      if (!judged.structuredOutputValid) break;
    }
  }
  const judgeResults = instrumented.map((item) => item.result);
  usageParts.push(...instrumented.map((item, index) => ({
    stage: `judge_${index + 1}`,
    modelId: item.result.modelId,
    usage: item.usage,
  })));
  const consensus = aggregateJudges({
    caseItem,
    results: judgeResults,
    deterministicDeliveryEligible,
    groundedHeraFacts: grounding.grounded || !grounding.required,
    generatorModelId,
  });
  const tokens = stage3rUsageTokens(usageParts);
  const cost = estimatedPriorityCost(usageParts);
  return {
    caseItem,
    exactFinalResponse,
    responseHash,
    generatorModelId,
    firstVerifierModelId,
    finalVerifierModelId: finalVerification.modelId,
    deterministicDeliveryEligible,
    groundedHeraFacts: grounding.grounded || !grounding.required,
    judgeResults,
    ...consensus,
    providerSendCount: 0,
    duplicateFinalCandidates: 0,
    modelUsage: asJson({
      parts: usageParts,
      aggregateTokens: tokens,
      pipelineCalls,
      judgeCalls: instrumented.length,
      pricingSnapshot: "vercel-ai-gateway-2026-08-27-priority-conservative",
      pricing: PRIORITY_PRICE_SNAPSHOT_2026_08_27,
      costCoverage: cost.costUsd === null
        ? "incomplete"
        : "successful_calls_reported_by_ai_sdk",
      costIssues: cost.issues,
    }),
    costUsd: cost.costUsd,
    latencyMs: Date.now() - started,
    modelCallCount: pipelineCalls + instrumented.length,
  };
}
