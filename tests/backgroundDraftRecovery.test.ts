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
const legacyReceptionUrl = new URL(
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

test("the explicit legacy receptionist entry keeps its recovery scripts in the required order", async () => {
  const html = await readFile(legacyReceptionUrl, "utf8");
  const workspace = html.indexOf("receptionist-workspace.js");
  const emergency = html.indexOf("receptionist-emergency-fix.js");
  const recovery = html.indexOf("receptionist-live-recovery.js");
  assert.ok(workspace >= 0);
  assert.ok(workspace < emergency);
  assert.ok(emergency < recovery);
  assert.match(html, /<script type="module"/);
});
