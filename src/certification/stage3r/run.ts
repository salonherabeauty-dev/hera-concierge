import { appendFile, readFile, writeFile } from "node:fs/promises";
import { getAiConfig } from "../../config.js";
import { buildStage3rCorpus } from "./corpus.js";
import { assessStage3rCase, assessStage3rRun } from "./consensus.js";
import {
  buildStage3rJudgeExecutionPlan,
  getStage3rJudgeConfigurations,
  judgeStage3rCase,
} from "./judge.js";
import { runStage3rExactResponse } from "./pipeline.js";
import type {
  Stage3rCaseAssessment,
  Stage3rGoldCase,
  Stage3rJudgeResult,
  Stage3rRunObservation,
  Stage3rSeedScenario,
} from "./types.js";

const scenarios = JSON.parse(
  await readFile(new URL("../../../evals/scenarios.json", import.meta.url), "utf8"),
) as Stage3rSeedScenario[];
const expanded = JSON.parse(
  await readFile(
    new URL("../../../evals/scenarios-expanded.json", import.meta.url),
    "utf8",
  ),
) as Stage3rSeedScenario[];
const goldCases = JSON.parse(
  await readFile(
    new URL("../../../evals/stage3r-gold-cases.json", import.meta.url),
    "utf8",
  ),
) as Stage3rGoldCase[];

const corpus = buildStage3rCorpus({
  seeds: [...scenarios, ...expanded],
  goldCases,
});
const dryRun = process.env.STAGE3R_DRY_RUN === "true";
const fullRun = process.env.STAGE3R_FULL_RUN === "APPROVED_FULL_2010_CASE_RUN";
const startIndex = Math.max(0, Number(process.env.STAGE3R_START_INDEX ?? 0));
const requestedLimit = Math.max(
  1,
  Number(process.env.STAGE3R_LIMIT ?? (fullRun ? corpus.length : 20)),
);
if (!fullRun && requestedLimit > 100) {
  throw new Error(
    "Stage 3-R refuses more than 100 paid cases without STAGE3R_FULL_RUN=APPROVED_FULL_2010_CASE_RUN",
  );
}
if (fullRun && (startIndex !== 0 || requestedLimit < corpus.length)) {
  throw new Error("A full Stage 3-R run must cover the complete corpus from index zero");
}
const selected = corpus.slice(startIndex, startIndex + requestedLimit);
if (selected.length === 0) throw new Error("Stage 3-R selected no cases");
const judgeConfigurations = getStage3rJudgeConfigurations();

const outputPath = process.env.STAGE3R_OUTPUT_PATH?.trim() || null;
if (outputPath) await writeFile(outputPath, "", "utf8");

const emit = async (value: unknown): Promise<void> => {
  const line = `${JSON.stringify(value)}\n`;
  if (outputPath) await appendFile(outputPath, line, "utf8");
  else process.stdout.write(line);
};

await emit({
  event: "stage3r_run_started",
  totalCorpusCases: corpus.length,
  selectedCases: selected.length,
  startIndex,
  dryRun,
  fullRun,
  estimatedMinimumModelCalls: dryRun
    ? 0
    : selected.reduce((sum, item) => {
        const pipelineCalls = item.minimumRisk === "black" ? 1 : 3;
        const judgeCalls = buildStage3rJudgeExecutionPlan(
          item,
          judgeConfigurations,
        ).length;
        return sum + pipelineCalls + judgeCalls;
      }, 0),
  whatsappProviderSendAvailable: false,
});

if (dryRun) {
  const countsByType = Object.fromEntries(
    [...new Set(corpus.map((item) => item.caseType))].map((caseType) => [
      caseType,
      corpus.filter((item) => item.caseType === caseType).length,
    ]),
  );
  const countsByLanguage = Object.fromEntries(
    ["en", "zh", "ms", "ta"].map((language) => [
      language,
      corpus.filter((item) => item.language === language).length,
    ]),
  );
  await emit({
    event: "stage3r_corpus_validated",
    totalCases: corpus.length,
    familyCount: new Set(corpus.map((item) => item.family)).size,
    countsByType,
    countsByLanguage,
    directIdentifiersPermitted: false,
    rawThirdPartyReviewTextIncluded: false,
  });
  process.exit(0);
}

const ai = getAiConfig();
const observations: Stage3rRunObservation[] = [];

