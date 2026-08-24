import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260824000005_create_command_centre_foundation.sql",
  import.meta.url,
);

test("PostgreSQL 17 accepts the Command Centre foundation migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const result = await parse(sql);
  assert.ok(result.stmts.length > 0);
});

test("Command Centre records are forced-RLS and unavailable to browser roles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "ai_staff_profiles",
    "ai_handoff_tasks",
    "ai_handoff_events",
    "ai_command_centre_notes",
    "ai_handoff_sla_policies",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, "i"));
    assert.match(
      sql,
      new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"),
    );
  }
  assert.match(sql, /grant select, insert on table public\.ai_handoff_events to service_role/i);
  assert.doesNotMatch(sql, /grant[^;]*(?:update|delete)[^;]*ai_handoff_events/i);
});

test("task concurrency, ownership and audit controls fail closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /dedupe_key text not null unique/i);
  assert.match(sql, /version integer not null default 1/i);
  assert.match(sql, /for update;/i);
  assert.match(sql, /handoff task version conflict/i);
  assert.match(sql, /handoff task is already owned/i);
  assert.match(sql, /command_centre_task_accepted/i);
  assert.match(sql, /command_centre_task_transitioned/i);
});

test("database functions repeat the role boundary instead of trusting the GUI", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ai_cc_has_capability\(p_actor_user_id, 'create_task'\)/i);
  assert.match(sql, /ai_cc_can_handle_task\(p_actor_user_id, v_task\.task_type\)/i);
  assert.match(sql, /ai_cc_has_capability\(p_actor_user_id, 'control_conversation'\)/i);
  assert.match(sql, /ai_cc_has_capability\(p_actor_user_id, 'add_note'\)/i);
  assert.match(sql, /revoke all on function public\.ai_cc_has_capability\(uuid, text\)/i);
  assert.match(sql, /grant execute on function public\.ai_cc_has_capability\(uuid, text\) to service_role/i);
});

test("the first Preview contains no provider-send database function", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(sql, /send_whatsapp|d360.*send|provider_message_id\s*=/i);
});
