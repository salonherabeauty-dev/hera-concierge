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

test("the actual default Command Centre index is the simplified reset Reception Desk", async () => {
  const [index, reception, advanced] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(receptionUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
  ]);

  for (const html of [index, reception]) {
    assert.match(html, /Hera Reception Desk/);
    assert.match(html, /hera-receptionist-reset-v1/);
    assert.match(html, /reset-workspace\.css/);
    assert.match(html, /reset-workspace\.js/);
    assert.doesNotMatch(
      html,
      /human-delivery-gate|assets\/app\.js|preview-operator|receptionist-workspace|receptionist-readability|receptionist-emergency-fix|receptionist-live-recovery/,
    );
  }

  // The separate advanced audit surface remains available without contaminating
  // the receptionist's daily interface.
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
});

test("Vercel explicitly routes both default Command Centre paths to the reset front desk index", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    rewrites?: Array<{ source?: string; destination?: string }>;
  };
  const routes = new Map(
    (config.rewrites ?? []).map((route) => [route.source, route.destination]),
  );

  assert.equal(routes.get("/command-centre"), "/command-centre/index.html");
  assert.equal(routes.get("/command-centre/"), "/command-centre/index.html");
});
