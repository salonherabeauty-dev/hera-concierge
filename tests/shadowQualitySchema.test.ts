import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000001_add_shadow_quality_validation.sql",
  import.meta.url,
);

test("PostgreSQL 17 accepts the shadow quality migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("shadow reviews remain service-role-only and auditable", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table public\.ai_shadow_reviews/);
  assert.match(sql, /alter table public\.ai_shadow_reviews enable row level security/);
  assert.match(sql, /alter table public\.ai_shadow_reviews force row level security/);
  assert.match(
    sql,
    /revoke all on table public\.ai_shadow_reviews from public, anon, authenticated/,
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.ai_shadow_reviews to service_role/,
  );
  assert.match(sql, /shadow_quality_review_recorded/);
});

test("the luxury-service rubric fails closed on core controls", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /p_factual_accuracy < 4/);
  assert.match(sql, /p_safety_compliance < 4/);
  assert.match(sql, /p_policy_compliance < 4/);
  assert.match(sql, /v_overall >= 3\.50/);
  assert.match(sql, /jsonb_array_length\(v_flags\) > 0/);
  assert.match(sql, /v_verdict := 'fail'/);
  assert.match(sql, /v_verdict := 'needs_review'/);
});

test("quality reporting is aggregate while the review queue stays private", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.ai_shadow_quality_snapshot/);
  assert.match(sql, /'providerSendCount'/);
  assert.match(sql, /'duplicateCandidateCases'/);
  assert.match(sql, /'responseP95'/);
  assert.match(sql, /create or replace function public\.ai_list_shadow_review_queue/);
  assert.match(sql, /not exists \([\s\S]*reviewer_type = 'human'/);
  assert.match(
    sql,
    /revoke all on function public\.ai_list_shadow_review_queue\(integer\)[\s\S]*from public, anon, authenticated/,
  );
});
