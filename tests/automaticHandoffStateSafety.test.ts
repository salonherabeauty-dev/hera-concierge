import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const engineMigrationUrl = new URL(
  "../supabase/migrations/20260824000006_add_automatic_handoff_engine.sql",
  import.meta.url,
);
const takeoverMigrationUrl = new URL(
  "../supabase/migrations/20260824000007_activate_full_handoff_takeover.sql",
  import.meta.url,
);

test("PostgreSQL accepts the automatic takeover migration", async () => {
  const sql = await readFile(takeoverMigrationUrl, "utf8");
  const parsed = await parse(sql);
  assert.ok(parsed.stmts.length > 0);
});

test("only open full or emergency tasks activate conversation takeover", async () => {
  const sql = await readFile(takeoverMigrationUrl, "utf8");
  assert.match(sql, /new\.scope not in \('full_takeover', 'emergency'\)/);
  assert.match(
    sql,
    /new\.status not in \([\s\S]*'new'[\s\S]*'assigned'[\s\S]*'accepted'[\s\S]*'waiting_client'[\s\S]*'waiting_internal'[\s\S]*\)/,
  );
  assert.doesNotMatch(
    sql,
    /new\.status not in \([\s\S]*'resolved'[\s\S]*\)/,
  );
  assert.doesNotMatch(
    sql,
    /new\.status not in \([\s\S]*'cancelled'[\s\S]*\)/,
  );
});

test("automatic takeover is indefinite until an explicit resolution releases it", async () => {
  const sql = await readFile(takeoverMigrationUrl, "utf8");
  assert.match(sql, /operating_mode = 'management'/);
  assert.match(sql, /human_takeover_until = null/);
  assert.match(sql, /automaticHandoffTaskId/);
  assert.match(sql, /automaticHandoffActivatedAt/);
  assert.match(sql, /automatic_handoff_takeover_activated/);
  assert.doesNotMatch(sql, /operating_mode = 'ai'/);
});

test("task-only handoffs never trigger the full-conversation pause", async () => {
  const sql = await readFile(takeoverMigrationUrl, "utf8");
  assert.match(sql, /new\.scope not in \('full_takeover', 'emergency'\)/);
  assert.doesNotMatch(sql, /'task_only'\s*,\s*'full_takeover'/);
});

test("automatic handoff retries preserve human ownership and terminal state", async () => {
  const sql = await readFile(engineMigrationUrl, "utf8");
  assert.match(sql, /on conflict \(dedupe_key\) do nothing/);
  assert.match(
    sql,
    /task\.status in \([\s\S]*'new'[\s\S]*'assigned'[\s\S]*'accepted'[\s\S]*'waiting_client'[\s\S]*'waiting_internal'[\s\S]*\)/,
  );
  assert.match(
    sql,
    /status = case[\s\S]*when existing\.status = 'waiting_client'[\s\S]*else existing\.status[\s\S]*end/,
  );
  assert.doesNotMatch(sql, /owner_user_id\s*=\s*null/);
  assert.match(sql, /where task\.dedupe_key = p_dedupe_key/);
});

test("takeover activation is idempotent for the same task", async () => {
  const sql = await readFile(takeoverMigrationUrl, "utf8");
  assert.match(
    sql,
    /conversation\.state ->> 'automaticHandoffTaskId' is distinct from new\.id::text/,
  );
  assert.match(sql, /after insert or update of scope, status, priority, task_type/);
});
