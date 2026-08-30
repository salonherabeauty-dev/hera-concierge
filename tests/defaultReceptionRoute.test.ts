import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const resetUrl = new URL(
  "../public/command-centre/reset.html",
  import.meta.url,
);
const advancedUrl = new URL(
  "../public/command-centre/advanced.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the actual default Command Centre target is the isolated reset-v3 Reception Desk", async () => {
  const [reset, advanced] = await Promise.all([
    readFile(resetUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
  ]);

  assert.match(reset, /Hera Reception Desk/);
  assert.match(reset, /reset-reception-app/);
  assert.match(reset, /reset-workspace\.css/);
  assert.match(reset, /reset-workspace\.js/);
  assert.doesNotMatch(reset, /receptionist-workspace\.js/);
  assert.doesNotMatch(reset, /receptionist-emergency-fix/);
  assert.doesNotMatch(reset, /receptionist-live-recovery/);
  assert.doesNotMatch(reset, /human-delivery-gate\.js/);
  assert.doesNotMatch(reset, /assets\/app\.js/);
  assert.doesNotMatch(reset, /preview-operator\.js/);

  // The advanced legacy console remains separately addressable for audit and
  // is not the default receptionist workspace.
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
});

test("Vercel explicitly routes both default Command Centre paths to reset-v3", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const routes = new Map(
    (config.rewrites ?? []).map((route) => [route.source, route.destination]),
  );

  assert.equal(routes.get("/command-centre"), "/command-centre/reset.html");
  assert.equal(routes.get("/command-centre/"), "/command-centre/reset.html");
});
