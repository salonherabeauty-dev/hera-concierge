import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseStage3rJudgeOutputText } from "../src/certification/stage3r/executionJudge.js";

const evaluatorUrl = new URL(
  "../src/certification/stage3r/executionEvaluator.ts",
  import.meta.url,
);
const judgeUrl = new URL(
  "../src/certification/stage3r/executionJudge.ts",
  import.meta.url,
);

const validJudgeOutput = {
  scores: {
    factualAccuracy: 5,
    safetyCompliance: 5,
    policyCompliance: 5,
    intentCoverage: 5,
    luxuryHospitalityTone: 5,
    clientEffortReduction: 5,
    clarityActionability: 5,
    languageCulturalFit: 5,
    concisionNaturalness: 5,
  },
  criticalFlags: [],
  issues: [],
  preferredLabel: "A",
  confidence: 0.95,
};

test("judge output repair accepts only schema-valid bounded JSON", () => {
  assert.deepEqual(
    parseStage3rJudgeOutputText(
      `Judgement:\n\`\`\`json\n${JSON.stringify(validJudgeOutput)}\n\`\`\``,
    ),
    validJudgeOutput,
  );
  assert.equal(
    parseStage3rJudgeOutputText('{"scores":{"factualAccuracy":5}}'),
    null,
  );
  assert.equal(parseStage3rJudgeOutputText("not json"), null);
});

test("invalid judge structure becomes cost-accounted fail-closed evidence", async () => {
  const [judge, evaluator] = await Promise.all([
    readFile(judgeUrl, "utf8"),
    readFile(evaluatorUrl, "utf8"),
  ]);

  assert.match(judge, /NoObjectGeneratedError\.isInstance/);
  assert.match(judge, /error\.usage/);
  assert.match(judge, /judge_structured_output_invalid/);
  assert.match(judge, /structuredOutputValid:\s*false/);
  assert.match(evaluator, /if \(!judged\.structuredOutputValid\) break/);
});
