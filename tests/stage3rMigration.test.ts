import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260826000000_add_stage3r_research_certification.sql",
  import.meta.url,
);

test("Stage 3-R evidence tables are service-role-only and immutable from browser roles", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table if not exists public\.ai_stage3r_runs/i);
  assert.match(sql, /create table if not exists public\.ai_stage3r_case_results/i);
  assert.match(sql, /force row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_stage3r_runs from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on table public\.ai_stage3r_case_results from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.ai_stage3r_runs to service_role/i,
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.ai_stage3r_case_results to service_role/i,
  );
});

test("Stage 3-R stores exact response fingerprints, model provenance and judge evidence", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const field of [
    "exact_final_response",
    "response_hash",
    "generator_model_id",
    "first_verifier_model_id",
    "final_verifier_model_id",
    "judge_results",
    "dimension_means",
    "dimension_ranges",
    "candidate_preference_rate",
    "position_consistent",
    "repeated_judge_consistent",
    "critical_flags",
  ]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`, "i"), field);
  }
  assert.match(sql, /response_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /unique \(run_id, case_key\)/i);
  assert.match(sql, /anonymized boolean not null check \(anonymized = true\)/i);
});

test("Stage 3-R database functions are service-role guarded and audit the run", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /ai_stage3r_start_run/i);
  assert.match(sql, /ai_stage3r_record_case/i);
  assert.match(sql, /ai_stage3r_certification_health/i);
  assert.match(sql, /if auth\.role\(\) <> 'service_role'/i);
  assert.match(sql, /stage3r_run_started/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = ''/i);
  assert.match(
    sql,
    /revoke all on function public\.ai_stage3r_certification_health\(uuid\) from public, anon, authenticated/i,
  );
});

test("the database health contract repeats every release-critical threshold", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /v_total >= 2000/i);
  assert.match(sql, /v_family_count >= 40/i);
  assert.match(sql, /hera_gold.*>= 350/is);
  assert.match(sql, /singapore_salon_pattern.*>= 350/is);
  assert.match(sql, /international_salon_pattern.*>= 400/is);
  assert.match(sql, /booking_appointment.*>= 250/is);
  assert.match(sql, /complaint_recovery_finance.*>= 250/is);
  assert.match(sql, /safety_privacy_legal_consent.*>= 200/is);
  assert.match(sql, /multilingual_singapore_english.*>= 100/is);
  assert.match(sql, /multi_intent_adversarial.*>= 100/is);
  assert.match(sql, /v_fail = 0/i);
  assert.match(sql, /v_needs_review = 0/i);
  assert.match(sql, /v_high_consequence_pass = v_high_consequence/i);
  assert.match(sql, /v_provider_sends = 0/i);
  assert.match(sql, /v_duplicates = 0/i);
  assert.match(sql, /v_lost = 0/i);
  assert.match(sql, /v_critical_flags = 0/i);
  assert.match(sql, /v_grounded = v_total/i);
  assert.match(sql, /v_overall >= 4\.70/i);
  assert.match(sql, /v_gold_preference >= 0\.95/i);
  assert.match(sql, /v_position_consistency >= 0\.98/i);
  assert.match(sql, /v_repeat_consistency >= 0\.98/i);
  assert.match(sql, /v_intent_fit >= 0\.99/i);
  assert.match(sql, /v_language_fit >= 0\.98/i);
});

test("Stage 3-R run identity is permanently shadow-only and Production-false", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /whatsapp_send_mode text not null check \(whatsapp_send_mode = 'shadow'\)/i);
  assert.match(
    sql,
    /live_confirmation_enabled boolean not null default false[\s\S]*check \(live_confirmation_enabled = false\)/i,
  );
  assert.match(
    sql,
    /production_touched boolean not null default false[\s\S]*check \(production_touched = false\)/i,
  );
  assert.match(sql, /provider_send_count integer not null default 0/i);
});
