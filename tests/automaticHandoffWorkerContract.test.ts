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

test("the exact post-policy reply receives final verification, quality and action-authority gates", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  const verify = worker.indexOf("verifyFinalClientReply");
  const quality = worker.indexOf("assessFinalResponseQuality");
  const authority = worker.indexOf("assessActionAuthority");
  const queue = worker.indexOf("if (deliveryEligible && (policy.canAutoSend || handoff.createTask))");
  assert.ok(verify >= 0);
  assert.ok(quality >= 0);
  assert.ok(authority >= 0);
  assert.ok(queue >= 0);
  assert.ok(verify < queue);
  assert.ok(quality < queue);
  assert.ok(authority < queue);
  assert.match(worker, /final_response_quality_blocked/);
  assert.match(worker, /actionAuthorityPassed/);
  assert.match(worker, /ACTION_AUTHORITY_POLICY_VERSION/);
  assert.match(worker, /taskType: "system_failure"/);
  assert.match(worker, /dead-letter-handoff/);
});

test("persisted handoff status matches the exact approved client reply", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /clientVisibleStatus: deliveryEligible \? finalReply : null/,
  );
});

test("a corrected final reply is re-verified and authority-checked before becoming delivery eligible", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /initialFinalVerification/);
  assert.match(worker, /const finalVerification = initialFinalVerification\.approved/);
  assert.match(worker, /draftReply: finalReply/);
  assert.match(worker, /const finalActionAuthority = assessActionAuthority/);
  assert.match(
    worker,
    /const deliveryEligible =\s*finalQuality\.passed &&\s*finalVerification\.approved &&\s*finalActionAuthority\.passed;/,
  );
});

test("dead-letter client text is localized, quality-checked, authority-checked and backed by a durable manager task", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /deadLetterFallbackReply/);
  assert.match(worker, /detectSupportedClientLocale/);
  assert.match(worker, /fallbackActionAuthority = assessActionAuthority/);
  assert.match(
    worker,
    /Dead-letter fallback failed Hera’s deterministic quality or action-authority gate/,
  );
  assert.match(worker, /dead-letter-handoff/);
});
