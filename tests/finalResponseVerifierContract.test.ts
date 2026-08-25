import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
} from "../src/ai/receptionist.js";

test("the final verifier reviews the exact post-policy client text", async () => {
  assert.equal(FINAL_RESPONSE_VERIFIER_PROMPT_VERSION, "hera-final-response-verifier-1.1.0");
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /exact post-policy text/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /specialised task/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /complaint/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /every score must be 2/i);

  const source = await readFile(new URL("../src/ai/receptionist.ts", import.meta.url), "utf8");
  assert.match(source, /verifyFinalClientReply/);
  assert.match(source, /exactPostPolicyDraft/);
  assert.match(source, /finalResponseVerificationSchema/);
});
