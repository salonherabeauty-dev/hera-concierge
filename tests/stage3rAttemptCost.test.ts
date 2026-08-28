import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateStage3rAttemptCost,
  stage3rUsageTokens,
} from "../src/certification/stage3r/cost.js";

test("normalized AI SDK usage produces a conservative priced attempt", () => {
  const usage = {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 100 },
    outputTokens: 20,
    outputTokenDetails: { textTokens: 20 },
    totalTokens: 120,
  };

  assert.deepEqual(stage3rUsageTokens(usage), {
    input: 100,
    output: 20,
    total: 120,
  });
  assert.deepEqual(
    estimateStage3rAttemptCost("openai/gpt-5.6-sol", usage),
    { costUsd: 0.0008, issue: null },
  );
});

test("unknown prices or missing usage remain unpriced and fail closed", () => {
  assert.deepEqual(
    estimateStage3rAttemptCost("unknown/model", {
      inputTokens: 1,
      outputTokens: 1,
    }),
    { costUsd: null, issue: "missing_price:unknown/model" },
  );
  assert.deepEqual(
    estimateStage3rAttemptCost("openai/gpt-5.6-sol", {}),
    { costUsd: null, issue: "missing_usage:openai/gpt-5.6-sol" },
  );
});
