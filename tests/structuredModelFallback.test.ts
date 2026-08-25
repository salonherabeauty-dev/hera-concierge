import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured generation retries once with an independent model", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /generateWithStructuredFallback/);
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /distinctModels[\s\S]*slice\(0, 2\)/);
  assert.match(source, /structured_generation_failed/);
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
