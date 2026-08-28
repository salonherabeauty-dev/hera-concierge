import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260826000001_add_stage3r_execution_orchestration.sql",
  import.meta.url,
);
const claimRepairUrl = new URL(
  "../supabase/migrations/20260827000001_fix_stage3r_claim_case_ambiguity.sql",
  import.meta.url,
);
const pairwiseSemanticsUrl = new URL(
  "../supabase/migrations/20260827000002_define_stage3r_pairwise_semantics.sql",
  import.meta.url,
);
const workerUrl = new URL("../api/stage3r/worker.ts", import.meta.url);
const evaluatorUrl = new URL(
  "../src/certification/stage3r/executionEvaluator.ts",
  import.meta.url,
);
const costUrl = new URL(
  "../src/certification/stage3r/cost.ts",
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

test("the Stage 3-R claim repair qualifies output-column name collisions", async () => {
  const [baseSql, repairSql] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(claimRepairUrl, "utf8"),
  ]);

  assert.doesNotThrow(() => parse(repairSql));
  for (const sql of [baseSql, repairSql]) {
    assert.match(sql, /update public\.ai_stage3r_case_queue as stale/i);
    assert.match(sql, /stale\.attempts >= stale\.max_attempts/i);
    assert.match(sql, /stale\.locked_at < now\(\)/i);
    assert.doesNotMatch(sql, /case when attempts >= max_attempts/i);
  }
  assert.match(repairSql, /revoke all on function public\.ai_stage3r_claim_case/i);
  assert.match(repairSql, /grant execute[\s\S]*to service_role/i);
});

test("the Stage 3-R database documents versioned non-inferiority semantics", async () => {
  const sql = await readFile(pairwiseSemanticsUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /candidate non-inferiority/i);
  assert.match(sql, /candidate or tie/i);
  assert.match(sql, /candidate-to-reference is a material reversal/i);
  assert.match(sql, /raw judge preferences remain preserved/i);
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
  assert.match(source, /stage3r_run_deployment_identity_mismatch/);
  assert.match(source, /certification_version,release_commit,deployment_url,database_project_ref,corpus_version/);
  assert.match(source, /runIdentity\.release_commit !== currentIdentity\.releaseCommit/);
  assert.match(source, /runIdentity\.deployment_url !== currentIdentity\.deploymentUrl/);
  assert.match(source, /runIdentity\.corpus_version !== STAGE3R_CORPUS_VERSION/);
  assert.doesNotMatch(source, /EMERGENCY_CALIBRATION_TOKEN\s*=/);
  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /stage3r_calibration_requires_1_to_10_cases/);
  assert.match(source, /stage3r_calibration_cost_cap_must_be_at_most_25_usd/);
  assert.match(source, /paidCallsStarted:\s*false/);
  assert.match(source, /APPROVED_FULL_2010_CASE_RUN/);
  assert.match(source, /stage3r_dependency_fetch_failed/);
  assert.match(source, /stage3r_worker_request_failed/);
  assert.match(source, /safeErrorFields\(error\)/);
  assert.match(source, /errorCode === "stage3r_dependency_fetch_failed" \? 503 : 500/);
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
  const [source, costSource] = await Promise.all([
    readFile(evaluatorUrl, "utf8"),
    readFile(costUrl, "utf8"),
  ]);
  assert.match(source, /generateReceptionistDecision/);
  assert.match(source, /verifyReceptionistDecision/);
  assert.match(source, /assessGrounding/);
  assert.match(source, /assessPolicy/);
  assert.match(source, /assessHumanHandoff/);
  assert.match(source, /assessFinalResponseQuality/);
  assert.match(source, /verifyFinalClientReply/);
  assert.match(
    source,
    /deterministic\.risk === "black"[\s\S]{0,100}urgentSafetyReplyFor\(caseItem\.message\)/,
  );
  assert.match(source, /judgeStage3rCaseWithUsage/);
  assert.match(source, /providerSendCount:\s*0/);
  assert.match(source, /duplicateFinalCandidates:\s*0/);
  assert.match(source, /modelCallCount/);
  assert.match(costSource, /anthropic\/claude-sonnet-5/);
  assert.match(costSource, /input:\s*0\.000003/);
  assert.match(costSource, /output:\s*0\.000015/);
  assert.doesNotMatch(source, /Promise\.all\([\s\S]*judgeConfigurations\.map/);
});
