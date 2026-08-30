import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const resetMigrationUrls = [
  "20260830000002_receptionist_reset_v1.sql",
  "20260830000003_receptionist_reset_integrity.sql",
  "20260830000004_receptionist_reset_supersession.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const resetWorkerUrl = new URL("../src/reset/worker.ts", import.meta.url);
const resetModelUrl = new URL("../src/reset/model.ts", import.meta.url);
const resetConfigUrl = new URL("../src/reset/config.ts", import.meta.url);
const resetUiUrl = new URL("../public/command-centre/reset-workspace.js", import.meta.url);
const resetCssUrl = new URL("../public/command-centre/reset-workspace.css", import.meta.url);
const indexUrl = new URL("../public/command-centre/index.html", import.meta.url);
const receptionUrl = new URL("../public/command-centre/reception.html", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);

async function migrationSql(): Promise<string> {
  return (await Promise.all(resetMigrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}

test("human handling controls delivery only and never blocks automatic reset drafting", async () => {
  const [sql, webhook, worker] = await Promise.all([
    migrationSql(),
    readFile(webhookUrl, "utf8"),
    readFile(resetWorkerUrl, "utf8"),
  ]);
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /delivery_control text not null default 'human_only'/i);
  assert.match(sql, /delivery_control = 'human_only'/i);
  assert.match(webhook, /useResetReceptionist/);
  assert.match(webhook, /resetRepository\.ingestInbound\(message\)/);
  assert.match(webhook, /drainResetDrafts/);
  assert.match(worker, /operatingModeObserved/);
  assert.doesNotMatch(worker, /operatingMode\s*===\s*"management"[\s\S]{0,120}(?:return|throw)/);
  assert.doesNotMatch(worker, /queueOutbound|sendText|D360WhatsAppClient|Timely/i);
});

test("new inbound fragments create a rolling consolidated turn and automatic draft run", async () => {
  const sql = await migrationSql();
  assert.match(sql, /ai_reset_ingest_whatsapp_message/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /v_fragment_ids := v_previous\.fragment_ids \|\| v_message_id/i);
  assert.match(sql, /now\(\) \+ interval '8 seconds'/i);
  assert.match(sql, /ai_reset_prepare_client_turn_insert/i);
  assert.match(sql, /interval '30 seconds'/i);
  assert.match(sql, /interval '2 minutes'/i);
  assert.match(sql, /v_previous\.assembled_text/i);
  assert.match(sql, /status = 'superseded'/i);
  assert.match(sql, /automaticDeliveryAllowed', false/i);
});

test("the reset has one Sol Max writer and no more than one rewrite", async () => {
  const [model, resetConfig, worker] = await Promise.all([
    readFile(resetModelUrl, "utf8"),
    readFile(resetConfigUrl, "utf8"),
    readFile(resetWorkerUrl, "utf8"),
  ]);
  assert.match(resetConfig, /HERA_RESET_MODEL_ID\s*=\s*"openai\/gpt-5\.6-sol"/);
  assert.match(resetConfig, /HERA_RESET_MAX_MODEL_CALLS\s*=\s*2/);
  assert.match(model, /gateway\(HERA_RESET_MODEL_ID\)/);
  assert.match(model, /reasoningEffort:\s*"max"/);
  assert.match(model, /only:\s*\["openai"\]/);
  assert.match(model, /stopWhen:\s*isStepCount\(1\)/);
  assert.match(model, /maxRetries:\s*0/);
  assert.match(worker, /modelCalls = 1/);
  assert.match(worker, /modelCalls = 2/);
  assert.match(worker, /HERA_RESET_MAX_MODEL_CALLS/);
  assert.match(worker, /hard_validation_failed/);
  assert.doesNotMatch(model, /verifyReceptionistDecision|verifyFinalClientReply|anthropic\//i);
});

test("front desk panes scroll independently and expose only truthful states", async () => {
  const [css, script, index, reception] = await Promise.all([
    readFile(resetCssUrl, "utf8"),
    readFile(resetUiUrl, "utf8"),
    readFile(indexUrl, "utf8"),
    readFile(receptionUrl, "utf8"),
  ]);
  assert.doesNotThrow(() => new Function(script));
  assert.match(css, /\.reset-shell[\s\S]*height:\s*100dvh/i);
  assert.match(css, /\.reset-thread[\s\S]*overflow-y:\s*auto/i);
  assert.match(css, /\.reset-conversation-list[\s\S]*overflow-y:\s*auto/i);
  assert.match(css, /scrollbar-gutter:\s*stable/i);
  assert.match(css, /touch-action:\s*pan-y/i);
  assert.match(css, /@media \(max-width: 760px\)/i);
  assert.match(script, /AI is preparing this reply automatically/);
  assert.match(script, /AI draft ready/);
  assert.match(script, /AI could not prepare this reply/);
  assert.match(script, /Retry AI Reply/);
  assert.match(script, /Write Manually/);
  assert.match(script, /threadNearBottom/);
  assert.match(script, /threadScrollTop/);
  assert.match(script, /Reply window closed/);
  assert.doesNotMatch(script, /Create AI Reply|receptionist-draft/);
  for (const html of [index, reception]) {
    assert.match(html, /reset-workspace\.css/);
    assert.match(html, /reset-workspace\.js/);
    assert.doesNotMatch(html, /receptionist-emergency-fix|receptionist-live-recovery/);
  }
});

test("draft timeout and every other terminal failure become an explicit visible failed state", async () => {
  const [sql, worker] = await Promise.all([
    migrationSql(),
    readFile(resetWorkerUrl, "utf8"),
  ]);
  assert.match(sql, /ai_reset_reconcile_timeouts/i);
  assert.match(sql, /failure_code = case/i);
  assert.match(sql, /worker_timeout/i);
  assert.match(sql, /queue_timeout/i);
  assert.match(sql, /status = 'failed'/i);
  assert.match(worker, /openai_timeout/);
  assert.match(worker, /openai_rate_limited/);
  assert.match(worker, /attachment_processing_failed/);
  assert.match(worker, /evidence_retrieval_failed/);
  assert.match(worker, /ai_draft_failed/);
  assert.match(worker, /repository\.markFailed/);
});

test("Vercel grants the reset long-running endpoints maximum duration and performs a pure build", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    buildCommand?: string;
    functions?: Record<string, { maxDuration?: number | string }>;
  };
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.functions?.["api/whatsapp/*.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/internal/drain.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/command-centre/reset-regenerate.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/command-centre/reset-message.ts"]?.maxDuration, 60);
});
