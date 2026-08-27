import { z } from "zod";
import type { Stage3rDimensionScores } from "./types.js";

const scoreSchema = z.number().min(0).max(5);

export const stage3rJudgeOutputSchema = z.object({
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
  issues: z.array(z.string().trim().min(1).max(4000)).max(20),
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

function normalizedCandidate(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const candidate: Record<string, unknown> = { ...record };
  const label = record.preferredLabel;
  if (typeof label === "string") {
    const normalized = normalizedLabels[label.trim().toLowerCase()];
    if (normalized) candidate.preferredLabel = normalized;
  }

  const scores = record.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    return candidate;
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
  if (repairIssues.length === 0) return candidate;
  if (
    !Array.isArray(record.issues) ||
    record.issues.some((issue) => typeof issue !== "string") ||
    record.issues.length + repairIssues.length > 20
  ) {
    return candidate;
  }
  candidate.scores = repairedScores;
  candidate.issues = [...record.issues, ...repairIssues];
  return candidate;
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