for (const [offset, item] of selected.entries()) {
  let assessment: Stage3rCaseAssessment;
  let groundedHeraFacts = false;
  let providerSendCount = 0;
  let duplicateFinalCandidates = 0;
  let lost = false;
  let exactFinalResponse: string | null = null;
  let responseHash = `missing:${item.id}`;
  let responseModelId: string | null = null;
  let firstVerifierModelId: string | null = null;
  let finalVerifierModelId: string | null = null;
  let deliveryEligible = false;
  const judgeResults: Stage3rJudgeResult[] = [];
  let pipelineError: string | null = null;

  try {
    const response = await runStage3rExactResponse({ case: item, ai });
    exactFinalResponse = response.exactFinalResponse;
    responseHash = response.responseHash;
    responseModelId = response.responseModelId;
    firstVerifierModelId = response.firstVerifierModelId;
    finalVerifierModelId = response.finalVerifierModelId;
    deliveryEligible = response.deliveryEligible;
    groundedHeraFacts = response.groundedHeraFacts;
    providerSendCount = response.providerSendCount;
    duplicateFinalCandidates = response.duplicateFinalCandidates;

    for (const execution of buildStage3rJudgeExecutionPlan(
      item,
      judgeConfigurations,
    )) {
      judgeResults.push(
        await judgeStage3rCase({
          configuration: execution.configuration,
          case: item,
          candidateResponse: response.exactFinalResponse,
          responseHash: response.responseHash,
          generatorModelId: response.responseModelId,
          approvedEvidence: {
            responseEvidence: response.responseEvidence,
            grounding: response.grounding,
            decision: response.decision,
            policy: response.policy,
            handoff: response.handoff,
            deterministicQuality: response.deterministicQuality,
            finalVerificationApproved: response.finalVerificationApproved,
            finalVerifierIssues: response.finalVerifierIssues,
            deliveryEligible: response.deliveryEligible,
          },
          order: execution.order,
          repeatedRun: execution.repeatedRun,
        }),
      );
    }
    assessment = assessStage3rCase({
      caseId: item.id,
      responseHash: response.responseHash,
      hasReferenceResponse: Boolean(item.referenceResponse),
      highConsequence: item.highConsequence,
      judgeResults,
    });
    if (!deliveryEligible) {
      assessment = {
        ...assessment,
        verdict: "fail",
        reasons: [...new Set([...assessment.reasons, "runtime_final_quality_gate_blocked"])].sort(),
        criticalFlags: [
          ...new Set([...assessment.criticalFlags, "judge_integrity_failure"]),
        ].sort(),
      };
    }
  } catch (error) {
    lost = true;
    pipelineError = error instanceof Error ? error.message : "unknown_stage3r_error";
    assessment = assessStage3rCase({
      caseId: item.id,
      responseHash,
      hasReferenceResponse: Boolean(item.referenceResponse),
      highConsequence: item.highConsequence,
      judgeResults,
    });
    assessment = {
      ...assessment,
      verdict: "fail",
      reasons: [...new Set([...assessment.reasons, "pipeline_or_judge_execution_failed"])].sort(),
      criticalFlags: [
        ...new Set([...assessment.criticalFlags, "judge_integrity_failure"]),
      ].sort(),
    };
  }

  const observation: Stage3rRunObservation = {
    case: item,
    assessment,
    groundedHeraFacts,
    providerSendCount,
    duplicateFinalCandidates,
    lost,
  };
  observations.push(observation);
  await emit({
    event: "stage3r_case_completed",
    sequence: startIndex + offset + 1,
    caseId: item.id,
    family: item.family,
    caseType: item.caseType,
    language: item.language,
    highConsequence: item.highConsequence,
    responseHash,
    exactFinalResponse,
    responseModelId,
    firstVerifierModelId,
    finalVerifierModelId,
    deliveryEligible,
    judgeResults,
    assessment,
    groundedHeraFacts,
    providerSendCount,
    duplicateFinalCandidates,
    lost,
    pipelineError,
  });
}

if (fullRun) {
  const runAssessment = assessStage3rRun(observations);
  await emit({ event: "stage3r_full_run_completed", runAssessment });
  if (runAssessment.verdict !== "pass") process.exitCode = 1;
} else {
  await emit({
    event: "stage3r_bounded_batch_completed",
    selectedCases: selected.length,
    pass: observations.filter((item) => item.assessment.verdict === "pass").length,
    fail: observations.filter((item) => item.assessment.verdict === "fail").length,
    needsReview: observations.filter(
      (item) => item.assessment.verdict === "needs_review",
    ).length,
    fullCertificationClaimed: false,
  });
}
