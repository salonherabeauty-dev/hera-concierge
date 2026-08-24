import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the worker persists a required handoff before queuing any client acknowledgement", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  const persist = worker.indexOf("upsertAutomaticHandoff");
  const queue = worker.indexOf("if (policy.canAutoSend || handoff.createTask)");
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
