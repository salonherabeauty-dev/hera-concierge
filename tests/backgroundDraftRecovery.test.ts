import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260829000015_expand_handoff_client_visible_status.sql",
  import.meta.url,
);
const recoveryUrl = new URL(
  "../public/command-centre/receptionist-live-recovery.js",
  import.meta.url,
);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const alternateUrl = new URL(
  "../public/command-centre/reception.html",
  import.meta.url,
);

function moduleBody(source: string): string {
  return source.replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*"[^"]+";\s*/,
    "",
  );
}

test("verified client replies fit the handoff persistence contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_handoff_tasks_client_visible_status_check/);
  assert.match(sql, /length\(client_visible_status\)\s*<=\s*4000/i);
});

test("selected fresh inbound messages recover drafts automatically without sending", async () => {
  const source = await readFile(recoveryUrl, "utf8");
  assert.doesNotThrow(() => new Function(moduleBody(source)));
  assert.match(source, /^import\s*\{/);
  assert.match(source, /maybeRecoverSelectedDraft/);
  assert.match(source, /\/api\/command-centre\/receptionist-draft/);
  assert.match(source, /latest\.direction\s*!==\s*"inbound"/);
  assert.match(source, /REPLY_WINDOW_MS/);
  assert.match(source, /MAX_AUTO_DRAFT_ATTEMPTS\s*=\s*3/);
  assert.match(source, /AUTO_DRAFT_COOLDOWN_MS\s*=\s*45_000/);
  assert.match(source, /status\s*===\s*"retry"/);
  assert.doesNotMatch(source, /receptionist-message|Send to Client|sendText|360dialog/i);
});

test("inbox conversations are reordered by latest activity descending", async () => {
  const source = await readFile(recoveryUrl, "utf8");
  assert.match(source, /sortedConversationIds/);
  assert.match(source, /right\.lastMessageAt/);
  assert.match(source, /left\.lastMessageAt/);
  assert.match(source, /list\.scrollTop\s*=\s*0/);
});

test("legacy recovery remains available as historical code but is never loaded by reset-v3 entry points", async () => {
  const [index, alternate] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(alternateUrl, "utf8"),
  ]);
  for (const html of [index, alternate]) {
    assert.match(html, /reset-reception-app/);
    assert.match(html, /reset-workspace\.js/);
    assert.doesNotMatch(html, /receptionist-workspace\.js/);
    assert.doesNotMatch(html, /receptionist-emergency-fix\.js/);
    assert.doesNotMatch(html, /receptionist-live-recovery\.js/);
  }
});
