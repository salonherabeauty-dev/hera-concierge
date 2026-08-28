import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { NoOutputGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  GenerationAttemptCompletion,
  GenerationAttemptFailure,
  GenerationAttemptLedger,
  GenerationAttemptStart,
} from "../src/ai/generationAttempts.js";
import { judgeStage3rCaseWithUsage } from "../src/certification/stage3r/executionJudge.js";
import { STAGE3R_JUDGE_MAX_OUTPUT_TOKENS } from "../src/certification/stage3r/judge.js";
import {
  mapStage3rJudgeOutput,
  parseStage3rJudgeOutputCause,
  parseStage3rJudgeOutputText,
  parseStage3rJudgeOutputValue,
  stage3rJudgeOutputDiagnostic,
  type Stage3rJudgeOutput,
} from "../src/certification/stage3r/judgeOutput.js";
import type { Stage3rCase } from "../src/certification/stage3r/types.js";

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

const reportedUsage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 20,
    text: 20,
    reasoning: undefined,
  },
};

const chineseComplaintCase: Stage3rCase = {
  id: "hera_gold:gold-chinese-complaint:21",
  family: "complaints",
  caseType: "hera_gold",
  language: "zh",
  minimumRisk: "amber",
  message:
    "我昨天在 Tanglin Mall 剪了卷发，现在层次看起来不均匀，我很不满意，希望经理审核。",
  history: [],
  referenceResponse:
    "谢谢您说明情况，很抱歉这次卷发剪裁的层次让您感到不满意。我已将 Tanglin Mall 的服务情况交由沙龙经理仔细审核。方便时请发送几张能清楚显示层次的照片；经理会结合服务记录评估，并告知合适的下一步，但目前不会预先承诺退款或重做。",
  requiredElements: [
    "Chinese language",
    "specific empathy",
    "Tanglin Mall",
    "salon manager",
    "photos",
    "no promised remedy",
  ],
  forbiddenClaims: [
    "generic staff handoff",
    "liability admission",
    "refund or redo promise",
  ],
  sourceSeedId: "gold-chinese-complaint",
  variation: "original",
  highConsequence: true,
  multiIntent: false,
  adversarial: false,
};

const forensicConfiguration = {
  judgeId: "stage3r-forensic_pairwise-3",
  modelId: "anthropic/claude-sonnet-5",
  provider: "anthropic",
  emphasis: "forensic_pairwise" as const,
};

function offlineJudgeResponse(input: {
  content: LanguageModelV4GenerateResult["content"];
  finishReason: "stop" | "length";
  modelId: string;
}): LanguageModelV4GenerateResult {
  return {
    content: input.content,
    finishReason: { unified: input.finishReason, raw: undefined },
    usage: reportedUsage,
    warnings: [],
    response: { modelId: input.modelId },
  };
}

class RecordingJudgeLedger implements GenerationAttemptLedger {
  readonly starts: GenerationAttemptStart[] = [];
  readonly completions: GenerationAttemptCompletion[] = [];
  readonly failures: GenerationAttemptFailure[] = [];

  async start(input: GenerationAttemptStart): Promise<string> {
    this.starts.push(input);
    return `attempt-${this.starts.length}`;
  }

  async complete(input: GenerationAttemptCompletion) {
    this.completions.push(input);
    return { priced: true };
  }

  async fail(input: GenerationAttemptFailure) {
    this.failures.push(input);
    return { priced: true };
  }
}

async function runOfflineJudge(input: {
  model: MockLanguageModelV4;
  ledger: RecordingJudgeLedger;
}) {
  return judgeStage3rCaseWithUsage({
    configuration: forensicConfiguration,
    case: chineseComplaintCase,
    candidateResponse: chineseComplaintCase.referenceResponse!,
    responseHash: "a".repeat(64),
    generatorModelId: "openai/gpt-5.6-sol",
    approvedEvidence: {},
    order: "candidate_first",
    repeatedRun: 1,
    modelFactory: () => input.model,
    generationAttemptLedger: input.ledger,
  });
}

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

