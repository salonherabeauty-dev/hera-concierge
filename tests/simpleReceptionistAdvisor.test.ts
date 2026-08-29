import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260829000012_simple_receptionist_security_indexes.sql",
  import.meta.url,
);

test("receptionist regeneration history closes feature-specific advisor findings", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /regeneration_history_candidate_idx/i);
  assert.match(sql, /regeneration_history_conversation_idx/i);
  assert.match(sql, /regeneration_history_job_idx/i);
  assert.match(sql, /create policy[\s\S]*deny_direct_access/i);
  assert.match(sql, /as restrictive/i);
  assert.match(sql, /for all[\s\S]*to public/i);
  assert.match(sql, /using \(false\)/i);
  assert.match(sql, /with check \(false\)/i);
});
