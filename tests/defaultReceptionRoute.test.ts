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
const advancedUrl = new URL(
  "../public/command-centre/advanced.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the actual default Command Centre index is the simple receptionist workspace", async () => {
  const [index, reception, advanced] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(receptionUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
  ]);

  assert.match(index, /Hera Reception/);
  assert.match(index, /simple-receptionist-workspace-v2/);
  assert.match(index, /receptionist-workspace\.css/);
  assert.match(index, /receptionist-workspace\.js/);
  assert.doesNotMatch(index, /human-delivery-gate\.js/);
  assert.doesNotMatch(index, /assets\/app\.js/);
  assert.doesNotMatch(index, /preview-operator\.js/);
  assert.match(reception, /receptionist-workspace\.js/);
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
});

test("Vercel explicitly routes both default Command Centre paths to the simple index", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const routes = new Map(
    (config.rewrites ?? []).map((route) => [route.source, route.destination]),
  );

  assert.equal(routes.get("/command-centre"), "/command-centre/index.html");
  assert.equal(routes.get("/command-centre/"), "/command-centre/index.html");
});
