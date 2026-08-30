import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const legacyRuntimeUrl = new URL("../src/ai/receptionist.ts", import.meta.url);
const legacyCoreUrl = new URL("../src/ai/receptionistCore.ts", import.meta.url);
const resetModelUrl = new URL("../src/reset/model.ts", import.meta.url);
const resetWorkerUrl = new URL("../src/reset/worker.ts", import.meta.url);
const resetConfigUrl = new URL("../src/reset/config.ts", import.meta.url);
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the reset uses one OpenAI GPT-5.6 Sol Max writer and at most one rewrite", async () => {
  const [model, worker, config] = await Promise.all([
    readFile(resetModelUrl, "utf8"),
    readFile(resetWorkerUrl, "utf8"),
    readFile(resetConfigUrl, "utf8"),
  ]);

  assert.match(config, /HERA_RESET_MODEL_ID = "openai\/gpt-5\.6-sol"/);
  assert.match(config, /HERA_RESET_MAX_MODEL_CALLS = 2/);
  assert.match(model, /reasoningEffort:\s*"max"/);
  assert.match(model, /order:\s*\["openai"\]/);
  assert.match(model, /only:\s*\["openai"\]/);
  assert.match(model, /stopWhen:\s*isStepCount\(1\)/);
  assert.match(model, /maxRetries:\s*0/);
  assert.match(worker, /modelCalls = 1/);
  assert.match(worker, /modelCalls = 2/);
  assert.match(worker, /rewriteResetReply/);
  assert.match(worker, /modelCalls > HERA_RESET_MAX_MODEL_CALLS/);
  assert.doesNotMatch(model, /anthropic\//i);
});

test("new 360dialog messages start reset drafting automatically without a button press", async () => {
  const source = await readFile(webhookUrl, "utf8");
  assert.match(source, /useResetReceptionist/);
  assert.match(source, /resetRepository\.ingestInbound\(message\)/);
  assert.match(source, /resetDraftRunIds\.push\(result\.draftRunId\)/);
  assert.match(source, /waitUntil\(/);
  assert.match(source, /drainResetDrafts\(createResetWorkerRuntime\(\), drainLimit\)/);
  assert.match(source, /INBOUND_BURST_SETTLE_MS = 9_000/);
  assert.match(source, /automaticDeliveryAllowed: false/);
  assert.doesNotMatch(source, /receptionist-draft/);
});

test("the prior Sol Max wrapper remains bounded for the untouched legacy fallback path", async () => {
  const [runtime, core] = await Promise.all([
    readFile(legacyRuntimeUrl, "utf8"),
    readFile(legacyCoreUrl, "utf8"),
  ]);
  assert.match(core, /timeout:\s*75_000/);
  assert.match(core, /timeout:\s*50_000/);
  assert.match(runtime, /response:\s*240_000/);
  assert.match(runtime, /verification:\s*240_000/);
  assert.match(runtime, /final_verification:\s*240_000/);
  assert.match(runtime, /reasoningEffort:\s*HERA_OPENAI_REASONING_EFFORT/);
  assert.match(runtime, /only:\s*\[HERA_OPENAI_PROVIDER\]/);
  assert.match(runtime, /fallbackModels:\s*\[\]/);
});

test("all long-running reset entry points use the plan maximum duration", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    functions?: Record<string, { maxDuration?: string | number }>;
  };
  for (const route of [
    "api/whatsapp/*.ts",
    "api/internal/drain.ts",
    "api/command-centre/reset-regenerate.ts",
  ]) {
    assert.equal(config.functions?.[route]?.maxDuration, "max", route);
  }
  assert.equal(
    config.functions?.["api/command-centre/reset-message.ts"]?.maxDuration,
    60,
  );
});
