import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260828000000_add_stage3r_model_attempt_ledger.sql",
  import.meta.url,
);
const workerUrl = new URL("../api/stage3r/worker.ts", import.meta.url);

test("PostgreSQL accepts the Stage 3-R attempt-ledger migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
});

test("every calibration attempt is private, atomic, bounded and fail-closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table if not exists public\.ai_stage3r_model_attempts/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /cost_usd numeric\(18,12\)/i);
  assert.match(sql, /legacy_model_call_count integer not null default 0/i);
  assert.match(sql, /legacy_estimated_cost_usd numeric\(18,12\) not null default 0/i);
  assert.match(sql, /legacy_unpriced_case_count integer not null default 0/i);
  assert.match(sql, /set max_model_attempts = 75[\s\S]*run_mode = 'calibration'/i);
  assert.match(sql, /set max_attempts = 1[\s\S]*run\.run_mode = 'calibration'/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_stage3r_model_attempts from public, anon, authenticated/i,
  );
  assert.match(sql, /grant select, insert, update, delete[\s\S]*to service_role/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /current_user <> 'service_role'/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /status in \('started', 'unpriced'\)/i);
  assert.match(sql, /stage3r_cost_instrumentation_blocked/i);
  assert.match(sql, /stage3r_model_attempt_cap_reached/i);
  assert.match(sql, /stage3r_cost_cap_reached/i);
  assert.match(sql, /when new\.run_mode = 'calibration' then 75/i);
  assert.match(sql, /new\.max_attempts := 1/i);
  assert.match(sql, /update of run_mode, max_model_attempts/i);
  assert.match(sql, /when p_usage is null or p_cost_usd is null then 'unpriced'/i);
  assert.match(sql, /costInstrumentationBlocked/i);
  assert.match(sql, /modelAttemptCapReached/i);
});

test("the worker checks attempt instrumentation before claiming or spending", async () => {
  const source = await readFile(workerUrl, "utf8");
  const instrumentationGuard = source.indexOf(
    "beforeClaim?.costInstrumentationBlocked",
  );
  const claim = source.indexOf('"ai_stage3r_claim_case"');

  assert.ok(instrumentationGuard > 0);
  assert.ok(claim > instrumentationGuard);
  assert.match(source, /beforeClaim\?\.modelAttemptCapReached/);
  assert.match(source, /createStage3rAttemptLedger/);
  assert.match(source, /generationAttemptLedger:/);
  assert.match(source, /stage3r_case_execution_failed/);
});
