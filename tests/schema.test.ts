import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260821000000_create_hera_ai_receptionist.sql",
  import.meta.url,
);

const indexMigrationUrl = new URL(
  "../supabase/migrations/20260821000001_add_ai_foreign_key_indexes.sql",
  import.meta.url,
);

test("database migration contains the required isolation and idempotency controls", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "ai_contacts",
    "ai_conversations",
    "ai_messages",
    "ai_jobs",
    "ai_outbox",
    "ai_decisions",
    "ai_knowledge_documents",
    "ai_incidents",
    "ai_audit_log",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table}`));
  }
  assert.match(sql, /unique index ai_messages_provider_id_unique/);
  assert.match(sql, /dedupe_key text not null unique/);
  assert.match(sql, /for update(?: of candidate)? skip locked/);
  assert.match(sql, /security definer/g);
  assert.match(sql, /set search_path = ''/g);
  assert.match(sql, /grant execute .* service_role/s);
});

test("PostgreSQL 17 accepts the migration syntax", async () => {
  for (const url of [migrationUrl, indexMigrationUrl]) {
    const sql = await readFile(url, "utf8");
    const result = await parse(sql);
    assert.ok(result.stmts.length > 0);
  }
});

test("foreign keys used by queue and conversation workflows are indexed", async () => {
  const sql = await readFile(indexMigrationUrl, "utf8");
  for (const index of [
    "ai_messages_contact_id_idx",
    "ai_jobs_source_message_id_idx",
    "ai_outbox_conversation_id_idx",
    "ai_outbox_source_message_id_idx",
    "ai_decisions_conversation_id_idx",
    "ai_incidents_conversation_id_idx",
  ]) {
    assert.match(sql, new RegExp(`create index if not exists ${index}`));
  }
});
