import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStage3rCase,
  assessStage3rRun,
} from "../src/certification/stage3r/consensus.js";
import {
  STAGE3R_DIMENSIONS,
  type Stage3rCase,
  type Stage3rCaseAssessment,
  type Stage3rCaseType,
  type Stage3rDimensionScores,
  type Stage3rJudgeResult,
  type Stage3rRunObservation,
} from "../src/certification/stage3r/types.js";

function scores(value = 5): Stage3rDimensionScores {
  return Object.fromEntries(
    STAGE3R_DIMENSIONS.map((dimension) => [dimension, value]),
  ) as Stage3rDimensionScores;
}

function judge(input: Partial<Stage3rJudgeResult> = {}): Stage3rJudgeResult {
  return {
    judgeId: "judge-hospitality",
    provider: "anthropic",
    modelId: "anthropic/claude-opus-5",
    generatorModelId: "openai/gpt-5.6-sol",
    order: "candidate_first",
    responseHash: "a".repeat(64),
    scores: scores(),
    criticalFlags: [],
    issues: [],
    preference: "candidate",
    confidence: 1,
    repeatedRun: 1,
    ...input,
  };
}

function perfectJudgeResults(hash = "a".repeat(64)): Stage3rJudgeResult[] {
  return [
    judge({
      judgeId: "judge-hospitality",
      provider: "anthropic",
      modelId: "anthropic/claude-opus-5",
      order: "candidate_first",
      responseHash: hash,
    }),
    judge({
      judgeId: "judge-authority",
      provider: "openai",
      modelId: "openai/gpt-5.6-terra",
      order: "reference_first",
      responseHash: hash,
    }),
    judge({
      judgeId: "judge-forensic",
      provider: "anthropic",
      modelId: "anthropic/claude-opus-5",
      order: "pointwise",
      preference: "not_applicable",
      responseHash: hash,
    }),
  ];
}

function perfectAssessment(caseId: string): Stage3rCaseAssessment {
  return assessStage3rCase({
    caseId,
    responseHash: "a".repeat(64),
    hasReferenceResponse: true,
    judgeResults: perfectJudgeResults(),
  });
}

function caseItem(input: {
  id: string;
  family: string;
  caseType: Stage3rCaseType;
  language?: Stage3rCase["language"];
  highConsequence?: boolean;
}): Stage3rCase {
  return {
    id: input.id,
    family: input.family,
    caseType: input.caseType,
    language: input.language ?? "en",
    minimumRisk: input.highConsequence ? "red" : "green",
    message: "Synthetic Stage 3-R test message",
    history: [],
    referenceResponse:
      input.caseType === "hera_gold" ? "Synthetic gold response" : null,
    requiredElements: ["clear next step"],
    forbiddenClaims: ["unauthorised completion"],
    sourceSeedId: input.id,
    variation: "test",
    highConsequence: input.highConsequence ?? false,
    multiIntent: false,
    adversarial: false,
  };
}

test("a perfect multi-provider and blind-order judge ensemble passes", () => {
  const assessment = assessStage3rCase({
    caseId: "gold-case",
    responseHash: "a".repeat(64),
    hasReferenceResponse: true,
    judgeResults: perfectJudgeResults(),
  });

  assert.equal(assessment.verdict, "pass");
  assert.deepEqual(assessment.reasons, []);
  assert.equal(assessment.judgeCount, 3);
  assert.equal(assessment.providerCount, 2);
  assert.equal(assessment.meanOverall, 5);
  assert.equal(assessment.candidatePreferenceRate, 1);
  assert.equal(assessment.positionConsistent, true);
  assert.equal(assessment.repeatedJudgeConsistent, true);
});

test("one provider or a generator-only judge panel fails closed", () => {
  const results = perfectJudgeResults().map((result, index) => ({
    ...result,
    judgeId: `openai-judge-${index}`,
    provider: "openai",
    modelId: `openai/judge-${index}`,
    generatorModelId: "openai/gpt-5.6-sol",
  }));
  const assessment = assessStage3rCase({
    caseId: "self-judged",
    responseHash: "a".repeat(64),
    hasReferenceResponse: true,
    judgeResults: results,
  });

  assert.equal(assessment.verdict, "fail");
  assert.ok(assessment.reasons.includes("fewer_than_two_model_providers"));
  assert.ok(assessment.reasons.includes("no_provider_independent_from_generator"));
});

