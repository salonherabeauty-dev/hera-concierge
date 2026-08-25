import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Command Centre exposes exact model, prompt and final-quality trace", async () => {
  const [repository, serverTypes, browserTypes, app] = await Promise.all([
    readFile(new URL("../src/command-centre/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/command-centre/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../command-centre/src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../command-centre/src/app.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /from\("ai_decisions"\)/);
  assert.match(repository, /DecisionTraceView/);
  assert.match(serverTypes, /decisions: DecisionTraceView\[\]/);
  assert.match(browserTypes, /stage: "response" \| "verification" \| "policy"/);
  assert.match(app, /Final response quality/);
  assert.match(app, /Primary model/);
  assert.match(app, /First verifier/);
  assert.match(app, /Final verifier/);
  assert.match(app, /Post-policy draft/);
  assert.match(app, /Final client reply/);
});
