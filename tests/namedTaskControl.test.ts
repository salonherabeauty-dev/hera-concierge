import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  returnToAiBlocker,
  validateTaskTransition,
  type TaskControlRecord,
} from "../src/command-centre/operationPolicy.js";

const bookingTask: TaskControlRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  taskType: "booking_action",
  scope: "task_only",
  status: "accepted",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  version: 2,
};

test("a confirmed booking requires explicit human verification", () => {
  assert.match(
    validateTaskTransition({
      task: bookingTask,
      toStatus: "resolved",
      note: "Created in Timely",
      resolution: { outcome: "appointment_confirmed" },
    }) ?? "",
    /human receptionist/i,
  );

  assert.equal(
    validateTaskTransition({
      task: bookingTask,
      toStatus: "resolved",
      note: "Created and verified in Timely for the agreed time.",
      resolution: {
        outcome: "appointment_confirmed",
        confirmedByHuman: true,
        bookingReference: "TIMELY-123",
      },
    }),
    null,
  );
});

test("booking outcomes map only to compatible task states", () => {
  assert.equal(
    validateTaskTransition({
      task: bookingTask,
      toStatus: "waiting_client",
      note: "Offered 3 pm and awaiting the client.",
      resolution: { outcome: "alternative_offered" },
    }),
    null,
  );

  assert.match(
    validateTaskTransition({
      task: bookingTask,
      toStatus: "resolved",
      note: "Alternative offered.",
      resolution: { outcome: "alternative_offered" },
    }) ?? "",
    /final booking outcome/i,
  );
});

test("an accepted human task blocks return to AI until it is resolved", () => {
  assert.match(returnToAiBlocker([bookingTask]) ?? "", /resolve or cancel/i);
  assert.equal(
    returnToAiBlocker([
      {
        ...bookingTask,
        status: "assigned",
        ownerUserId: null,
      },
    ]),
    null,
  );
  assert.match(
    returnToAiBlocker([
      {
        ...bookingTask,
        scope: "full_takeover",
        status: "assigned",
        ownerUserId: null,
      },
    ]) ?? "",
    /full-takeover or emergency/i,
  );
});

test("protected Preview provisions a real foreign-key-safe named operator", async () => {
  const auth = await readFile("src/command-centre/auth.ts", "utf8");
  const owner = await readFile("src/command-centre/previewOwner.ts", "utf8");
  assert.match(auth, /staff: await ensurePreviewOwner\(\)/);
  assert.doesNotMatch(auth, /00000000-0000-4000-8000-000000000001/);
  assert.match(owner, /auth\.admin\.createUser/);
  assert.match(owner, /ai_staff_profiles/);
  assert.match(owner, /Neo Chin Chuan/);
  assert.match(owner, /canSendWhatsAppMessages: false/);
});

test("Preview permits self-acceptance but blocks arbitrary assignment", async () => {
  const taskAction = await readFile("api/command-centre/task-action.ts", "utf8");
  assert.doesNotMatch(taskAction, /preview_read_only/);
  assert.match(taskAction, /preview_assignment_blocked/);
  assert.match(taskAction, /validateTaskTransition/);
  assert.match(taskAction, /repository\.acceptTask/);
});

test("deliberate return to AI is guarded by open human work", async () => {
  const conversation = await readFile("api/command-centre/conversation.ts", "utf8");
  assert.match(conversation, /returnToAiBlocker/);
  assert.match(conversation, /open_human_action_blocks_ai_return/);
  assert.doesNotMatch(conversation, /preview_read_only/);
});

test("the protected Preview UI exposes outcomes without a WhatsApp send action", async () => {
  const index = await readFile("public/command-centre/index.html", "utf8");
  const script = await readFile("public/command-centre/preview-operator.js", "utf8");
  assert.match(index, /preview-operator\.js/);
  assert.match(index, /preview-operator\.css/);
  assert.match(script, /appointment_confirmed/);
  assert.match(script, /alternative_offered/);
  assert.match(script, /test_completed/);
  assert.match(script, /return_to_ai/);
  assert.doesNotMatch(script, /sendText|D360-API-KEY|\/messages\b/);
});
