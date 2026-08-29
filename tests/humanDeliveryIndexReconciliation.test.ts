import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260829000006_reconcile_human_delivery_indexes.sql",
  import.meta.url,
);

test("human delivery index reconciliation removes the duplicate and covers named reviewers", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(
    sql,
    /drop index if exists public\.ai_human_delivery_reviews_approved_outbox_unique/i,
  );
  assert.match(
    sql,
    /create unique index if not exists ai_human_delivery_reviews_approved_outbox_id_unique/i,
  );
  assert.match(
    sql,
    /create index if not exists ai_human_delivery_reviews_reviewer_idx[\s\S]*reviewer_user_id, reviewed_at desc/i,
  );
});
