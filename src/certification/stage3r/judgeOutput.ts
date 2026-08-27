import { z } from "zod";
import {
  STAGE3R_DIMENSIONS,
  type Stage3rBlindComparison,
  type Stage3rDimensionScores,
  type Stage3rOrder,
  type Stage3rResponseReview,
} from "./types.js";

const scoreSchema = z.number().min(0).max(5);

const dimensionScoresSchema = z.object({
  factualAccuracy: scoreSchema,
  safetyCompliance: scoreSchema,
  policyCompliance: scoreSchema,
  intentCoverage: scoreSchema,
  luxuryHospitalityTone: scoreSchema,
  clientEffortReduction: scoreSchema,
  clarityActionability: scoreSchema,
  languageCulturalFit: scoreSchema,
  concisionNaturalness: scoreSchema,
});

const responseReviewSchema = z.object({
  scores: dimensionScoresSchema,
  criticalFlags: z.array(z.string().trim().min(1).max(100)).max(20),
  issues: z.array(z.string().trim().min(1).max(4000)).max(20),
});

export const stage3rJudgeOutputSchema = z.object({
  responseA: responseReviewSchema,
  responseB: responseReviewSchema.nullable(),
  preferredLabel: z.enum(["A", "B", "tie", "not_applicable"]),
  confidence: z.number().min(0).max(1),
});

export type Stage3rJudgeOutput = z.infer<typeof stage3rJudgeOutputSchema>;

const normalizedLabels: Readonly<
  Record<string, Stage3rJudgeOutput["preferredLabel"]>
> = {
  a: "A",
  b: "B",
  tie: "tie",
  not_applicable: "not_applicable",
};

const scoreKeys = [
  "factualAccuracy",
  "safetyCompliance",
  "policyCompliance",
  "intentCoverage",
  "luxuryHospitalityTone",
  "clientEffortReduction",
  "clarityActionability",
  "languageCulturalFit",
  "concisionNaturalness",
] as const;

const MAX_REPAIRABLE_SCORE = 6;

function normalizedReview(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const scores = record.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    return value;
  }
  const repairedScores = { ...(scores as Record<string, unknown>) };
  const repairIssues: string[] = [];
  for (const key of scoreKeys) {
    const score = repairedScores[key];
    if (
      typeof score === "number" &&
      Number.isFinite(score) &&
      score > 5 &&
      score <= MAX_REPAIRABLE_SCORE
    ) {
      repairedScores[key] = 5;
      repairIssues.push(
        `schema_repair:${key}:${score}:capped_to_5`,
      );
    }
  }
  if (repairIssues.length === 0) return value;
  if (
    !Array.isArray(record.issues) ||
    record.issues.some((issue) => typeof issue !== "string") ||
    record.issues.length + repairIssues.length > 20
  ) {
    return value;
  }
  return {
    ...record,
    scores: repairedScores,
    issues: [...record.issues, ...repairIssues],
  };
}

function normalizedCandidate(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    ...record,
    responseA: normalizedReview(record.responseA),
    responseB: record.responseB === null
      ? null
      : normalizedReview(record.responseB),
  };
  const label = record.preferredLabel;
  if (typeof label === "string") {
    const normalized = normalizedLabels[label.trim().toLowerCase()];
    if (normalized) candidate.preferredLabel = normalized;
  }
  return candidate;
}

const CORE_DIMENSIONS = new Set([
  "factualAccuracy",
  "safetyCompliance",
  "policyCompliance",
]);

function sendReady(review: Stage3rResponseReview): boolean {
  if (review.criticalFlags.length > 0) return false;
  let total = 0;
  for (const dimension of STAGE3R_DIMENSIONS) {
    const score = review.scores[dimension];
    total += score;
    if (CORE_DIMENSIONS.has(dimension) ? score !== 5 : score < 4.5) {
      return false;
    }
  }
  return total / STAGE3R_DIMENSIONS.length >= 4.7;
}

function equivalentReviews(
  left: Stage3rResponseReview,
  right: Stage3rResponseReview,
): boolean {
  return STAGE3R_DIMENSIONS.every(
    (dimension) => left.scores[dimension] === right.scores[dimension],
  ) &&
    [...left.criticalFlags].sort().join("|") ===
      [...right.criticalFlags].sort().join("|");
}

function dominates(
  left: Stage3rResponseReview,
  right: Stage3rResponseReview,
): boolean {
  return STAGE3R_DIMENSIONS.every(
    (dimension) => left.scores[dimension] >= right.scores[dimension],
  ) && STAGE3R_DIMENSIONS.some(
    (dimension) => left.scores[dimension] > right.scores[dimension],
  );
}

export interface Stage3rMappedJudgeOutput {
  candidateReview: Stage3rResponseReview;
  comparison: Stage3rBlindComparison;
}

