import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000000_add_360dialog_coexistence.sql",
  import.meta.url,
);

test("PostgreSQL 17 accepts the 360dialog Coexistence migration syntax", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("Coexistence migration prevents human and AI reply collisions", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /human_takeover_until timestamptz/);
  assert.match(sql, /ai_ingest_whatsapp_human_echo/);
  assert.match(sql, /ai_authorize_whatsapp_outbox_send/);
  assert.match(sql, /message_recorded_human_takeover/);
  assert.match(sql, /blocked_by_human_takeover/);
  assert.match(sql, /status in \('pending', 'retry', 'processing'\)/);
  assert.match(sql, /grant execute .*ai_ingest_whatsapp_human_echo/s);
  assert.match(sql, /grant execute .*ai_authorize_whatsapp_outbox_send/s);
});