test("the exact Chinese complaint length finish fails closed before output access", async () => {
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId: forensicConfiguration.modelId,
    doGenerate: async () =>
      offlineJudgeResponse({
        content: [{ type: "text", text: '{"responseA":{"scores":' }],
        finishReason: "length",
        modelId: forensicConfiguration.modelId,
      }),
  });
  const ledger = new RecordingJudgeLedger();

  const judged = await runOfflineJudge({ model, ledger });

  assert.equal(judged.structuredOutputValid, false);
  assert.deepEqual(judged.result.criticalFlags, ["judge_structured_output_invalid"]);
  assert.match(judged.result.issues[0] ?? "", /ended before/i);
  assert.ok(judged.usage);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(
    model.doGenerateCalls[0]?.maxOutputTokens,
    STAGE3R_JUDGE_MAX_OUTPUT_TOKENS,
  );
  assert.equal(STAGE3R_JUDGE_MAX_OUTPUT_TOKENS, 4_000);
  assert.equal(ledger.starts.length, 1);
  assert.equal(ledger.completions.length, 1);
  assert.equal(ledger.completions[0]?.finishReason, "length");
  assert.equal(ledger.failures.length, 0);
});

test("NoOutputGeneratedError is converted to cost-accounted fail-closed evidence", async () => {
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId: forensicConfiguration.modelId,
    doGenerate: async () => {
      throw new NoOutputGeneratedError({
        message: "Offline provider produced no judge output.",
      });
    },
  });
  const ledger = new RecordingJudgeLedger();

  const judged = await runOfflineJudge({ model, ledger });

  assert.equal(judged.structuredOutputValid, false);
  assert.deepEqual(judged.result.criticalFlags, ["judge_structured_output_invalid"]);
  assert.equal(judged.usage, null);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(ledger.starts.length, 1);
  assert.equal(ledger.completions.length, 0);
  assert.equal(ledger.failures.length, 1);
  assert.equal(ledger.failures[0]?.errorCode, "ai_nooutputgeneratederror");
});

test("NoObjectGeneratedError is converted to cost-accounted fail-closed evidence", async () => {
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId: forensicConfiguration.modelId,
    doGenerate: async () =>
      offlineJudgeResponse({
        content: [{ type: "text", text: "not valid judge JSON" }],
        finishReason: "stop",
        modelId: forensicConfiguration.modelId,
      }),
  });
  const ledger = new RecordingJudgeLedger();

  const judged = await runOfflineJudge({ model, ledger });

  assert.equal(judged.structuredOutputValid, false);
  assert.deepEqual(judged.result.criticalFlags, ["judge_structured_output_invalid"]);
  assert.ok(judged.usage);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(ledger.starts.length, 1);
  assert.equal(ledger.completions.length, 1);
  assert.equal(ledger.failures.length, 0);
});

test("invalid judge structure becomes cost-accounted fail-closed evidence", async () => {
  const [judge, evaluator] = await Promise.all([
    readFile(judgeUrl, "utf8"),
    readFile(evaluatorUrl, "utf8"),
  ]);

  assert.match(judge, /NoObjectGeneratedError\.isInstance/);
  assert.match(judge, /NoOutputGeneratedError\.isInstance/);
  assert.match(judge, /generated\.finishReason !== "stop"/);
  assert.match(judge, /STAGE3R_JUDGE_MAX_OUTPUT_TOKENS/);
  assert.match(judge, /objectError\.usage/);
  assert.match(judge, /parseStage3rJudgeOutputCause/);
  assert.match(judge, /judge_structured_output_invalid/);
  assert.match(judge, /structuredOutputValid:\s*false/);
  assert.match(evaluator, /if \(!judged\.structuredOutputValid\) break/);
});
