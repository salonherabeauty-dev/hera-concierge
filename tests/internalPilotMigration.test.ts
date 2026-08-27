import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260827000003_add_internal_pilot_send_guard.sql",
  import.meta.url,
);

test("PostgreSQL accepts the internal pilot guard migration", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
});

test("internal pilot permits are private, atomic and irreversibly bounded", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_internal_pilot_send_permits[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(sql, /security invoker/i);
  assert.match(sql, /current_user <> 'service_role'/i);
  assert.match(sql, /urgent-green-lane-2026-08-27/i);
  assert.match(sql, /p_max_send_attempts > 10/i);
  assert.match(sql, /cardinality\(p_allowlisted_wa_ids\) > 5/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /internal_pilot_destination_not_allowlisted/i);
  assert.match(sql, /internal_pilot_duplicate_send_attempt_blocked/i);
  assert.match(sql, /internal_pilot_send_attempt_cap_reached/i);
  assert.match(
    sql,
    /public\.ai_authorize_whatsapp_outbox_send\(p_outbox_id\)/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.ai_authorize_internal_pilot_outbox_send[\s\S]*to service_role/i,
  );
});
