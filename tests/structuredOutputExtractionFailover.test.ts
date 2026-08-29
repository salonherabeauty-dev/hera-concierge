import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const coreUrl = new URL("../src/ai/receptionistCore.ts", import.meta.url);
const runtimeUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured output is forced inside the reusable core attempt boundary", async () => {
  const source = await readFile(coreUrl, "utf8");
  const forcedExtractions = source.match(/forceStructuredOutput\(generated\);/g) ?? [];
  assert.equal(forcedExtractions.length, 3);
  assert.match(
    source,
    /generateWithStructuredFallback[\s\S]*forceStructuredOutput\(generated\)/,
  );
});

test("lazy output extraction failures remain observable and fail closed", async () => {
  const source = await readFile(coreUrl, "utf8");
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /generationFinishReason/);
  assert.match(source, /generationReasoningTokens/);
  assert.match(source, /if \(!canRetry\) throw error/);
});

test("the active wrapper prevents extraction failures from crossing providers", async () => {
  const source = await readFile(runtimeUrl, "utf8");
  assert.match(source, /fallbackModels: \[\]/);
  assert.match(source, /only: \[HERA_OPENAI_PROVIDER\]/);
  assert.match(source, /HERA_OPENAI_REASONING_EFFORT = "max"/);
});

test("image inputs use the AI SDK 7 canonical file content part", async () => {
  const source = await readFile(coreUrl, "utf8");
  assert.doesNotMatch(source, /type: "image",\s*image:/);
  assert.match(source, /type: "file",\s*data: interpreted\.attachment\.data/);
});
