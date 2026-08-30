import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const resetUrl = new URL(
  "../public/command-centre/reset.html",
  import.meta.url,
);
const advancedUrl = new URL(
  "../public/command-centre/advanced.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

function assertResetEntry(html: string) {
  assert.match(html, /Hera Reception Desk/);
  assert.match(html, /reset-reception-app/);
  assert.match(html, /reset-workspace\.css/);
  assert.match(html, /reset-workspace\.js/);
  assert.doesNotMatch(html, /reception-app/);
  assert.doesNotMatch(html, /receptionist-workspace\.js/);
  assert.doesNotMatch(html, /receptionist-emergency-fix/);
  assert.doesNotMatch(html, /receptionist-live-recovery/);
  assert.doesNotMatch(html, /human-delivery-gate\.js/);
  assert.doesNotMatch(html, /assets\/app\.js/);
  assert.doesNotMatch(html, /preview-operator\.js/);
}

test("the physical default index and explicit reset page both load only reset-v3", async () => {
  const [index, reset, advanced] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(resetUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
  ]);

  assertResetEntry(index);
  assertResetEntry(reset);
  assert.equal(index, reset);

  // The advanced legacy console remains separately addressable for audit and
  // is never loaded by the default receptionist route.
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
});

test("Vercel keeps both clean default paths pointed at reset-v3 as defence in depth", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const routes = new Map(
    (config.rewrites ?? []).map((route) => [route.source, route.destination]),
  );

  assert.equal(routes.get("/command-centre"), "/command-centre/reset.html");
  assert.equal(routes.get("/command-centre/"), "/command-centre/reset.html");
});
