import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proofUrl = new URL("../scripts/pr73-build-proof.ts", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the historical PR73 proof remains tightly scoped and cannot become a general reset tool", async () => {
  const source = await readFile(proofUrl, "utf8");
  assert.match(source, /EXPECTED_BRANCH = "feat\/hera-ai-receptionist-foundation"/);
  assert.match(source, /VERCEL_ENV === "preview"/);
  assert.match(source, /WHATSAPP_SEND_MODE === "shadow"/);
  assert.match(source, /WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE"/);
  assert.match(source, /Date\.now\(\) < EXPIRES_AT/);
  assert.doesNotMatch(source, /Juliane|Neo|2473|2052/);
});

test("the historical proof is one-attempt, shadow-only and unable to claim the outbox", async () => {
  const source = await readFile(proofUrl, "utf8");
  assert.match(source, /TARGETS = \[/);
  assert.equal((source.match(/jobHash:/g) ?? []).length, 2);
  assert.equal((source.match(/sourceHash:/g) ?? []).length, 2);
  assert.match(source, /max_attempts: 1/);
  assert.match(source, /one_attempt_already_consumed/);
  assert.match(source, /proofRepository\.claimOutbox = async \(\) => \[\]/);
  assert.match(source, /automaticDeliveryAllowed: false/);
  assert.match(source, /provider_message_id == null/);
  assert.doesNotMatch(source, /sendText|D360WhatsAppClient|MetaWhatsAppClient|Timely/i);
});

test("reset-v3 uses a pure offline deployment build and never invokes the mutable PR73 proof", async () => {
  const [packageJson, vercelJson] = await Promise.all([
    readFile(packageUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
  ]);
  const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  const vercel = JSON.parse(vercelJson) as { buildCommand?: string };

  assert.equal(pkg.scripts?.["proof:pr73"], "tsx scripts/pr73-build-proof.ts");
  assert.equal(pkg.scripts?.build, "npm run build:command-centre");
  assert.equal(vercel.buildCommand, "npm run build");
  assert.doesNotMatch(vercel.buildCommand ?? "", /proof:pr73/);
  assert.doesNotMatch(pkg.scripts?.test ?? "", /proof:pr73/);
});
