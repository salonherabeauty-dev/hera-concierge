import assert from "node:assert/strict";
import test from "node:test";
import { RESPONSE_INSTRUCTIONS, VERIFIER_INSTRUCTIONS } from "../src/ai/receptionist.js";

test("response and verifier prompts make the latest client turn authoritative", () => {
  assert.match(RESPONSE_INSTRUCTIONS, /latest client turn governs the current intent/i);
  assert.match(RESPONSE_INSTRUCTIONS, /not a booking or live-availability request/i);
  assert.match(VERIFIER_INSTRUCTIONS, /latest client turn controls whether a new action exists/i);
  assert.match(VERIFIER_INSTRUCTIONS, /not permission to reopen a completed booking task/i);
});
