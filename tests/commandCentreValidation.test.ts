import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActionBodySchema,
  createTaskBodySchema,
  taskActionBodySchema,
} from "../src/command-centre/validation.js";

const conversationId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";

test("handoff task input requires a complete durable action package", () => {
  const result = createTaskBodySchema.safeParse({
    conversationId,
    taskType: "booking_action",
    scope: "task_only",
    priority: "normal",
    summary: "Check live availability",
    requestedAction: "Confirm Irene's availability for the requested date and time.",
    collectedFacts: { stylist: "Irene", service: "Root colour and toner" },
    missingFacts: [],
    dedupeKey: "booking:11111111:2026-08-28T14:00",
  });
  assert.equal(result.success, true);

  assert.equal(
    createTaskBodySchema.safeParse({
      conversationId,
      taskType: "booking_action",
      scope: "task_only",
      priority: "normal",
      summary: "",
      requestedAction: "",
      dedupeKey: "",
    }).success,
    false,
  );
});

test("task mutations require optimistic versions and valid transitions", () => {
  assert.equal(
    taskActionBodySchema.safeParse({ action: "accept", taskId, expectedVersion: 3 }).success,
    true,
  );
  assert.equal(
    taskActionBodySchema.safeParse({
      action: "transition",
      taskId,
      expectedVersion: 3,
      toStatus: "resolved",
      resolution: { outcome: "confirmed" },
    }).success,
    true,
  );
  assert.equal(
    taskActionBodySchema.safeParse({
      action: "transition",
      taskId,
      expectedVersion: 0,
      toStatus: "new",
    }).success,
    false,
  );
});

test("conversation controls require explicit reasons", () => {
  assert.equal(
    conversationActionBodySchema.safeParse({
      action: "takeover",
      conversationId,
      reason: "Reception accepted the conversation",
      takeoverUntil: null,
    }).success,
    true,
  );
  assert.equal(
    conversationActionBodySchema.safeParse({
      action: "return_to_ai",
      conversationId,
      reason: "",
    }).success,
    false,
  );
});
