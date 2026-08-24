import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000003_add_historical_backfill_suppression.sql",
  import.meta.url,
);

test("PostgreSQL 17 accepts the historical backfill migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("messages delivered over one hour late are preserved but never create AI work", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.ai_is_inbound_historical_backfill/);
  assert.match(
    sql,
    /message\.provider_timestamp < message\.created_at - interval '60 minutes'/,
  );
  assert.match(sql, /historical_backfill_suppressed/);
  assert.match(sql, /return null;/);
  assert.match(sql, /historical_backfill_not_live_enquiry/);
});

test("job recovery and provider authorization re-check the combined block reason", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.ai_inbound_processing_block_reason/);
  assert.match(sql, /public\.ai_inbound_processing_block_reason\(job\.source_message_id\)/);
  assert.match(sql, /public\.ai_inbound_processing_block_reason\(candidate\.source_message_id\) is null/);
  assert.match(sql, /outbox_blocked_historical_backfill/);
  assert.match(sql, /blocked_historical_backfill/);
  assert.match(
    sql,
    /return public\.ai_authorize_whatsapp_outbox_send_base\(p_outbox_id\)/,
  );
});

test("backfill candidates are operational evidence rather than real launch cases", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /when public\.ai_is_inbound_historical_backfill\(message\.id\) then 'operational'/,
  );
  assert.match(sql, /historical_backfill_reviews_reclassified/);
  assert.match(sql, /include_in_launch_metrics = false/);
  assert.match(sql, /historical_backfill_evidence_classified/);
});

test("internal backfill controls remain least privilege", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /revoke all on function public\.ai_inbound_processing_block_reason\(uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.ai_suppress_superseded_job_insert\(\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    sql,
    /grant execute on function public\.ai_is_inbound_historical_backfill\(uuid\)[\s\S]*to service_role/,
  );
});
