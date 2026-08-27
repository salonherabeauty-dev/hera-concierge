import { createHash } from "node:crypto";
import { gateway } from "@ai-sdk/gateway";
import {
  isStepCount,
  NoObjectGeneratedError,
  Output,
  ToolLoopAgent,
} from "ai";
import { z } from "zod";
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
  type Stage3rJudgeConfiguration,
} from "./judge.js";

const scoreSchema = z.number().min(0).max(5);
const judgeSchema = z.object({
  scores: z.object({
    factualAccuracy: scoreSchema,
    safetyCompliance: scoreSchema,
    policyCompliance: scoreSchema,
    intentCoverage: scoreSchema,
    luxuryHospitalityTone: scoreSchema,
    clientEffortReduction: scoreSchema,
    clarityActionability: scoreSchema,
    languageCulturalFit: scoreSchema,
    concisionNaturalness: scoreSchema,
  }),
  criticalFlags: z.array(z.string().trim().min(1).max(100)).max(20),
  issues: z.array(z.string().trim().min(1).max(220)).max(20),
  preferredLabel: z.enum(["A", "B", "tie", "not_applicable"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(400).optional(),
});

type JudgeOutput = z.infer<typeof judgeSchema>;

export function parseStage3rJudgeOutputText(text: string | undefined): JudgeOutput | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = judgeSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Try the next bounded candidate. Raw model text is never logged.
    }
  }
  return null;
}

function invalidJudgeScores(): Stage3rDimensionScores {
  return {
    factualAccuracy: 0,
    safetyCompliance: 0,
    policyCompliance: 0,
    intentCoverage: 0,
    luxuryHospitalityTone: 0,
    clientEffortReduction: 0,
    clarityActionability: 0,
    languageCulturalFit: 0,
    concisionNaturalness: 0,
  };
}

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
}): Promise<InstrumentedJudgeResult> {
  const displayed = pair({
    order: input.order,
    candidate: input.candidateResponse,
    reference: input.case.referenceResponse,
  });
  const agent = new ToolLoopAgent({
    id: input.configuration.judgeId,
    model: gateway(input.configuration.modelId),
    instructions: STAGE3R_JUDGE_INSTRUCTIONS,
    tools: {},
    output: Output.object({ schema: judgeSchema }),
    stopWhen: isStepCount(2),
    maxOutputTokens: 1800,
    temperature: 0,
    reasoning: "high",
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
    const generated = await agent.generate({
      prompt: JSON.stringify({
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
        blindOrder: input.order,
        responseA: displayed.responseA,
        responseB: displayed.responseB,
        responseModelIdentityWithheld: true,
        referenceIsNotAutomaticallyCorrect: true,
      }),
      timeout: 90_000,
    });
    const output = generated.output;
    const metadata = jsonSafe((generated as unknown as { providerMetadata?: unknown }).providerMetadata);
    const usage = jsonSafe((generated as unknown as { totalUsage?: unknown; usage?: unknown }).totalUsage ?? generated.usage);
    return {
      result: {
        judgeId: input.configuration.judgeId,
        provider: input.configuration.provider,
        modelId: generated.response.modelId,
        generatorModelId: input.generatorModelId,
        order: input.order,
        responseHash: input.responseHash,
        scores: output.scores as Stage3rDimensionScores,
        criticalFlags: output.criticalFlags,
        issues: output.issues,
        preference: preference(
          output.preferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        confidence: output.confidence,
        repeatedRun: input.repeatedRun,
      },
      usage,
      providerMetadata: metadata,
      costUsd: findCost(metadata),
      latencyMs: Date.now() - started,
      structuredOutputValid: true,
    };
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    const repaired = parseStage3rJudgeOutputText(error.text);
    const modelId = error.response?.modelId || input.configuration.modelId;
    const usage = jsonSafe(error.usage);
    logOperationalEvent(
      repaired ? "warn" : "error",
      repaired
        ? "stage3r_judge_structured_output_repaired"
        : "stage3r_judge_structured_output_invalid",
      {
        judgeId: input.configuration.judgeId,
        attemptedModel: input.configuration.modelId,
        responseModel: modelId,
        order: input.order,
        repeatedRun: input.repeatedRun,
        finishReason: error.finishReason ?? null,
        outputTokens: error.usage?.outputTokens ?? null,
      },
    );
    if (!repaired) {
      return {
        result: {
          judgeId: input.configuration.judgeId,
          provider: input.configuration.provider,
          modelId,
          generatorModelId: input.generatorModelId,
          order: input.order,
          responseHash: input.responseHash,
          scores: invalidJudgeScores(),
          criticalFlags: ["judge_structured_output_invalid"],
          issues: ["Judge response was not valid against the certification schema."],
          preference: "not_applicable",
          confidence: 0,
          repeatedRun: input.repeatedRun,
        },
        usage,
        providerMetadata: null,
        costUsd: null,
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
        scores: repaired.scores as Stage3rDimensionScores,
        criticalFlags: repaired.criticalFlags,
        issues: repaired.issues,
        preference: preference(
          repaired.preferredLabel,
          input.order,
          Boolean(input.case.referenceResponse),
        ),
        confidence: repaired.confidence,
        repeatedRun: input.repeatedRun,
      },
      usage,
      providerMetadata: null,
      costUsd: null,
      latencyMs: Date.now() - started,
      structuredOutputValid: true,
    };
  }
}
