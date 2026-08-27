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
const vercelUrl = new URL("../vercel.json", import.meta.url);

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
  assert.match(sql, /calibration Stage 3-R run cannot exceed 100 cases/i);
  assert.match(sql, /calibration Stage 3-R run requires concurrency one/i);
  assert.match(sql, /max_estimated_cost_usd/i);
  assert.match(sql, /immutable execution evidence/i);
  assert.match(sql, /create or replace function public\.ai_stage3r_start_calibration/i);
  assert.match(sql, /paidCallsStarted', false/i);
});

test("the protected worker is Preview-only, shadow-only and cannot send WhatsApp", async () => {
  const source = await readFile(workerUrl, "utf8");
  const vercel = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    crons?: Array<{ path?: string }>;
    functions?: Record<string, { includeFiles?: string; maxDuration?: number | string }>;
  };
  assert.match(source, /VERCEL_ENV !== "preview"/);
  assert.match(source, /feat\/hera-ai-receptionist-foundation/);
  assert.match(source, /sendMode !== "shadow"/);
  assert.match(source, /WHATSAPP_LIVE_CONFIRMATION/);
  assert.match(source, /STAGE3R_EXECUTION_TOKEN/);
  assert.match(source, /EMERGENCY_CALIBRATION_TOKEN_SHA256/);
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /2026-08-28T13:00:00Z/);
  assert.match(source, /\[0, 6, 10, 20, 1910\]/);
  assert.match(source, /EMERGENCY_CALIBRATION_COST_CAP_USD = 10/);
  assert.match(source, /emergency_calibration_scope_mismatch/);
  assert.match(source, /emergency_access_requires_calibration_run/);
  assert.doesNotMatch(source, /EMERGENCY_CALIBRATION_TOKEN\s*=/);
  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /stage3r_calibration_requires_1_to_10_cases/);
  assert.match(source, /stage3r_calibration_cost_cap_must_be_at_most_25_usd/);
  assert.match(source, /paidCallsStarted:\s*false/);
  assert.match(source, /APPROVED_FULL_2010_CASE_RUN/);
  assert.doesNotMatch(source, /CRON_SECRET/);
  assert.doesNotMatch(
    source,
    /MetaWhatsAppClient|D360WhatsAppClient|queueOutbound|sendText|WHATSAPP_ACCESS_TOKEN|D360_API_KEY/,
  );
  assert.ok(!vercel.crons?.some((item) => item.path === "/api/stage3r/worker"));
  assert.equal(
    vercel.functions?.["api/stage3r/worker.ts"]?.includeFiles,
    "{evals/*.json,governance/stage3r-*.json}",
  );
  assert.equal(vercel.functions?.["api/stage3r/worker.ts"]?.maxDuration, "max");
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
