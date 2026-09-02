import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WEBSITE_CONCIERGE_MAX_MODEL_CALLS,
  WEBSITE_CONCIERGE_MAX_OUTPUT_TOKENS,
  WEBSITE_CONCIERGE_MAX_TRANSPORT_RETRIES,
} from "../src/website-concierge/engine.js";

const engineUrl = new URL(
  "../src/website-concierge/engine.ts",
  import.meta.url,
);

test("website concierge keeps the proven bounded Sol Max generation envelope", async () => {
  const source = await readFile(engineUrl, "utf8");

  assert.equal(WEBSITE_CONCIERGE_MAX_MODEL_CALLS, 2);
  assert.equal(WEBSITE_CONCIERGE_MAX_TRANSPORT_RETRIES, 1);
  assert.equal(WEBSITE_CONCIERGE_MAX_OUTPUT_TOKENS, 24_000);
  assert.match(source, /toolChoice:\s*\{[\s\S]*type:\s*"tool"/);
  assert.match(source, /strictJsonSchema:\s*true/);
  assert.doesNotMatch(source, /callNumber:\s*3/);
  assert.doesNotMatch(source, /ToolLoopAgent|Output\.object|isStepCount/);
});