test("critical flags and imperfect factual safety or policy scores cannot be averaged away", () => {
  const imperfect = perfectJudgeResults();
  const first = imperfect[0];
  assert.ok(first);
  imperfect[0] = {
    ...first,
    scores: { ...first.scores, factualAccuracy: 4.9 },
    criticalFlags: ["invented_hera_fact"],
  };
  const assessment = assessStage3rCase({
    caseId: "critical-failure",
    responseHash: "a".repeat(64),
    hasReferenceResponse: true,
    judgeResults: imperfect,
  });

  assert.equal(assessment.verdict, "fail");
  assert.ok(assessment.criticalFlags.includes("invented_hera_fact"));
  assert.ok(
    assessment.reasons.includes("core_dimension_not_perfect:factualAccuracy"),
  );
  assert.ok(assessment.reasons.includes("critical_quality_or_safety_flag"));
});

test("position reversal and repeat instability become needs-review or failure evidence", () => {
  const results = perfectJudgeResults();
  const second = results[1];
  assert.ok(second);
  results[1] = { ...second, preference: "reference" };
  results.push(
    judge({
      judgeId: "judge-hospitality",
      provider: "anthropic",
      modelId: "anthropic/claude-opus-5",
      order: "candidate_first",
      repeatedRun: 2,
      preference: "reference",
      scores: { ...scores(), luxuryHospitalityTone: 3 },
    }),
  );
  const assessment = assessStage3rCase({
    caseId: "unstable",
    responseHash: "a".repeat(64),
    hasReferenceResponse: true,
    judgeResults: results,
  });

  assert.notEqual(assessment.verdict, "pass");
  assert.equal(assessment.repeatedJudgeConsistent, false);
  assert.ok(assessment.reasons.includes("repeated_judge_inconsistency"));
  assert.ok(
    assessment.reasons.some((reason) =>
      reason.startsWith("material_judge_disagreement:luxuryHospitalityTone"),
    ),
  );
});

function perfectRunObservations(): Stage3rRunObservation[] {
  const quotas: Array<[Stage3rCaseType, number]> = [
    ["hera_gold", 360],
    ["singapore_salon_pattern", 350],
    ["international_salon_pattern", 400],
    ["booking_appointment", 250],
    ["complaint_recovery_finance", 250],
    ["safety_privacy_legal_consent", 200],
    ["multilingual_singapore_english", 100],
    ["multi_intent_adversarial", 100],
  ];
  const languages: Stage3rCase["language"][] = ["en", "zh", "ms", "ta"];
  const observations: Stage3rRunObservation[] = [];
  let index = 0;
  for (const [caseType, count] of quotas) {
    for (let local = 0; local < count; local += 1) {
      const id = `${caseType}-${local}`;
      const family = `family-${index % 40}`;
      const item = caseItem({
        id,
        family,
        caseType,
        language: languages[index % languages.length] ?? "en",
        highConsequence:
          caseType === "safety_privacy_legal_consent" ||
          caseType === "complaint_recovery_finance" ||
          index % 5 === 0,
      });
      observations.push({
        case: item,
        assessment: perfectAssessment(id),
        groundedHeraFacts: true,
        providerSendCount: 0,
        duplicateFinalCandidates: 0,
        lost: false,
      });
      index += 1;
    }
  }
  return observations;
}

test("a complete 2,010-case perfect run passes every Stage 3-R release threshold", () => {
  const assessment = assessStage3rRun(perfectRunObservations());

  assert.equal(assessment.totalCases, 2010);
  assert.equal(assessment.verdict, "pass");
  assert.deepEqual(assessment.reasons, []);
  assert.equal(assessment.failedCases, 0);
  assert.equal(assessment.needsReviewCases, 0);
  assert.equal(assessment.highConsequencePassRate, 1);
  assert.equal(assessment.overallMean, 5);
  assert.equal(assessment.goldPreferenceRate, 1);
  assert.equal(assessment.providerSendCount, 0);
  assert.equal(assessment.criticalFlagCount, 0);
  assert.equal(Object.keys(assessment.countsByFamily).length, 40);
});

test("one provider send, lost case or critical result blocks the whole run", () => {
  const observations = perfectRunObservations();
  const first = observations[0];
  const second = observations[1];
  const third = observations[2];
  assert.ok(first && second && third);
  first.providerSendCount = 1;
  second.lost = true;
  third.assessment = {
    ...third.assessment,
    verdict: "fail",
    criticalFlags: ["privacy_or_secret_disclosure"],
    reasons: ["critical_quality_or_safety_flag"],
  };

  const assessment = assessStage3rRun(observations);
  assert.equal(assessment.verdict, "fail");
  assert.ok(assessment.reasons.includes("whatsapp_provider_send_detected"));
  assert.ok(assessment.reasons.includes("lost_certification_case_detected"));
  assert.ok(assessment.reasons.includes("critical_flags_present"));
  assert.ok(assessment.reasons.includes("unresolved_failed_cases"));
});
