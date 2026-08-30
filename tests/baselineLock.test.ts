import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const packageUrl = new URL("../package.json", import.meta.url);
const scriptsUrl = new URL("../scripts/", import.meta.url);
const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("the deployment build is deterministic and contains no one-time diagnostics", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};

  assert.equal(scripts.build, "npm run build:command-centre");
  assert.equal(
    scripts.test,
    "npm run typecheck && npm run build && npm run test:unit",
  );
  assert.doesNotMatch(
    scripts.build ?? "",
    /audit|diagnos|reconcil|repair|prove|patch/i,
  );
});

test("the scripts directory contains permanent tooling plus only the audited expiring proofs", async () => {
  const names = (await readdir(scriptsUrl)).sort();
  assert.deepEqual(names, [
    "pr71-build-proof.ts",
    "pr73-build-proof.ts",
    "run-model-evals.ts",
    "scan-secrets.mjs",
  ]);
});

test("CI executes the exact Vercel build and verifies generated assets", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(
    workflow,
    /name: Exact Vercel deployment build[\s\S]*run: npm run build/,
  );
  assert.match(
    workflow,
    /name: Verify generated Command Centre assets are committed[\s\S]*git diff --exit-code -- public\/command-centre/,
  );
  assert.match(workflow, /name: Complete automated suite[\s\S]*npm run test:unit/);
});
