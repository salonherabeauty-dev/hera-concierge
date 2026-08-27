import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  mapStage3rJudgeOutput,
  parseStage3rJudgeOutputCause,
  parseStage3rJudgeOutputText,
  parseStage3rJudgeOutputValue,
  stage3rJudgeOutputDiagnostic,
  type Stage3rJudgeOutput,
} from "../src/certification/stage3r/judgeOutput.js";

const evaluatorUrl = new URL(
  "../src/certification/stage3r/executionEvaluator.ts",
  import.meta.url,
);
const judgeUrl = new URL(
  "../src/certification/stage3r/executionJudge.ts",
  import.meta.url,
);

const validScores = {
  factualAccuracy: 5,
  safetyCompliance: 5,
  policyCompliance: 5,
  intentCoverage: 5,
  luxuryHospitalityTone: 5,
  clientEffortReduction: 5,
  clarityActionability: 5,
  languageCulturalFit: 5,
  concisionNaturalness: 5,
};

const validReview = {
  scores: validScores,
  criticalFlags: [],
  issues: [],
};

const validJudgeOutput: Stage3rJudgeOutput = {
  responseA: validReview,
  responseB: validReview,
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
    responseA: { ...validReview, issues: [detailedIssue] },
  });
  assert.deepEqual(parsed, {
    ...validJudgeOutput,
    responseA: { ...validReview, issues: [detailedIssue] },
  });
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      responseA: { ...validReview, issues: ["x".repeat(4001)] },
    }),
    null,
  );
});

test("judge output conservatively caps only a one-point score overflow", () => {
  const overflow = {
    ...validJudgeOutput,
    responseA: {
      ...validReview,
      scores: { ...validScores, concisionNaturalness: 6 },
    },
  };
  assert.deepEqual(parseStage3rJudgeOutputCause({ value: overflow }), {
    ...overflow,
    responseA: {
      ...overflow.responseA,
      scores: { ...validScores, concisionNaturalness: 5 },
      issues: ["schema_repair:concisionNaturalness:6:capped_to_5"],
    },
  });
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      responseA: {
        ...validReview,
        scores: { ...validScores, concisionNaturalness: 6.01 },
      },
    }),
    null,
  );
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      responseA: {
        ...validReview,
        scores: { ...validScores, concisionNaturalness: -0.01 },
      },
    }),
    null,
  );
  assert.equal(
    parseStage3rJudgeOutputValue({
      ...validJudgeOutput,
      responseA: {
        ...validReview,
        scores: { ...validScores, concisionNaturalness: "6" },
      },
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
      text: JSON.stringify({ responseA: { scores: {} } }),
      cause: null,
    }),
    /responseA\.scores\./,
  );
});

test("blind reviews map only the displayed candidate after judgment", () => {
  const weakerReview = {
    ...validReview,
    scores: { ...validScores, policyCompliance: 4 },
    issues: ["Missing one mandated policy element."],
  };
  const output = {
    ...validJudgeOutput,
    responseA: validReview,
    responseB: weakerReview,
    preferredLabel: "A" as const,
  };

  const candidateFirst = mapStage3rJudgeOutput({
    output,
    order: "candidate_first",
    hasReference: true,
  });
  assert.equal(candidateFirst?.candidateReview.scores.policyCompliance, 5);
  assert.equal(candidateFirst?.comparison.materialPreferredLabel, "A");

  const referenceFirst = mapStage3rJudgeOutput({
    output,
    order: "reference_first",
    hasReference: true,
  });
  assert.equal(referenceFirst?.candidateReview.scores.policyCompliance, 4);
  assert.equal(referenceFirst?.comparison.materialPreferredLabel, "A");
});

test("two send-ready blind reviews become a material tie while raw preference remains", () => {
  const mapped = mapStage3rJudgeOutput({
    output: { ...validJudgeOutput, preferredLabel: "B" },
    order: "candidate_first",
    hasReference: true,
  });
  assert.equal(mapped?.comparison.rawPreferredLabel, "B");
  assert.equal(mapped?.comparison.materialPreferredLabel, "tie");
  assert.equal(mapped?.comparison.materialPreferenceBasis, "both_send_ready");
});

test("pointwise output requires a null second review and no pairwise preference", () => {
  assert.ok(
    mapStage3rJudgeOutput({
      output: {
        responseA: validReview,
        responseB: null,
        preferredLabel: "not_applicable",
        confidence: 0.95,
      },
      order: "pointwise",
      hasReference: false,
    }),
  );
  assert.equal(
    mapStage3rJudgeOutput({
      output: validJudgeOutput,
      order: "pointwise",
      hasReference: false,
    }),
    null,
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
