import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000004_fix_incident_upsert_and_reconcile_backfill.sql",
  import.meta.url,
);
const repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);

test("PostgreSQL 17 accepts the incident and backfill reconciliation migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("incident upsert columns are backed by an inferable unique constraint", async () => {
  const [sql, repository] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);
  assert.match(repository, /onConflict: "source_message_id,category"/);
  assert.match(sql, /drop index if exists public\.ai_incidents_message_category_unique/);
  assert.match(
    sql,
    /add constraint ai_incidents_message_category_unique[\s\S]*unique \(source_message_id, category\)/,
  );
});

test("pre-guard backfill jobs and outbox items are reconciled without deleting evidence", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /job\.status in \('pending', 'retry', 'processing', 'dead'\)/);
  assert.match(sql, /historical_backfill_job_reconciled/);
  assert.match(sql, /historical_backfill_not_live_enquiry/);
  assert.match(sql, /historical_backfill_outbox_reconciled/);
  assert.match(sql, /finalStatus', 'shadowed'/);
});

test("backfill incidents close with an auditable resolution", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /historical_backfill_incident_closed/);
  assert.match(sql, /closureReason', 'historical_backfill_not_live_enquiry'/);
  assert.match(sql, /incident\.status in \('open', 'monitoring'\)/);
});

test("conversation risk excludes historical backfill but retains legitimate policy and incident risk", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /not public\.ai_is_inbound_historical_backfill\(message\.id\)/);
  assert.match(sql, /incident\.source_message_id is null/);
  assert.match(sql, /historical_backfill_risk_reconciled/);
  assert.match(sql, /exclude_historical_backfill_from_live_risk_state/);
});
