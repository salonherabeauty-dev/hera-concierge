import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);
const workerUrl = new URL("../src/worker.ts", import.meta.url);
const d360Url = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const metaUrl = new URL("../api/whatsapp/webhook.ts", import.meta.url);

test("the repository atomically claims exact webhook-created jobs without DDL", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /claimJobsByIds\?/);
  assert.match(source, /from\("ai_jobs"\)[\s\S]*\.in\("id", uniqueJobIds\)/);
  assert.match(source, /\.eq\("status", status\)/);
  assert.match(source, /\.eq\("attempts", attempts\)/);
  assert.match(source, /\.eq\("updated_at", updatedAt\)/);
  assert.match(source, /attempts: attempts \+ 1/);
  assert.match(source, /superseded_by_newer_inbound/);
  assert.doesNotMatch(source, /ai_claim_jobs_by_ids/);
});

test("both WhatsApp adapters prioritize the jobs they just created", async () => {
  for (const url of [d360Url, metaUrl]) {
    const source = await readFile(url, "utf8");
    assert.match(source, /const wakeableJobIds: string\[\] = \[\]/);
    assert.match(source, /wakeableJobIds\.push\(result\.jobId\)/);
    assert.match(source, /drainReceptionistForJobs/);
  }
});

test("the worker processes targeted jobs before unrelated backlog", async () => {
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /export async function drainReceptionistForJobs/);
  assert.match(source, /const targetedJobs = await runtime\.repository\.claimJobsByIds/);
  assert.match(source, /const backlogJobs = remainingCapacity > 0/);
  assert.match(source, /\.\.\.targetedJobs,[\s\S]*\.\.\.backlogJobs\.filter/);
});

test("supersession is rechecked before every irreversible side effect", async () => {
  const source = await readFile(workerUrl, "utf8");
  for (const stage of [
    "before_context_load",
    "after_primary_and_first_verifier",
    "after_final_response_verifier",
    "before_operational_side_effects",
    "before_handoff_persistence",
    "before_client_candidate_persistence",
  ]) assert.match(source, new RegExp(stage));
  const guard = source.indexOf('"before_operational_side_effects"');
  const riskUpdate = source.indexOf("updateConversationRisk(context.message.conversationId");
  assert.ok(guard >= 0 && riskUpdate > guard);
  assert.match(source, /dead_letter_fallback_suppressed/);
});
