import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the worker persists a required handoff before queuing any client acknowledgement", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  const persist = worker.indexOf("upsertAutomaticHandoff");
  const queue = worker.indexOf("if (deliveryEligible && (policy.canAutoSend || handoff.createTask))");
  assert.ok(persist >= 0);
  assert.ok(queue >= 0);
  assert.ok(persist < queue);
  assert.match(worker, /throw new Error\("Human handoff assessment was incomplete"\)/);
});

test("the worker records handoff evidence in the policy decision", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION/);
  assert.match(worker, /automatic_handoff_created/);
  assert.match(worker, /automatic_handoff_refreshed/);
});

test("the exact post-policy reply receives a second verifier and fail-closed quality gate", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  const verify = worker.indexOf("verifyFinalClientReply");
  const quality = worker.indexOf("assessFinalResponseQuality");
  const queue = worker.indexOf("if (deliveryEligible && (policy.canAutoSend || handoff.createTask))");
  assert.ok(verify >= 0);
  assert.ok(quality >= 0);
  assert.ok(queue >= 0);
  assert.ok(verify < queue);
  assert.ok(quality < queue);
  assert.match(worker, /final_response_quality_blocked/);
  assert.match(worker, /taskType: "system_failure"/);
  assert.match(worker, /dead-letter-handoff/);
});

test("persisted handoff status matches the exact quality-approved client reply", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /clientVisibleStatus: deliveryEligible \? finalReply : null/,
  );
});

test("corrected final replies receive a bounded independent re-verification", async () => {
  const [worker, gate] = await Promise.all([
    readFile(new URL("../src/worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ai/finalResponseGate.ts", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /initialFinalVerification/);
  assert.match(worker, /runFinalResponseGate/);
  assert.match(worker, /verificationAttempts/);
  assert.match(gate, /MAX_FINAL_RESPONSE_CORRECTIONS = 2/);
  assert.match(gate, /correctionsApplied < MAX_FINAL_RESPONSE_CORRECTIONS/);
  assert.match(
    worker,
    /deterministic\.risk === "black"[\s\S]{0,120}urgentSafetyReplyFor\(interpreted\.text\)/,
  );
  assert.match(
    worker,
    /const deliveryEligible = finalQuality\.passed && finalVerification\.approved/,
  );
});

test("dead-letter client text is localized, deterministically checked and backed by a durable manager task", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /deadLetterFallbackReply/);
  assert.match(worker, /detectSupportedClientLocale/);
  assert.match(worker, /Dead-letter fallback failed Hera’s deterministic quality gate/);
  assert.match(worker, /dead-letter-handoff/);
});
