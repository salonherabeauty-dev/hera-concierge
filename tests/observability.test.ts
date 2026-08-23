import assert from "node:assert/strict";
import test from "node:test";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../src/observability/log.js";

test("safe error fields never disclose an error message or provider details", () => {
  const error = Object.assign(
    new Error("secret-token client-message provider-payload"),
    { status: 503, details: { accessToken: "secret-token" } },
  );

  assert.deepEqual(safeErrorFields(error), {
    errorName: "Error",
    errorStatus: 503,
  });
});

test("operational logs contain only the explicitly supplied safe metadata", () => {
  const records: string[] = [];
  const original = console.info;
  console.info = (value?: unknown) => records.push(String(value));
  try {
    logOperationalEvent("info", "test\noperational-event", {
      correlationId: "request-1",
      durationMs: 12,
    });
  } finally {
    console.info = original;
  }

  assert.equal(records.length, 1);
  const record = JSON.parse(records[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.event, "test operational-event");
  assert.equal(record.correlationId, "request-1");
  assert.equal(record.durationMs, 12);
  assert.equal("message" in record, false);
  assert.equal("prompt" in record, false);
  assert.equal("credential" in record, false);
});
