import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const namedStaffUrl = new URL(
  "../public/command-centre/named-staff-access.js",
  import.meta.url,
);
const stabilityUrl = new URL(
  "../public/command-centre/runtime-stability.js",
  import.meta.url,
);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const queueMigrationUrl = new URL(
  "../supabase/migrations/20260829000007_fix_human_delivery_queue_blank_messages.sql",
  import.meta.url,
);

test("named staff launcher updates are idempotent and cannot starve browser paint", async () => {
  const source = await readFile(namedStaffUrl, "utf8");
  assert.match(
    source,
    /if \(launcher\.textContent !== presentation\.text\)/,
  );
  assert.match(source, /if \(launcher\.title !== presentation\.title\)/);
  assert.doesNotMatch(
    source,
    /if \(document\.getElementById\(launcherId\)\) \{\s*updateLauncher\(\);\s*return;/,
  );
});

test("runtime stabilizer is loaded before the other Command Centre enhancements", async () => {
  const [index, stability] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(stabilityUrl, "utf8"),
  ]);
  const preview = index.indexOf("preview-operator.js");
  const stabilizer = index.indexOf("runtime-stability.js");
  const delivery = index.indexOf("human-delivery-gate.js");
  const named = index.indexOf("named-staff-access.js");
  const app = index.indexOf("assets/app.js");
  assert.ok(preview >= 0);
  assert.ok(preview < stabilizer);
  assert.ok(stabilizer < delivery);
  assert.ok(delivery < named);
  assert.ok(named < app);
  assert.match(stability, /patchTaskButtonsIdempotently/);
  assert.match(stability, /data-command-centre-retry/);
  assert.match(stability, /10000/);
});

test("human delivery queue represents blank or media-only client turns without failing the API", async () => {
  const migration = await readFile(queueMigrationUrl, "utf8");
  assert.match(
    migration,
    /coalesce\(\s*nullif\(source\.text_body, ''\),\s*'\[Non-text WhatsApp message\]'\s*\) as client_message/s,
  );
  assert.match(
    migration,
    /revoke all on function public\.ai_cc_list_human_delivery_queue/s,
  );
  assert.match(migration, /to service_role/);
});