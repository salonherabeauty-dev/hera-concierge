import { createHash } from "node:crypto";
import {
  gateway,
  GatewayInternalServerError,
  GatewayResponseError,
} from "@ai-sdk/gateway";
import {
  isStepCount,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  ToolLoopAgent,
  type LanguageModel,
} from "ai";
import {
  createGenerationAttemptLifecycle,
  type GenerationAttemptLedger,
} from "../../ai/generationAttempts.js";
import { logOperationalEvent } from "../../observability/log.js";
import {
  type Stage3rCase,
  type Stage3rDimensionScores,
  type Stage3rJudgeResult,
  type Stage3rOrder,
  type Stage3rPreference,
} from "./types.js";
import {
  STAGE3R_JUDGE_INSTRUCTIONS,
  STAGE3R_JUDGE_MAX_OUTPUT_TOKENS,
  type Stage3rJudgeConfiguration,
} from "./judge.js";
import {
  invalidStage3rJudgeScores,
  mapStage3rJudgeOutput,
  parseStage3rJudgeOutputCause,
  parseStage3rJudgeOutputText,
  stage3rJudgeOutputDiagnostic,
  stage3rJudgeOutputSchema,
} from "./judgeOutput.js";

export { parseStage3rJudgeOutputText } from "./judgeOutput.js";

export const STAGE3R_JUDGE_GATEWAY_RESPONSE_RETRIES = 1;

function anonymousUser(caseId: string): string {
  return `hera-stage3r-${createHash("sha256").update(caseId).digest("hex").slice(0, 24)}`;
}

function pair(input: {
  order: Stage3rOrder;
  candidate: string;
  reference: string | null;
}): { responseA: string; responseB: string | null } {
  if (!input.reference || input.order === "pointwise") {
    return { responseA: input.candidate, responseB: null };
  }
  return input.order === "candidate_first"
    ? { responseA: input.candidate, responseB: input.reference }
    : { responseA: input.reference, responseB: input.candidate };
}

function preference(
  label: "A" | "B" | "tie" | "not_applicable",
  order: Stage3rOrder,
  hasReference: boolean,
): Stage3rPreference {
  if (!hasReference || order === "pointwise" || label === "not_applicable") {
    return "not_applicable";
  }
  if (label === "tie") return "tie";
  if (order === "candidate_first") return label === "A" ? "candidate" : "reference";
  return label === "A" ? "reference" : "candidate";
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function findCost(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  let total = 0;
  let found = false;
  const visit = (node: unknown, key = ""): void => {
    if (typeof node === "number" && Number.isFinite(node) && /(?:^|_)(?:cost|costusd|totalcost|estimatedcost)(?:$|_)/i.test(key.replace(/[^a-z0-9_]/gi, ""))) {
      total += node;
      found = true;
      return;
    }
    if (typeof node === "string" && /cost/i.test(key)) {
      const parsed = Number(node);
      if (Number.isFinite(parsed) && parsed >= 0) {
        total += parsed;
        found = true;
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, key));
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, childKey);
      }
    }
  };
  visit(value);
  return found ? total : null;
}

export interface InstrumentedJudgeResult {
  result: Stage3rJudgeResult;
  usage: unknown;
  providerMetadata: unknown;
  costUsd: number | null;
  latencyMs: number;
  structuredOutputValid: boolean;
}

