import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000006_add_automatic_handoff_engine.sql",
  import.meta.url,
);

test("PostgreSQL 17 accepts the automatic handoff migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("automatic handoff persistence is idempotent and refreshes an existing open task", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ai_upsert_automatic_handoff/);
  assert.match(sql, /where task\.conversation_id = p_conversation_id/);
  assert.match(sql, /task\.task_type = p_task_type/);
  assert.match(sql, /automatic_handoff_refreshed/);
  assert.match(sql, /on conflict \(dedupe_key\) do nothing/);
  assert.match(sql, /automatic_handoff_deduplicated/);
});

test("automatic handoff records SLA, audit and service-role-only execution", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ai_handoff_sla_policies/);
  assert.match(sql, /make_interval\(mins/);
  assert.match(sql, /insert into public\.ai_audit_log/);
  assert.match(sql, /revoke all on function public\.ai_upsert_automatic_handoff/);
  assert.match(sql, /grant execute on function public\.ai_upsert_automatic_handoff/);
  assert.match(sql, /to service_role/);
});
