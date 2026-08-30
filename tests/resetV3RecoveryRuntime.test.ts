import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateUrl = new URL(
  "../api/command-centre/reset-state.ts",
  import.meta.url,
);
const recoveryUrl = new URL(
  "../api/command-centre/reset-recover.ts",
  import.meta.url,
);
const recoveryClientUrl = new URL(
  "../public/command-centre/reset-recovery.js",
  import.meta.url,
);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const resetUrl = new URL(
  "../public/command-centre/reset.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the read-only reset-state endpoint cannot start a long AI job", async () => {
  const source = await readFile(stateUrl, "utf8");
  assert.doesNotMatch(source, /waitUntil/);
  assert.doesNotMatch(source, /drainResetTurnJobs/);
  assert.match(source, /methodNotAllowed\(response, \["GET"\]\)/);
});

test("authenticated recovery runs in its own long-duration function", async () => {
  const [source, vercelText] = await Promise.all([
    readFile(recoveryUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
  ]);
  const vercel = JSON.parse(vercelText) as {
    functions?: Record<string, { maxDuration?: string | number }>;
  };

  assert.match(source, /requireReceptionistResetV3/);
  assert.match(source, /authenticateCommandCentre/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /requireCommandCentreCsrf/);
  assert.match(source, /waitUntil\([\s\S]*drainResetTurnJobs/);
  assert.match(source, /automaticDeliveryAllowed:\s*false/);
  assert.doesNotMatch(source, /sendText|D360WhatsAppClient|MetaWhatsAppClient/);
  assert.doesNotMatch(source, /(?:create|update|cancel|reschedule).*Timely/i);
  assert.equal(
    vercel.functions?.["api/command-centre/reset-recover.ts"]?.maxDuration,
    "max",
  );
  assert.equal(
    vercel.functions?.["api/command-centre/reset-state.ts"]?.maxDuration,
    30,
  );
});

test("the Reception Desk requests bounded recovery without altering the main workspace", async () => {
  const [client, index, reset] = await Promise.all([
    readFile(recoveryClientUrl, "utf8"),
    readFile(indexUrl, "utf8"),
    readFile(resetUrl, "utf8"),
  ]);

  assert.match(client, /\/api\/command-centre\/reset-recover/);
  assert.match(client, /method:\s*"POST"/);
  assert.match(client, /X-Hera-CSRF/);
  assert.match(client, /RECOVERY_INTERVAL_MS = 60_000/);
  assert.match(client, /document\.visibilityState/);
  assert.doesNotMatch(client, /sendText|Timely|candidateText|messageText/);
  for (const html of [index, reset]) {
    assert.match(html, /reset-workspace\.js/);
    assert.match(html, /reset-scroll-stability\.js/);
    assert.match(html, /reset-recovery\.js/);
  }
});