export async function judgeStage3rCaseWithUsage(input: {
  configuration: Stage3rJudgeConfiguration;
  case: Stage3rCase;
  candidateResponse: string;
  responseHash: string;
  generatorModelId: string | null;
  approvedEvidence: unknown;
  order: Stage3rOrder;
  repeatedRun: number;
  modelFactory?: (modelId: string) => LanguageModel;
  generationAttemptLedger?: GenerationAttemptLedger;
}): Promise<InstrumentedJudgeResult> {
  const displayed = pair({
    order: input.order,
    candidate: input.candidateResponse,
    reference: input.case.referenceResponse,
  });
  const attempts = createGenerationAttemptLifecycle({
    ledger: input.generationAttemptLedger,
    stage: `judge:${input.configuration.judgeId}:${input.order}:${input.repeatedRun}`,
    configuredModelId: input.configuration.modelId,
  });
  let observedModelId = input.configuration.modelId;
  let observedFinishReason: string | null = null;
  let observedUsage: unknown = null;
  let observedProviderMetadata: unknown = null;
  const agent = new ToolLoopAgent({
    id: input.configuration.judgeId,
    model:
      input.modelFactory?.(input.configuration.modelId) ??
      gateway(input.configuration.modelId),
    instructions: STAGE3R_JUDGE_INSTRUCTIONS,
    tools: {},
    output: Output.object({
      schema: stage3rJudgeOutputSchema,
      name: "stage3r_judgment",
      description:
        "Independent blind-label reviews for each displayed response and a pairwise material preference.",
    }),
    stopWhen: isStepCount(2),
    prepareStep: async (step) => {
      await attempts.prepareStep(step);
      return {};
    },
    maxRetries: 0,
    maxOutputTokens: STAGE3R_JUDGE_MAX_OUTPUT_TOKENS,
    temperature: 0,
    reasoning: "high",
    onStepEnd: async (step) => {
      observedModelId = step.response.modelId || input.configuration.modelId;
      observedFinishReason = step.finishReason;
      observedUsage = jsonSafe(step.usage);
      await attempts.onStepEnd(step);
    },
    providerOptions: {
      gateway: {
        tags: ["hera", "stage3r", "certification", input.configuration.emphasis],
        user: anonymousUser(input.case.id),
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });
  const started = Date.now();
  try {
    const prompt = JSON.stringify({
      caseId: input.case.id,
      family: input.case.family,
      caseType: input.case.caseType,
      language: input.case.language,
      minimumRisk: input.case.minimumRisk,
      highConsequence: input.case.highConsequence,
      multiIntent: input.case.multiIntent,
      adversarial: input.case.adversarial,
      clientMessage: input.case.message,
      conversationHistory: input.case.history,
      requiredElements: input.case.requiredElements,
      forbiddenClaims: input.case.forbiddenClaims,
      approvedEvidence: input.approvedEvidence,
      judgeEmphasis: input.configuration.emphasis,
      responseA: displayed.responseA,
      responseB: displayed.responseB,
      blindLabelsOnly: true,
      responseModelIdentityWithheld: true,
      referenceIsNotAutomaticallyCorrect: true,
    });
    let gatewayRetries = 0;
    let generated;
    for (;;) {
      try {
        generated = await agent.generate({ prompt, timeout: 90_000 });
        break;
      } catch (error) {
        const retryableGatewayFailure =
          GatewayResponseError.isInstance(error) ||
          GatewayInternalServerError.isInstance(error);
        if (
          !retryableGatewayFailure ||
          gatewayRetries >= STAGE3R_JUDGE_GATEWAY_RESPONSE_RETRIES
        ) {
          throw error;
        }
        await attempts.failOpen(error);
        gatewayRetries += 1;
        logOperationalEvent("warn", "stage3r_judge_gateway_response_retry", {
          judgeId: input.configuration.judgeId,
          attemptedModel: input.configuration.modelId,
          order: input.order,
          repeatedRun: input.repeatedRun,
          gatewayRetry: gatewayRetries,
        });
      }
    }
    attempts.assertHealthy();
    observedModelId = generated.response.modelId || input.configuration.modelId;
    observedFinishReason = generated.finishReason;
    observedProviderMetadata = jsonSafe(
      (generated as unknown as { providerMetadata?: unknown }).providerMetadata,
    );
    observedUsage = jsonSafe(
      (generated as unknown as { totalUsage?: unknown; usage?: unknown }).totalUsage ??
        generated.usage,
    );
    if (generated.finishReason !== "stop") {
      logOperationalEvent("error", "stage3r_judge_non_stop_finish_reason", {
        judgeId: input.configuration.judgeId,
        attemptedModel: input.configuration.modelId,
        responseModel: observedModelId,
        order: input.order,
        repeatedRun: input.repeatedRun,
        finishReason: generated.finishReason,
      });
      return {
        result: {
          judgeId: input.configuration.judgeId,
          provider: input.configuration.provider,
          modelId: observedModelId,
          generatorModelId: input.generatorModelId,
          order: input.order,
          responseHash: input.responseHash,
          scores: invalidStage3rJudgeScores(),
          criticalFlags: ["judge_structured_output_invalid"],
          issues: ["Judge response ended before its structured judgment was complete."],
          preference: "not_applicable",
          rawPreference: "not_applicable",
          confidence: 0,
          repeatedRun: input.repeatedRun,
        },
        usage: observedUsage,
        providerMetadata: observedProviderMetadata,
        costUsd: findCost(observedProviderMetadata),
        latencyMs: Date.now() - started,
        structuredOutputValid: false,
      };
    }
    const output = generated.output;
    const mapped = mapStage3rJudgeOutput({
      output,
      order: input.order,
      hasReference: Boolean(input.case.referenceResponse),
    });
    if (!mapped) {
      logOperationalEvent("error", "stage3r_judge_presentation_output_invalid", {
        judgeId: input.configuration.judgeId,
        responseModel: generated.response.modelId,
        order: input.order,
        repeatedRun: input.repeatedRun,
      });
      return {
        result: {
          judgeId: input.configuration.judgeId,
          provider: input.configuration.provider,
          modelId: generated.response.modelId,
          generatorModelId: input.generatorModelId,
          order: input.order,
          responseHash: input.responseHash,
          scores: invalidStage3rJudgeScores(),
          criticalFlags: ["judge_structured_output_invalid"],
          issues: ["Judge response did not independently review the displayed blind responses."],
          preference: "not_applicable",
          rawPreference: "not_applicable",
          confidence: 0,
          repeatedRun: input.repeatedRun,
        },
        usage: observedUsage,
        providerMetadata: observedProviderMetadata,
        costUsd: findCost(observedProviderMetadata),
        latencyMs: Date.now() - started,
        structuredOutputValid: false,
      };
    }
    return {
      result: {
        judgeId: input.configuration.judgeId,
        provider: input.configuration.provider,
        modelId: generated.response.modelId,
        generatorModelId: input.generatorModelId,
        order: input.order,
        responseHash: input.responseHash,
        scores: mapped.candidateReview.scores as Stage3rDimensionScores,
        criticalFlags: mapped.candidateReview.criticalFlags,
        issues: mapped.candidateReview.issues,
        preference: preference(
          mapped.comparison.materialPreferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        rawPreference: preference(
          mapped.comparison.rawPreferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        comparison: mapped.comparison,
        confidence: output.confidence,
        repeatedRun: input.repeatedRun,
      },
      usage: observedUsage,
      providerMetadata: observedProviderMetadata,
      costUsd: findCost(observedProviderMetadata),
      latencyMs: Date.now() - started,
      structuredOutputValid: true,
    };
  } catch (error) {
    await attempts.failOpen(error);
    const objectError = NoObjectGeneratedError.isInstance(error) ? error : null;
    const outputError = NoOutputGeneratedError.isInstance(error) ? error : null;
    if (!objectError && !outputError) throw error;
    const textRepair = parseStage3rJudgeOutputText(objectError?.text);
    const errorCause = objectError?.cause ?? outputError?.cause;
    const causeRepair = textRepair
      ? null
      : parseStage3rJudgeOutputCause(errorCause);
    const repaired = textRepair ?? causeRepair;
    const mapped = repaired
      ? mapStage3rJudgeOutput({
          output: repaired,
          order: input.order,
          hasReference: Boolean(input.case.referenceResponse),
        })
      : null;
    const repairSource = textRepair ? "text" : causeRepair ? "cause_value" : null;
    const modelId = objectError?.response?.modelId || observedModelId;
    const usage = objectError ? jsonSafe(objectError.usage) : observedUsage;
    logOperationalEvent(
      mapped ? "warn" : "error",
      mapped
        ? "stage3r_judge_structured_output_repaired"
        : "stage3r_judge_structured_output_invalid",
      {
        judgeId: input.configuration.judgeId,
        attemptedModel: input.configuration.modelId,
        responseModel: modelId,
        order: input.order,
        repeatedRun: input.repeatedRun,
        finishReason: objectError?.finishReason ?? observedFinishReason,
        outputTokens: objectError?.usage?.outputTokens ?? null,
        repairSource,
        outputDiagnostic: stage3rJudgeOutputDiagnostic({
          text: objectError?.text,
          cause: errorCause,
        }),
      },
    );
    if (!mapped) {
      return {
        result: {
          judgeId: input.configuration.judgeId,
          provider: input.configuration.provider,
          modelId,
          generatorModelId: input.generatorModelId,
          order: input.order,
          responseHash: input.responseHash,
          scores: invalidStage3rJudgeScores(),
          criticalFlags: ["judge_structured_output_invalid"],
          issues: ["Judge response was not valid against the certification schema."],
          preference: "not_applicable",
          rawPreference: "not_applicable",
          confidence: 0,
          repeatedRun: input.repeatedRun,
        },
        usage,
        providerMetadata: observedProviderMetadata,
        costUsd: findCost(observedProviderMetadata),
        latencyMs: Date.now() - started,
        structuredOutputValid: false,
      };
    }
    return {
      result: {
        judgeId: input.configuration.judgeId,
        provider: input.configuration.provider,
        modelId,
        generatorModelId: input.generatorModelId,
        order: input.order,
        responseHash: input.responseHash,
        scores: mapped.candidateReview.scores as Stage3rDimensionScores,
        criticalFlags: mapped.candidateReview.criticalFlags,
        issues: mapped.candidateReview.issues,
        preference: preference(
          mapped.comparison.materialPreferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        rawPreference: preference(
          mapped.comparison.rawPreferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        comparison: mapped.comparison,
        confidence: repaired!.confidence,
        repeatedRun: input.repeatedRun,
      },
      usage,
      providerMetadata: observedProviderMetadata,
      costUsd: findCost(observedProviderMetadata),
      latencyMs: Date.now() - started,
      structuredOutputValid: true,
    };
  }
}
