import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coreUrl = new URL("../src/ai/receptionistCore.ts", import.meta.url);
const runtimeUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("the reusable structured-generation core remains bounded and fail-closed", async () => {
  const source = await readFile(coreUrl, "utf8");
  assert.match(source, /generateWithStructuredFallback/);
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /MAX_STRUCTURED_MODEL_ATTEMPTS = 3/);
  assert.match(source, /distinctModels[\s\S]*MAX_STRUCTURED_MODEL_ATTEMPTS/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /if \(!canRetry\) throw error/);
  assert.match(source, /throw lastError/);
});

test("the authoritative Hera runtime disables alternate text-model fallback", async () => {
  const source = await readFile(runtimeUrl, "utf8");
  assert.match(source, /HERA_OPENAI_MODEL_ID = "openai\/gpt-5\.6-sol"/);
  assert.match(source, /HERA_OPENAI_REASONING_EFFORT = "max"/);
  assert.match(source, /fallbackModels: \[\]/);
  assert.match(source, /order: \[HERA_OPENAI_PROVIDER\]/);
  assert.match(source, /only: \[HERA_OPENAI_PROVIDER\]/);
  assert.match(source, /reasoningEffort: HERA_OPENAI_REASONING_EFFORT/);
  assert.doesNotMatch(source, /anthropic\//i);
});

test("the core preserves explicit structured-output budgets while the wrapper raises the OpenAI ceiling", async () => {
  const [core, runtime] = await Promise.all([
    readFile(coreUrl, "utf8"),
    readFile(runtimeUrl, "utf8"),
  ]);
  assert.match(core, /VERIFIER_MAX_OUTPUT_TOKENS = 3_000/);
  assert.match(core, /RESPONSE_MAX_OUTPUT_TOKENS = 3_600/);
  assert.match(runtime, /OPENAI_MAX_OUTPUT_TOKENS = 12_000/);
  assert.match(runtime, /OPENAI_FINAL_QUALITY_OUTPUT_TOKENS = 8_000/);
});
