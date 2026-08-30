import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const receptionUrl = new URL(
  "../public/command-centre/reception.html",
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

function assertResetShell(html: string) {
  assert.match(html, /Hera Reception Desk/);
  assert.match(html, /reset-reception-app/);
  assert.match(html, /reset-workspace\.css/);
  assert.match(html, /reset-workspace\.js/);
  assert.doesNotMatch(html, /id="reception-app"/);
  assert.doesNotMatch(html, /receptionist-workspace\.js/);
  assert.doesNotMatch(html, /receptionist-emergency-fix/);
  assert.doesNotMatch(html, /receptionist-live-recovery/);
  assert.doesNotMatch(html, /human-delivery-gate\.js/);
  assert.doesNotMatch(html, /assets\/app\.js/);
  assert.doesNotMatch(html, /preview-operator\.js/);
}

test("every ordinary Reception Desk entry file loads only reset v3", async () => {
  const [index, reception, reset, advanced] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(receptionUrl, "utf8"),
    readFile(resetUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
  ]);

  assertResetShell(index);
  assertResetShell(reception);
  assertResetShell(reset);

  // The advanced legacy console remains separately addressable for audit and
  // cannot become the ordinary receptionist entry point.
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
});

test("Vercel explicitly routes both default Command Centre paths to the reset-v3 index", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const routes = new Map(
    (config.rewrites ?? []).map((route) => [route.source, route.destination]),
  );

  assert.equal(routes.get("/command-centre"), "/command-centre/index.html");
  assert.equal(routes.get("/command-centre/"), "/command-centre/index.html");
});
