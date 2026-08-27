import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseStage3rJudgeOutputCause,
  parseStage3rJudgeOutputText,
  parseStage3rJudgeOutputValue,
  stage3rJudgeOutputDiagnostic,
} from "../src/certification/stage3r/judgeOutput.js";

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

test("judge output accepts bounded detailed issue evidence", () => {
  const detailedIssue = "Detailed independent finding. ".repeat(40).trim();
  const parsed = parseStage3rJudgeOutputValue({
    ...validJudgeOutput,
    issues: [detailedIssue],
  });
  assert.deepEqual(parsed, { ...validJudgeOutput, issues: [detailedIssue] });
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      issues: ["x".repeat(4001)],
    }),
    null,
  );
});

test("judge output conservatively caps only a one-point score overflow", () => {
  const overflow = {
    ...validJudgeOutput,
    scores: { ...validJudgeOutput.scores, concisionNaturalness: 6 },
  };
  assert.deepEqual(parseStage3rJudgeOutputCause({ value: overflow }), {
    ...overflow,
    scores: { ...overflow.scores, concisionNaturalness: 5 },
    issues: ["schema_repair:concisionNaturalness:6:capped_to_5"],
  });
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      scores: { ...validJudgeOutput.scores, concisionNaturalness: 6.01 },
    }),
    null,
  );
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      scores: { ...validJudgeOutput.scores, concisionNaturalness: -0.01 },
    }),
    null,
  );
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      scores: { ...validJudgeOutput.scores, concisionNaturalness: "6" },
    }),
    null,
  );
});

test("judge recovery handles only semantics-preserving Anthropic label casing", () => {
  assert.deepEqual(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      preferredLabel: "a",
      summary: "This unused legacy field is ignored.",
    }),
    validJudgeOutput,
  );
  assert.deepEqual(
    parseStage3rJudgeOutputCause({
      value: { ...validJudgeOutput, preferredLabel: "TIE" },
    }),
    { ...validJudgeOutput, preferredLabel: "tie" },
  );
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      preferredLabel: "candidate",
    }),
    null,
  );
  assert.match(
    stage3rJudgeOutputDiagnostic({
      text: JSON.stringify({ scores: {} }),
      cause: null,
    }),
    /scores\./,
  );
});

test("invalid judge structure becomes cost-accounted fail-closed evidence", async () => {
  const [judge, evaluator] = await Promise.all([
    readFile(judgeUrl, "utf8"),
    readFile(evaluatorUrl, "utf8"),
  ]);

  assert.match(judge, /NoObjectGeneratedError\.isInstance/);
  assert.match(judge, /error\.usage/);
  assert.match(judge, /parseStage3rJudgeOutputCause/);
  assert.match(judge, /judge_structured_output_invalid/);
  assert.match(judge, /structuredOutputValid:\s*false/);
  assert.match(evaluator, /if \(!judged\.structuredOutputValid\) break/);
});
