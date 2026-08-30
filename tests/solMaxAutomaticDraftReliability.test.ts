import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeUrl = new URL("../src/ai/receptionist.ts", import.meta.url);
const coreUrl = new URL("../src/ai/receptionistCore.ts", import.meta.url);
const gateUrl = new URL("../src/ai/finalResponseGate.ts", import.meta.url);
const draftUrl = new URL(
  "../api/command-centre/receptionist-draft.ts",
  import.meta.url,
);
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("Sol Max overrides the obsolete medium-reasoning aborts for all three response stages", async () => {
  const [runtime, core] = await Promise.all([
    readFile(runtimeUrl, "utf8"),
    readFile(coreUrl, "utf8"),
  ]);

  // The old core timeouts are retained for reusable non-Sol test injection, but
  // the authoritative wrapper must replace their provider abort signal.
  assert.match(core, /timeout:\s*75_000/);
  assert.match(core, /timeout:\s*50_000/);
  assert.match(runtime, /response:\s*240_000/);
  assert.match(runtime, /verification:\s*240_000/);
  assert.match(runtime, /final_verification:\s*240_000/);
  assert.match(runtime, /abortSignal:\s*stageAbortSignal/);
  assert.match(runtime, /AbortSignal\.timeout/);
  assert.match(runtime, /reasoningEffort:\s*HERA_OPENAI_REASONING_EFFORT/);
  assert.match(runtime, /HERA_OPENAI_REASONING_EFFORT = "max"/);
  assert.match(runtime, /only:\s*\[HERA_OPENAI_PROVIDER\]/);
  assert.match(runtime, /fallbackModels:\s*\[\]/);
});

test("Create AI Reply acknowledges immediately and continues the exact job in waitUntil", async () => {
  const source = await readFile(draftUrl, "utf8");
  assert.match(source, /import \{ waitUntil \} from "@vercel\/functions"/);
  assert.match(source, /waitUntil\([\s\S]*drainReceptionistForJobs/);
  assert.doesNotMatch(source, /await\s+drainReceptionistForJobs/);
  assert.match(source, /status\(202\)[\s\S]*state:\s*"draft_pending"/);
  assert.match(source, /receptionist_draft_background_drain_completed/);
  assert.match(source, /receptionist_draft_background_drain_failed/);
  assert.match(source, /runtime\.sendMode !== "shadow"/);
  assert.doesNotMatch(source, /sendText|D360WhatsAppClient|Timely/i);
});

test("new 360dialog messages still start automatic background drafting without a button press", async () => {
  const source = await readFile(webhookUrl, "utf8");
  assert.match(source, /waitUntil\(/);
  assert.match(source, /drainReceptionistForJobs/);
  assert.match(source, /wakeableJobIds/);
  assert.match(source, /humanReviewDrafting/);
  assert.match(source, /INBOUND_BURST_SETTLE_MS = 9_000/);
  assert.doesNotMatch(source, /receptionist-draft/);
});

test("a certified final OpenAI rewrite is adopted once rather than calling Sol Max again", async () => {
  const gate = await readFile(gateUrl, "utf8");
  assert.match(gate, /certifiedReply/);
  assert.match(gate, /initiallyCertified/);
  assert.match(gate, /correctionsApplied:\s*initiallyCertified === draftReply \? 0 : 1/);
  assert.match(gate, /FINAL_RESPONSE_GATE_VERSION = "hera-final-response-gate-1\.2\.0"/);
});

test("all long-running automatic-draft entry points use the plan maximum duration", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    functions?: Record<string, { maxDuration?: string | number }>;
  };
  for (const route of [
    "api/whatsapp/*.ts",
    "api/internal/drain.ts",
    "api/command-centre/receptionist-regenerate.ts",
    "api/command-centre/receptionist-draft.ts",
  ]) {
    assert.equal(config.functions?.[route]?.maxDuration, "max", route);
  }
  assert.equal(
    config.functions?.["api/command-centre/receptionist-message.ts"]?.maxDuration,
    60,
  );
});
