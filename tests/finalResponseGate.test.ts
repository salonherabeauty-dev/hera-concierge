import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FINAL_RESPONSE_CORRECTIONS,
  runFinalResponseGate,
} from "../src/ai/finalResponseGate.js";

interface TestVerification {
  approved: boolean;
  correctedReply: string | null;
  id: string;
}

const quality = (reply: string) => ({
  passed: !reply.includes("unsafe"),
  reply,
});

function verifier(outputs: TestVerification[]) {
  const inputs: string[] = [];
  return {
    inputs,
    verify: async (reply: string) => {
      inputs.push(reply);
      const output = outputs.shift();
      assert.ok(output, "unexpected verifier call");
      return output;
    },
  };
}

test("applies a second verifier correction and independently verifies it", async () => {
  const controlled = verifier([
    { id: "draft", approved: false, correctedReply: "correction one" },
    { id: "first-correction", approved: false, correctedReply: "correction two" },
    { id: "second-correction", approved: true, correctedReply: null },
  ]);

  const result = await runFinalResponseGate({
    draftReply: "draft",
    cleanReply: (value) => value.trim(),
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(MAX_FINAL_RESPONSE_CORRECTIONS, 2);
  assert.equal(result.reply, "correction two");
  assert.equal(result.correctionsApplied, 2);
  assert.equal(result.finalVerification.id, "second-correction");
  assert.deepEqual(controlled.inputs, ["draft", "correction one", "correction two"]);
});

test("fails closed without adopting an unverified third correction", async () => {
  const controlled = verifier([
    { id: "draft", approved: false, correctedReply: "correction one" },
    { id: "first-correction", approved: false, correctedReply: "correction two" },
    { id: "second-correction", approved: false, correctedReply: "unverified correction three" },
  ]);

  const result = await runFinalResponseGate({
    draftReply: "draft",
    cleanReply: (value) => value,
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(result.reply, "correction two");
  assert.equal(result.finalVerification.approved, false);
  assert.equal(result.verificationAttempts.length, 3);
  assert.ok(!controlled.inputs.includes("unverified correction three"));
});

test("never substitutes a model correction for a forced emergency reply", async () => {
  const controlled = verifier([
    { id: "draft", approved: false, correctedReply: "model correction" },
    { id: "emergency", approved: false, correctedReply: "another model correction" },
  ]);

  const result = await runFinalResponseGate({
    draftReply: "draft",
    forcedReply: "deterministic emergency reply",
    cleanReply: (value) => value,
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(result.reply, "deterministic emergency reply");
  assert.equal(result.correctionsApplied, 0);
  assert.deepEqual(controlled.inputs, ["draft", "deterministic emergency reply"]);
});

test("reuses a successful verification when the exact draft is unchanged", async () => {
  const controlled = verifier([
    { id: "draft", approved: true, correctedReply: null },
  ]);

  const result = await runFinalResponseGate({
    draftReply: " draft ",
    cleanReply: (value) => value.trim(),
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(result.reply, "draft");
  assert.equal(result.correctionsApplied, 0);
  assert.equal(result.verificationAttempts.length, 1);
});

test("adopts one fully certified final-writer rewrite without paying for a duplicate verification", async () => {
  const controlled = verifier([
    {
      id: "certified-rewrite",
      approved: true,
      correctedReply: "warm, natural and fully certified reply",
    },
  ]);

  const result = await runFinalResponseGate({
    draftReply: "cold procedural draft",
    cleanReply: (value) => value.trim(),
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(result.reply, "warm, natural and fully certified reply");
  assert.equal(result.correctionsApplied, 1);
  assert.equal(result.finalVerification.id, "certified-rewrite");
  assert.equal(result.finalVerification.approved, true);
  assert.deepEqual(controlled.inputs, ["cold procedural draft"]);
});

test("a forced safety reply is not replaced even when a verifier approves different wording", async () => {
  const controlled = verifier([
    { id: "draft", approved: false, correctedReply: "model correction" },
    {
      id: "forced-check",
      approved: true,
      correctedReply: "different model-authored emergency wording",
    },
  ]);

  const result = await runFinalResponseGate({
    draftReply: "draft",
    forcedReply: "deterministic emergency reply",
    cleanReply: (value) => value,
    assessQuality: quality,
    verify: controlled.verify,
  });

  assert.equal(result.reply, "deterministic emergency reply");
  assert.equal(result.finalVerification.approved, false);
  assert.equal(result.correctionsApplied, 0);
});
