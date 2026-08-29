import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260830000001_reconcile_verified_complaint_drafts_and_message_bursts.sql",
  import.meta.url,
);
const webhookUrl = new URL(
  "../api/whatsapp/360dialog.ts",
  import.meta.url,
);
const workerUrl = new URL("../src/worker.ts", import.meta.url);

test("PostgreSQL accepts the verified complaint reconciliation migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_reply_mentions_known_service_context/);
  assert.match(sql, /The complaint reply omits the known service context\./);
  assert.match(sql, /finalVerification'->>'approved'/);
  assert.match(sql, /verified-complaint-service-context-v1/);
  assert.match(sql, /deliveryEligible/);
  assert.match(sql, /'shadowed'/);
  assert.match(sql, /automaticDeliveryAllowed', false/);
  assert.match(sql, /on conflict \(dedupe_key\) do nothing/i);
});

test("reconciliation remains narrow and cannot rescue an unsafe or unrelated draft", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /taskType', ''\) <> 'complaint_review'/);
  assert.match(sql, /jsonb_array_length\(v_issues\) <> 1/);
  assert.match(sql, /ai_tanglin_whatsapp_reply_violation\(v_reply\) is not null/);
  assert.match(sql, /length\(v_reply\) > 4000/);
  assert.match(sql, /now\(\) - v_source_effective_at >= interval '24 hours'/);
  assert.match(sql, /v_latest_inbound_id is distinct from new\.source_message_id/);
});

test("new inbound jobs wait for a short message burst before AI processing", async () => {
  const [sql, webhook] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(webhookUrl, "utf8"),
  ]);
  assert.match(sql, /ai_settle_inbound_message_burst/);
  assert.match(sql, /new\.dedupe_key like 'inbound:%'/);
  assert.match(sql, /interval '8 seconds'/);
  assert.match(webhook, /INBOUND_BURST_SETTLE_MS = 9_000/);
  const settle = webhook.indexOf("settleInboundBurst()");
  const drain = webhook.indexOf("drainReceptionistForJobs", settle);
  assert.ok(settle >= 0);
  assert.ok(drain > settle);
});

test("rapid fragments are consolidated by latest-message suppression plus conversation history", async () => {
  const worker = await readFile(workerUrl, "utf8");
  assert.match(worker, /completeSupersededJob\(runtime, job, "before_context_load"\)/);
  assert.match(worker, /getConversationHistory\(/);
  assert.match(worker, /after_primary_and_first_verifier/);
  assert.match(worker, /after_final_response_verifier/);
  assert.match(worker, /before_client_candidate_persistence/);
});

test("the background burst path prepares drafts but never sends them autonomously", async () => {
  const [sql, webhook] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(webhookUrl, "utf8"),
  ]);
  assert.doesNotMatch(webhook, /sendText|receptionist-message|Send to Client/);
  assert.match(sql, /send_authorization,\s*status/s);
  assert.match(sql, /'auto',\s*'shadowed'/s);
  assert.doesNotMatch(sql, /provider_message_id\s*=|markOutboxSent|status\s*=\s*'sent'/i);
});
