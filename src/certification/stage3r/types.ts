export const STAGE3R_CERTIFICATION_VERSION = "hera-stage3r-2026-08-27.4";
export const STAGE3R_CORPUS_VERSION = "hera-stage3r-corpus-2026-08-26.1";
export const STAGE3R_JUDGE_PROMPT_VERSION = "hera-stage3r-judge-2026-08-26.1";

export const STAGE3R_DIMENSIONS = [
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

export type Stage3rDimension = (typeof STAGE3R_DIMENSIONS)[number];
export type Stage3rLanguage = "en" | "zh" | "ms" | "ta";
export type Stage3rRisk = "green" | "amber" | "red" | "black";
export type Stage3rCaseType =
  | "hera_gold"
  | "singapore_salon_pattern"
  | "international_salon_pattern"
  | "booking_appointment"
  | "complaint_recovery_finance"
  | "safety_privacy_legal_consent"
  | "multilingual_singapore_english"
  | "multi_intent_adversarial";

export type Stage3rVerdict = "pass" | "fail" | "needs_review";
export type Stage3rPreference = "candidate" | "reference" | "tie" | "not_applicable";
export type Stage3rOrder = "candidate_first" | "reference_first" | "pointwise";

export interface Stage3rSeedScenario {
  id: string;
  category: string;
  message: string;
  minimumRisk: Stage3rRisk;
  securityFlag?: string;
  expectedContainment?: string;
  intents?: string[];
  history?: Array<{
    direction: "inbound" | "outbound";
    text: string;
  }>;
  priorRisk?: Stage3rRisk;
}

export interface Stage3rGoldCase {
  id: string;
  family: string;
  language: Stage3rLanguage;
  risk: Stage3rRisk;
  message: string;
  referenceResponse: string;
  requiredElements: string[];
  forbiddenClaims: string[];
}

export interface Stage3rCase {
  id: string;
  family: string;
  caseType: Stage3rCaseType;
  language: Stage3rLanguage;
  minimumRisk: Stage3rRisk;
  message: string;
  history: Stage3rSeedScenario["history"];
  referenceResponse: string | null;
  requiredElements: string[];
  forbiddenClaims: string[];
  sourceSeedId: string;
  variation: string;
  highConsequence: boolean;
  multiIntent: boolean;
  adversarial: boolean;
}

export type Stage3rDimensionScores = Record<Stage3rDimension, number>;

export interface Stage3rJudgeResult {
  judgeId: string;
  provider: string;
  modelId: string;
  generatorModelId: string | null;
  order: Stage3rOrder;
  responseHash: string;
  scores: Stage3rDimensionScores;
  criticalFlags: string[];
  issues: string[];
  preference: Stage3rPreference;
  confidence: number;
  repeatedRun: number;
}

export interface Stage3rCaseAssessment {
  caseId: string;
  responseHash: string;
  verdict: Stage3rVerdict;
  reasons: string[];
  judgeCount: number;
  providerCount: number;
  meanOverall: number;
  dimensionMeans: Stage3rDimensionScores;
  dimensionRanges: Stage3rDimensionScores;
  criticalFlags: string[];
  candidatePreferenceRate: number | null;
  positionConsistent: boolean;
  repeatedJudgeConsistent: boolean;
}

export interface Stage3rRunObservation {
  case: Stage3rCase;
  assessment: Stage3rCaseAssessment;
  groundedHeraFacts: boolean;
  providerSendCount: number;
  duplicateFinalCandidates: number;
  lost: boolean;
}

export interface Stage3rRunAssessment {
  version: string;
  verdict: Stage3rVerdict;
  reasons: string[];
  totalCases: number;
  passedCases: number;
  failedCases: number;
  needsReviewCases: number;
  highConsequenceCases: number;
  highConsequencePassRate: number;
  overallMean: number;
  intentCoverageRate: number;
  languageFitRate: number;
  goldPreferenceRate: number;
  positionConsistencyRate: number;
  repeatedJudgeConsistencyRate: number;
  heraGroundingRate: number;
  providerSendCount: number;
  duplicateFinalCandidates: number;
  lostCases: number;
  criticalFlagCount: number;
  countsByCaseType: Record<Stage3rCaseType, number>;
  countsByLanguage: Record<Stage3rLanguage, number>;
  countsByFamily: Record<string, number>;
}
