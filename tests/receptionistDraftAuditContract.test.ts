import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const draftingMigration = new URL(
  "../supabase/migrations/20260829000013_enable_human_review_shadow_drafting.sql",
  import.meta.url,
);
const auditMigration = new URL(
  "../supabase/migrations/20260829000014_allow_human_audit_actor.sql",
  import.meta.url,
);

test("Create AI Reply uses a named human audit actor that the schema accepts", async () => {
  const [drafting, audit] = await Promise.all([
    readFile(draftingMigration, "utf8"),
    readFile(auditMigration, "utf8"),
  ]);

  assert.doesNotThrow(() => parse(audit));
  assert.match(
    drafting,
    /'human'[\s\S]*'receptionist_shadow_draft_requested'/,
  );
  assert.match(
    audit,
    /actor_type\s+in\s*\(\s*'system'\s*,\s*'ai'\s*,\s*'management'\s*,\s*'human'\s*\)/i,
  );
});
