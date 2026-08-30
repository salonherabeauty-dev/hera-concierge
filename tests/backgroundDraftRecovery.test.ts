import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260829000015_expand_handoff_client_visible_status.sql",
  import.meta.url,
);
const resetScriptUrl = new URL(
  "../public/command-centre/reset-workspace.js",
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

test("verified client replies fit the historical handoff persistence contract", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_handoff_tasks_client_visible_status_check/);
  assert.match(sql, /length\(client_visible_status\)\s*<=\s*4000/i);
});

test("the reset workspace automatically polls truthful draft state without a Create AI Reply action", async () => {
  const source = await readFile(resetScriptUrl, "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /AI is preparing this reply automatically/);
  assert.match(source, /No button press is required/);
  assert.match(source, /AI could not prepare this reply/);
  assert.match(source, /Retry AI Reply/);
  assert.match(source, /Write Manually/);
  assert.match(source, /POLL_MS = 5_000/);
  assert.match(source, /\/api\/command-centre\/reset-state/);
  assert.doesNotMatch(source, /Create AI Reply|receptionist-draft/);
});

test("reset inbox conversations are always ordered by newest activity", async () => {
  const source = await readFile(resetScriptUrl, "utf8");
  assert.match(
    source,
    /\.sort\(\(left, right\) => Date\.parse\(right\.lastMessageAt\) - Date\.parse\(left\.lastMessageAt\)\)/,
  );
  assert.match(source, /item\.lastMessageDirection === "inbound"/);
  assert.match(source, /Human handling — drafting continues/);
});

test("both receptionist entry points load only the reset workspace", async () => {
  const [index, alternate] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(alternateUrl, "utf8"),
  ]);
  for (const html of [index, alternate]) {
    assert.match(html, /data-hera-interface="hera-receptionist-reset-v1"/);
    assert.match(html, /reset-workspace\.css/);
    assert.match(html, /<script type="module" src="\/command-centre\/reset-workspace\.js"><\/script>/);
    assert.doesNotMatch(
      html,
      /receptionist-workspace|receptionist-emergency-fix|receptionist-live-recovery|receptionist-auto-draft-status/,
    );
  }
});
