import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCustomerCareWindow,
  MAX_FREEFORM_REPLY_AGE_MS,
} from "../src/policy/customerCareWindow.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

test("allows a recent inbound message", () => {
  const result = assessCustomerCareWindow("2026-08-22T11:00:00.000Z", NOW);
  assert.deepEqual(result, {
    allowed: true,
    reason: "within_window",
    ageMs: 60 * 60 * 1000,
  });
});

test("allows the conservative boundary but blocks one millisecond beyond it", () => {
  const boundary = new Date(NOW - MAX_FREEFORM_REPLY_AGE_MS).toISOString();
  assert.equal(assessCustomerCareWindow(boundary, NOW).allowed, true);

  const expired = new Date(NOW - MAX_FREEFORM_REPLY_AGE_MS - 1).toISOString();
  assert.deepEqual(assessCustomerCareWindow(expired, NOW), {
    allowed: false,
    reason: "expired",
    ageMs: MAX_FREEFORM_REPLY_AGE_MS + 1,
  });
});

test("fails closed for missing, malformed and implausibly future timestamps", () => {
  assert.equal(assessCustomerCareWindow(null, NOW).reason, "missing_timestamp");
  assert.equal(assessCustomerCareWindow("not-a-date", NOW).reason, "invalid_timestamp");
  assert.equal(
    assessCustomerCareWindow("2026-08-22T12:06:00.000Z", NOW).reason,
    "future_timestamp",
  );
});

test("tolerates small provider clock skew", () => {
  const result = assessCustomerCareWindow("2026-08-22T12:04:00.000Z", NOW);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "within_window");
});
