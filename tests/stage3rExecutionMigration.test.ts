import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260826000001_add_stage3r_execution_orchestration.sql",
  import.meta.url,
);
const workerUrl = new URL("../api/stage3r/worker.ts", import.meta.url);
const evaluatorUrl = new URL(
  "../src/certification/stage3r/executionEvaluator.ts",
  import.meta.url,
);

test("PostgreSQL accepts the Stage 3-R resumable execution migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /create table if not exists public\.ai_stage3r_case_queue/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /stale_lock_recovered/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /service_role required|service role required/i);
  assert.match(sql, /full Stage 3-R run must contain exactly 2010 cases/i);
});

test("the protected worker is Preview-only, shadow-only and cannot send WhatsApp", async () => {
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /VERCEL_ENV !== "preview"/);
  assert.match(source, /feat\/hera-ai-receptionist-foundation/);
  assert.match(source, /sendMode !== "shadow"/);
  assert.match(source, /WHATSAPP_LIVE_CONFIRMATION/);
  assert.match(source, /CRON_SECRET/);
  assert.doesNotMatch(
    source,
    /MetaWhatsAppClient|D360WhatsAppClient|queueOutbound|sendText|WHATSAPP_ACCESS_TOKEN|D360_API_KEY/,
  );
});

test("one queue item evaluates one exact final response and records forensic evidence", async () => {
  const source = await readFile(evaluatorUrl, "utf8");
  assert.match(source, /generateReceptionistDecision/);
  assert.match(source, /verifyReceptionistDecision/);
  assert.match(source, /assessGrounding/);
  assert.match(source, /assessPolicy/);
  assert.match(source, /assessHumanHandoff/);
  assert.match(source, /assessFinalResponseQuality/);
  assert.match(source, /verifyFinalClientReply/);
  assert.match(source, /judgeStage3rCaseWithUsage/);
  assert.match(source, /providerSendCount:\s*0/);
  assert.match(source, /duplicateFinalCandidates:\s*0/);
  assert.match(source, /modelCallCount/);
});