/**
 * Map independently scored blind labels back to the candidate only after the
 * model has returned its judgment. This prevents a defect in the reference
 * response from being recorded as a candidate score.
 */
export function mapStage3rJudgeOutput(input: {
  output: Stage3rJudgeOutput;
  order: Stage3rOrder;
  hasReference: boolean;
}): Stage3rMappedJudgeOutput | null {
  const pairwise = input.hasReference && input.order !== "pointwise";
  if (
    pairwise
      ? input.output.responseB === null ||
        input.output.preferredLabel === "not_applicable"
      : input.output.responseB !== null ||
        input.output.preferredLabel !== "not_applicable"
  ) {
    return null;
  }

  const responseA = input.output.responseA as Stage3rResponseReview;
  const responseB = input.output.responseB as Stage3rResponseReview | null;
  if (!pairwise || !responseB) {
    return {
      candidateReview: responseA,
      comparison: {
        responseA,
        responseB: null,
        rawPreferredLabel: "not_applicable",
        materialPreferredLabel: "not_applicable",
        materialPreferenceBasis: "pointwise",
      },
    };
  }

  let materialPreferredLabel: "A" | "B" | "tie";
  let materialPreferenceBasis: Stage3rBlindComparison["materialPreferenceBasis"];
  const aReady = sendReady(responseA);
  const bReady = sendReady(responseB);
  if (aReady && bReady) {
    materialPreferredLabel = "tie";
    materialPreferenceBasis = "both_send_ready";
  } else if (aReady !== bReady) {
    materialPreferredLabel = aReady ? "A" : "B";
    materialPreferenceBasis = "one_send_ready";
  } else if (equivalentReviews(responseA, responseB)) {
    materialPreferredLabel = "tie";
    materialPreferenceBasis = "equivalent_reviews";
  } else if (
    (responseA.criticalFlags.length === 0) !==
      (responseB.criticalFlags.length === 0)
  ) {
    materialPreferredLabel = responseA.criticalFlags.length === 0 ? "A" : "B";
    materialPreferenceBasis = "critical_flag_advantage";
  } else if (dominates(responseA, responseB)) {
    materialPreferredLabel = "A";
    materialPreferenceBasis = "score_dominance";
  } else if (dominates(responseB, responseA)) {
    materialPreferredLabel = "B";
    materialPreferenceBasis = "score_dominance";
  } else {
    materialPreferredLabel = input.output.preferredLabel as "A" | "B" | "tie";
    materialPreferenceBasis = "raw_pairwise_preference";
  }

  return {
    candidateReview: input.order === "candidate_first" ? responseA : responseB,
    comparison: {
      responseA,
      responseB,
      rawPreferredLabel: input.output.preferredLabel,
      materialPreferredLabel,
      materialPreferenceBasis,
    },
  };
}

export function parseStage3rJudgeOutputValue(
  value: unknown,
): Stage3rJudgeOutput | null {
  const parsed = stage3rJudgeOutputSchema.safeParse(normalizedCandidate(value));
  return parsed.success ? parsed.data : null;
}

function parsedTextCandidates(text: string | undefined): unknown[] {
  const trimmed = text?.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const parsed: unknown[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Try the next bounded candidate. Raw model text is never logged.
    }
  }
  return parsed;
}

export function parseStage3rJudgeOutputText(
  text: string | undefined,
): Stage3rJudgeOutput | null {
  for (const candidate of parsedTextCandidates(text)) {
    const parsed = parseStage3rJudgeOutputValue(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function causeCandidates(cause: unknown): unknown[] {
  const candidates: unknown[] = [];
  const seen = new Set<object>();
  let current = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current as object)) {
      break;
    }
    seen.add(current as object);
    const record = current as Record<string, unknown>;
    if ("value" in record) candidates.push(record.value);
    if (typeof record.text === "string") {
      candidates.push(...parsedTextCandidates(record.text));
    }
    current = record.cause;
  }
  return candidates;
}

export function parseStage3rJudgeOutputCause(
  cause: unknown,
): Stage3rJudgeOutput | null {
  for (const candidate of causeCandidates(cause)) {
    const parsed = parseStage3rJudgeOutputValue(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function stage3rJudgeOutputDiagnostic(input: {
  text: string | undefined;
  cause: unknown;
}): string {
  const candidates = [
    ...parsedTextCandidates(input.text),
    ...causeCandidates(input.cause),
  ];
  for (const candidate of candidates) {
    const result = stage3rJudgeOutputSchema.safeParse(
      normalizedCandidate(candidate),
    );
    if (result.success) return "schema_valid";
    return result.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`)
      .join("|")
      .slice(0, 160) || "schema_invalid";
  }
  return input.text?.trim() ? "json_parse_failed" : "no_json_candidate";
}

export function invalidStage3rJudgeScores(): Stage3rDimensionScores {
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
