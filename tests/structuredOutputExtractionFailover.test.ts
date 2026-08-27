import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured output is forced inside the model failover boundary", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const forcedExtractions = source.match(/forceStructuredOutput\(generated\);/g) ?? [];
  assert.equal(forcedExtractions.length, 3);
  assert.match(
    source,
    /generateWithStructuredFallback[\s\S]*forceStructuredOutput\(generated\)/,
  );
});

test("lazy output extraction failures cannot bypass independent model retry", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /fallbackModel: nextModel/);
  assert.match(source, /generationFinishReason/);
  assert.match(source, /generationReasoningTokens/);
  assert.match(source, /if \(!canRetry\) throw error/);
});

test("image inputs use the AI SDK 7 canonical file content part", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.doesNotMatch(source, /type: "image",\s*image:/);
  assert.match(source, /type: "file",\s*data: interpreted\.attachment\.data/);
});
