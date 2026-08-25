import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getStage3rJudgeConfigurations,
  stage3rJudgeScoreFields,
  STAGE3R_JUDGE_INSTRUCTIONS,
} from "../src/certification/stage3r/judge.js";
import {
  STAGE3R_DIMENSIONS,
  STAGE3R_JUDGE_PROMPT_VERSION,
} from "../src/certification/stage3r/types.js";

const runnerUrl = new URL(
  "../src/certification/stage3r/run.ts",
  import.meta.url,
);
const pipelineUrl = new URL(
  "../src/certification/stage3r/pipeline.ts",
  import.meta.url,
);
const judgeUrl = new URL(
  "../src/certification/stage3r/judge.ts",
  import.meta.url,
);

test("the Stage 3-R judge reviews exact final client text and resists model and position bias", () => {
  assert.equal(STAGE3R_JUDGE_PROMPT_VERSION, "hera-stage3r-judge-2026-08-26.1");
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /exact final client-facing response/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /placed first/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /your own writing style/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /reference response is a calibration anchor/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /critical failure cannot be averaged/i);
  assert.deepEqual(stage3rJudgeScoreFields(), STAGE3R_DIMENSIONS);
});

test("judge configuration requires three configurations and at least two providers", () => {
  const configurations = getStage3rJudgeConfigurations({
    HERA_STAGE3R_JUDGE_MODELS:
      "anthropic/claude-opus-5,openai/gpt-5.6-terra,anthropic/claude-opus-5",
  });

  assert.equal(configurations.length, 3);
  assert.equal(new Set(configurations.map((item) => item.judgeId)).size, 3);
  assert.ok(new Set(configurations.map((item) => item.provider)).size >= 2);
  assert.deepEqual(
    configurations.map((item) => item.emphasis),
    ["hospitality", "authority", "forensic_pairwise"],
  );
  assert.throws(
    () =>
      getStage3rJudgeConfigurations({
        HERA_STAGE3R_JUDGE_MODELS:
          "openai/gpt-5.6-terra,openai/gpt-5.6-sol,openai/gpt-5.6-terra",
      }),
    /at least two model providers/i,
  );
  assert.throws(
    () =>
      getStage3rJudgeConfigurations({
        HERA_STAGE3R_JUDGE_MODELS:
          "anthropic/claude-opus-5,openai/gpt-5.6-terra",
      }),
    /at least three judge configurations/i,
  );
});

test("the runner has an explicit cost guard and cannot silently claim a partial full run", async () => {
  const source = await readFile(runnerUrl, "utf8");

  assert.match(source, /STAGE3R_DRY_RUN/);
  assert.match(source, /APPROVED_FULL_2010_CASE_RUN/);
  assert.match(source, /refuses more than 100 paid cases/i);
  assert.match(source, /complete corpus from index zero/i);
  assert.match(source, /fullCertificationClaimed:\s*false/);
  assert.match(source, /whatsappProviderSendAvailable:\s*false/);
  assert.doesNotMatch(source, /MetaWhatsAppClient|D360WhatsAppClient|queueOutbound|sendText/);
});

test("the Stage 3-R pipeline reproduces final verification without provider or persistence side effects", async () => {
  const source = await readFile(pipelineUrl, "utf8");

  assert.match(source, /generateReceptionistDecision/);
  assert.match(source, /verifyReceptionistDecision/);
  assert.match(source, /assessGrounding/);
  assert.match(source, /assessPolicy/);
  assert.match(source, /assessHumanHandoff/);
  assert.match(source, /assessFinalResponseQuality/);
  assert.match(source, /verifyFinalClientReply/);
  assert.match(source, /providerSendCount:\s*0/);
  assert.match(source, /duplicateFinalCandidates:\s*0/);
  assert.doesNotMatch(
    source,
    /queueOutbound|completeJob|openIncident|upsertAutomaticHandoff|updateConversationRisk/,
  );
});

test("blind labels and model identity withholding are part of the executable judge payload", async () => {
  const source = await readFile(judgeUrl, "utf8");

  assert.match(source, /responseA/);
  assert.match(source, /responseB/);
  assert.match(source, /blindOrder/);
  assert.match(source, /responseModelIdentityWithheld:\s*true/);
  assert.match(source, /referenceIsNotAutomaticallyCorrect:\s*true/);
  assert.match(source, /candidate_first/);
  assert.match(source, /reference_first/);
  assert.doesNotMatch(source, /candidateResponse:\s*input\.candidateResponse/);
});
