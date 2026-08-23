import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000002_add_out_of_order_inbound_guard.sql",
  import.meta.url,
);
const repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);

test("PostgreSQL 17 accepts the out-of-order inbound migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("delayed older messages are suppressed before AI processing", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.ai_is_inbound_superseded/);
  assert.match(sql, /create trigger ai_jobs_suppress_superseded_insert/);
  assert.match(sql, /out_of_order_inbound_suppressed/);
  assert.match(sql, /superseded_by_newer_inbound/);
  assert.match(sql, /not public\.ai_is_inbound_superseded\(candidate\.source_message_id\)/);
});

test("a stale candidate is blocked again immediately before a provider send", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /alter function public\.ai_authorize_whatsapp_outbox_send\(uuid\)[\s\S]*rename to ai_authorize_whatsapp_outbox_send_base/,
  );
  assert.match(sql, /outbox_blocked_newer_inbound/);
  assert.match(sql, /last_error = 'blocked_by_newer_inbound'/);
  assert.match(
    sql,
    /return public\.ai_authorize_whatsapp_outbox_send_base\(p_outbox_id\)/,
  );
});

test("conversation history is ordered by provider chronology, not webhook arrival", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(
    source,
    /select\("id,direction,kind,text_body,provider_timestamp,created_at"\)/,
  );
  assert.match(source, /effectiveTimestamp\(item\.provider_timestamp, createdAt\)/);
  assert.match(
    source,
    /\.sort\(\(a, b\) => a\.orderAt - b\.orderAt \|\| a\.createdAt\.localeCompare\(b\.createdAt\)\)/,
  );
});

test("chronology RPCs remain service-role-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /revoke all on function public\.ai_is_inbound_superseded\(uuid\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    sql,
    /revoke all on function public\.ai_authorize_whatsapp_outbox_send_base\(uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    sql,
    /grant execute on function public\.ai_authorize_whatsapp_outbox_send\(uuid\)[\s\S]*to service_role/,
  );
});
