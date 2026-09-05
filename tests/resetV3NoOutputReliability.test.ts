import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RESET_MAX_MODEL_CALLS,
  RESET_MAX_OUTPUT_TOKENS,
  RESET_SUBMIT_TOOL_NAME,
} from "../src/reset/engine.js";
import { resetEvidenceQueries } from "../src/reset/evidence.js";

const engineUrl = new URL("../src/reset/engine.ts", import.meta.url);
const workerUrl = new URL("../src/reset/worker.ts", import.meta.url);

const NAI_NAI_MESSAGE =
  "I need an urgent curly haircut tomorrow and may I know who is the best curly hair specialist and what’s the price !";

test("Reset v3 uses one-shot forced structured submission instead of ToolLoopAgent output resolution", async () => {
  const source = await readFile(engineUrl, "utf8");

  assert.equal(RESET_MAX_MODEL_CALLS, 1);
  assert.equal(RESET_MAX_OUTPUT_TOKENS, 24_000);
  assert.equal(RESET_SUBMIT_TOOL_NAME, "submitReceptionistDraft");
  assert.match(source, /generateText/);
  assert.match(source, /tool\(\{/);
  assert.match(source, /strict:\s*true/);
  assert.match(source, /toolChoice:\s*\{[\s\S]*type:\s*"tool"[\s\S]*toolName:\s*RESET_SUBMIT_TOOL_NAME/);
  assert.match(source, /result\.toolCalls\.find/);
  assert.doesNotMatch(source, /ToolLoopAgent/);
  assert.doesNotMatch(source, /Output\.object/);
  assert.doesNotMatch(source, /isStepCount/);
});

test("a missing structured submission fails visibly without a hidden paid retry", async () => {
  const source = await readFile(engineUrl, "utf8");

  assert.match(source, /callNumber:\s*1/);
  assert.doesNotMatch(source, /callNumber:\s*2/);
  assert.doesNotMatch(source, /NO_OUTPUT_RECOVERY_INSTRUCTIONS/);
  assert.match(source, /throw new ResetDraftGenerationError\(1, error\)/);
  assert.doesNotMatch(source, /callNumber:\s*3/);
});

test("the exact failed curly enquiry plans distinct service, staff, price and authority evidence", () => {
  const plan = resetEvidenceQueries(NAI_NAI_MESSAGE);
  const categories = new Set(plan.map((item) => item.category));

  assert.ok(categories.has("authority"));
  assert.ok(categories.has("service"));
  assert.ok(categories.has("staff"));
  assert.ok(categories.has("price"));
  assert.ok(plan.some((item) => /curly/i.test(item.query)));
  assert.ok(plan.some((item) => /price/i.test(item.query)));
  assert.ok(plan.some((item) => /staff expertise/i.test(item.query)));
});

test("no-output failures preserve model-attempt, finish-reason and token diagnostics without client text", async () => {
  const source = await readFile(workerUrl, "utf8");

  assert.match(source, /modelAttemptsFromError/);
  assert.match(source, /providerFinishReason/);
  assert.match(source, /providerOutputTokens/);
  assert.match(source, /providerReasoningTokens/);
  assert.match(source, /providerGeneratedTextLength/);
  assert.match(source, /providerCauseName/);
  assert.doesNotMatch(source, /consolidatedText:\s*job\.consolidatedText/);
});
