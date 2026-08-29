import assert from "node:assert/strict";
import test from "node:test";
import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "../src/policy/finalResponseQuality.js";

function cancellationInput(reply: string) {
  return {
    clientMessage:
      "Hi am heading to school daughter not feeling well going to pick her up pls cancel",
    reply,
    decision: {
      intent: "appointment_change",
    },
    policy: {},
    handoff: {
      createTask: true,
      taskType: "appointment_change",
      scope: "task_only",
      priority: "urgent",
      assignedRole: "receptionist",
      assignedOutlet: "Tanglin Mall",
      summary: "Cancellation request because the client’s daughter is unwell.",
      requestedAction: "Verify the appointment and confirm the cancellation.",
      collectedFacts: {
        service: "Hair cut and hair colour",
        stylist: "Phoeve",
        outlet: "Tanglin Mall",
        date: "25 Aug 2026",
        time: "10:00 am",
        flexibility: null,
        appointmentReference: null,
        desiredOutcome: "Cancel the appointment",
        symptoms: null,
        photos: null,
        other: "Client is collecting her unwell daughter from school.",
      },
      missingFacts: [],
      clientReplyOverride: reply,
      clientVisibleStatus: reply,
      dedupeKey: "automatic-handoff:appointment_change:test",
      reason: "A live appointment update is required.",
    },
    risk: "amber",
  } as unknown as Parameters<typeof assessFinalResponseQuality>[0];
}

test("quality policy rejects the crude bureaucratic cancellation reply shown to Neo", () => {
  assert.equal(FINAL_RESPONSE_QUALITY_POLICY_VERSION, "hera-final-response-quality-1.4.0");
  const result = assessFinalResponseQuality(
    cancellationInput(
      "Thank you. I’ve passed your appointment-change request to our reception team for verification and confirmation.",
    ),
  );

  assert.equal(result.passed, false);
  assert.ok(
    result.issues.some((issue) => issue.includes("bureaucratic process notice")),
  );
  assert.ok(
    result.issues.some((issue) => issue.includes("personal circumstances")),
  );
});

test("quality policy accepts a warm, specific and truthful Hera cancellation reply", () => {
  const result = assessFinalResponseQuality(
    cancellationInput(
      "Hi Chitra, I’m sorry to hear your daughter isn’t feeling well. Please take care of her. I’ve noted your cancellation request for today, and reception will verify the appointment and confirm once it has been updated. When you’re ready, we’ll be happy to help arrange another time.",
    ),
  );

  assert.equal(result.passed, true, result.issues.join(" | "));
  assert.equal(result.checks.contextualEmpathy, true);
  assert.equal(result.checks.conciseTone, true);
});
