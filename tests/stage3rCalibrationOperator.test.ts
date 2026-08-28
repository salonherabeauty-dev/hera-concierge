import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const operatorUrl = new URL(
  "../public/stage3r-calibration-operator.js",
  import.meta.url,
);
const pageUrl = new URL(
  "../public/stage3r-calibration-operator.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the private operator is fixed to the approved five-case US$3 calibration", async () => {
  const [operator, page, vercel] = await Promise.all([
    readFile(operatorUrl, "utf8"),
    readFile(pageUrl, "utf8"),
    readFile(vercelUrl, "utf8"),
  ]);

  assert.match(operator, /caseIndices: \[0, 6, 10, 20, 1910\]/);
  assert.match(operator, /maxEstimatedCostUsd: 3/);
  assert.match(operator, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(operator, /EMERGENCY_CALIBRATION_TOKEN/);
  assert.match(page, /type="password"/);
  assert.match(page, /No paid call has started/);
  assert.match(vercel, /stage3r-calibration-operator/);
  assert.match(vercel, /noindex, nofollow, noarchive/);
  assert.match(vercel, /form-action 'none'/);
});
