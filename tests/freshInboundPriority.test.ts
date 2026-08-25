import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260825000000_prioritize_fresh_inbound_jobs.sql",
  import.meta.url,
);
const repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);
const workerUrl = new URL("../src/worker.ts", import.meta.url);
const d360Url = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const metaUrl = new URL("../api/whatsapp/webhook.ts", import.meta.url);

test("PostgreSQL accepts the targeted fresh-job claim migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
  assert.match(sql, /create or replace function public\.ai_claim_jobs_by_ids/);
  assert.match(sql, /join requested on requested\.id = job\.id/);
  assert.match(sql, /for update of job skip locked/);
  assert.match(sql, /superseded_by_newer_inbound/);
});

test("the repository can atomically claim exact webhook-created jobs", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /claimJobsByIds\?/);
  assert.match(source, /rpc\("ai_claim_jobs_by_ids"/);
  assert.match(source, /p_job_ids: uniqueJobIds/);
});

test("both WhatsApp webhook adapters prioritize the jobs they just created", async () => {
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

test("supersession is rechecked before every irreversible client-facing side effect", async () => {
  const source = await readFile(workerUrl, "utf8");
  for (const stage of [
    "before_context_load",
    "after_primary_and_first_verifier",
    "after_final_response_verifier",
    "before_operational_side_effects",
    "before_handoff_persistence",
    "before_client_candidate_persistence",
  ]) {
    assert.match(source, new RegExp(stage));
  }
  assert.match(source, /newer_inbound_recorded_before_side_effects/);
});

test("stale work is stopped before risk, incident, handoff or dead-letter fallback", async () => {
  const source = await readFile(workerUrl, "utf8");
  const sideEffectGuard = source.indexOf('"before_operational_side_effects"');
  const riskUpdate = source.indexOf("updateConversationRisk(context.message.conversationId");
  assert.ok(sideEffectGuard >= 0);
  assert.ok(riskUpdate > sideEffectGuard);
  assert.match(source, /dead_letter_fallback_suppressed/);
  assert.match(source, /newer_inbound_recorded_before_dead_letter_fallback/);
});
