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

test("legacy recovery endpoint is disabled and cannot start a model call", async () => {
  const [source, vercelText] = await Promise.all([
    readFile(recoveryUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
  ]);
  const vercel = JSON.parse(vercelText) as {
    functions?: Record<string, { maxDuration?: string | number }>;
  };

  assert.match(source, /requireReceptionistResetV3/);
  assert.match(source, /status\(410\)/);
  assert.match(source, /automatic_generation_disabled/);
  assert.doesNotMatch(source, /waitUntil|drainResetTurnJobs/);
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

test("the Reception Desk does not load automatic recovery", async () => {
  const [client, index, reset] = await Promise.all([
    readFile(recoveryClientUrl, "utf8"),
    readFile(indexUrl, "utf8"),
    readFile(resetUrl, "utf8"),
  ]);

  assert.match(client, /\/api\/command-centre\/reset-recover/);
  for (const html of [index, reset]) {
    assert.match(html, /reset-workspace\.js/);
    assert.match(html, /reset-scroll-stability\.js/);
    assert.doesNotMatch(html, /reset-recovery\.js/);
  }
});
