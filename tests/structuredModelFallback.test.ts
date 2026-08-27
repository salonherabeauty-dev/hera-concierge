import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured generation retries with up to three independent models", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /generateWithStructuredFallback/);
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /MAX_STRUCTURED_MODEL_ATTEMPTS = 3/);
  assert.match(source, /distinctModels[\s\S]*MAX_STRUCTURED_MODEL_ATTEMPTS/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /modelAttempt: index \+ 1/);
  assert.match(source, /modelAttemptLimit: models\.length/);
  assert.match(source, /stage: "response"/);
  assert.match(source, /stage: "verification"/);
  assert.match(source, /stage: "final_verification"/);
});

test("model fallback remains bounded and fail-closed", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /if \(!canRetry\) throw error/);
  assert.match(source, /throw lastError/);
  assert.match(source, /disallowPromptTraining: true/g);
});

test("structured verifier budgets preserve room for validated output", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /VERIFIER_MAX_OUTPUT_TOKENS = 3_000/);
  assert.equal((source.match(/reasoning: "low"/g) ?? []).length, 2);
  assert.match(source, /RESPONSE_MAX_OUTPUT_TOKENS = 3_600/);
  assert.match(source, /reasoning: "medium"/);
});
