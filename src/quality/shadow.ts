export const SHADOW_RUBRIC_VERSION = "hera-shadow-quality-v1";

export interface ShadowDimensionAverages {
  factualAccuracy: number;
  safetyCompliance: number;
  policyCompliance: number;
  intentCoverage: number;
  luxuryTone: number;
  effortReduction: number;
  clarityActionability: number;
  languageFit: number;
  concisionNaturalness: number;
}

export interface ShadowQualitySnapshot {
  since: string;
  eligibleCases: number;
  humanReviewedCases: number;
  launchMetricCases: number;
  unreviewedCases: number;
  passCases: number;
  failCases: number;
  needsReviewCases: number;
  passRate: number;
  criticalFlagCases: number;
  averageOverallScore: number;
  dimensionAverages: ShadowDimensionAverages;
  latencyMs: {
    responseP95: number;
    verifierP95: number;
  };
  providerSendCount: number;
  duplicateCandidateCases: number;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as UnknownRecord;
}

function number(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseShadowQualitySnapshot(value: unknown): ShadowQualitySnapshot {
  const root = record(value, "shadow quality snapshot");
  const dimensions = record(root.dimensionAverages, "dimension averages");
  const latency = record(root.latencyMs, "latency metrics");
  return {
    since: string(root.since, "snapshot since"),
    eligibleCases: number(root.eligibleCases, "eligible cases"),
    humanReviewedCases: number(root.humanReviewedCases, "human reviewed cases"),
    launchMetricCases: number(root.launchMetricCases, "launch metric cases"),
    unreviewedCases: number(root.unreviewedCases, "unreviewed cases"),
    passCases: number(root.passCases, "pass cases"),
    failCases: number(root.failCases, "fail cases"),
    needsReviewCases: number(root.needsReviewCases, "needs-review cases"),
    passRate: number(root.passRate, "pass rate"),
    criticalFlagCases: number(root.criticalFlagCases, "critical-flag cases"),
    averageOverallScore: number(root.averageOverallScore, "average overall score"),
    dimensionAverages: {
      factualAccuracy: number(dimensions.factualAccuracy, "factual accuracy"),
      safetyCompliance: number(dimensions.safetyCompliance, "safety compliance"),
      policyCompliance: number(dimensions.policyCompliance, "policy compliance"),
      intentCoverage: number(dimensions.intentCoverage, "intent coverage"),
      luxuryTone: number(dimensions.luxuryTone, "luxury tone"),
      effortReduction: number(dimensions.effortReduction, "effort reduction"),
      clarityActionability: number(
        dimensions.clarityActionability,
        "clarity and actionability",
      ),
      languageFit: number(dimensions.languageFit, "language fit"),
      concisionNaturalness: number(
        dimensions.concisionNaturalness,
        "concision and naturalness",
      ),
    },
    latencyMs: {
      responseP95: number(latency.responseP95, "response p95"),
      verifierP95: number(latency.verifierP95, "verifier p95"),
    },
    providerSendCount: number(root.providerSendCount, "provider send count"),
    duplicateCandidateCases: number(
      root.duplicateCandidateCases,
      "duplicate candidate cases",
    ),
  };
}

export function shadowSince(
  value: string | string[] | undefined,
  now = Date.now(),
): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const parsed = Date.parse(candidate);
  const oldest = now - 90 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(parsed) || parsed > now + 5 * 60 * 1000 || parsed < oldest) {
    throw new Error("Invalid shadow quality window");
  }
  return new Date(parsed).toISOString();
}
