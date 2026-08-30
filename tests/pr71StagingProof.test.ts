import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const proofUrl = new URL("../scripts/pr71-build-proof.ts", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("PR71 proof runs only on the exact expiring shadow staging Preview", async () => {
  const source = await readFile(proofUrl, "utf8");
  assert.match(source, /EXPECTED_BRANCH = "feat\/hera-ai-receptionist-foundation"/);
  assert.match(source, /VERCEL_ENV === "preview"/);
  assert.match(source, /WHATSAPP_SEND_MODE === "shadow"/);
  assert.match(source, /WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE"/);
  assert.match(source, /Date\.now\(\) < EXPIRES_AT/);
  assert.doesNotMatch(source, /Juliane|Neo|2473|2052/);
});

test("proof is exactly one attempt per hashed target and cannot claim the outbox", async () => {
  const source = await readFile(proofUrl, "utf8");
  assert.match(source, /TARGETS = \[/);
  assert.equal((source.match(/jobHash:/g) ?? []).length, 2);
  assert.equal((source.match(/sourceHash:/g) ?? []).length, 2);
  assert.match(source, /max_attempts: 1/);
  assert.match(source, /one_attempt_already_consumed/);
  assert.match(source, /proofRepository\.claimOutbox = async \(\) => \[\]/);
  assert.match(source, /automaticDeliveryAllowed: false/);
  assert.match(source, /provider_message_id == null/);
  assert.match(source, /deliveryEligible === true/);
  assert.match(source, /finalVerification\.approved === true/);
  assert.match(source, /finalQuality\.passed === true/);
  assert.doesNotMatch(source, /sendText|D360WhatsAppClient|MetaWhatsAppClient|Timely/i);
});

test("only the Vercel build invokes the staging proof", async () => {
  const [packageJson, vercelJson] = await Promise.all([
    readFile(packageUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
  ]);
  const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  const vercel = JSON.parse(vercelJson) as { buildCommand?: string };
  assert.equal(pkg.scripts?.["proof:pr71"], "tsx scripts/pr71-build-proof.ts");
  assert.equal(vercel.buildCommand, "npm run build && npm run proof:pr71");
  assert.equal(pkg.scripts?.build, "npm run build:command-centre");
  assert.doesNotMatch(pkg.scripts?.test ?? "", /proof:pr71/);
});
