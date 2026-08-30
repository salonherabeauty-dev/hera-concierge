import assert from "node:assert/strict";
import test from "node:test";
import { assessFinalResponseQuality } from "../src/policy/finalResponseQuality.js";
import { assessFinalResponseQuality as assessLegacyFinalResponseQuality } from "../src/policy/finalResponseQualityCore.js";
import type { HumanHandoffAssessment } from "../src/policy/handoff.js";
import type { AgentDecision, PolicyAssessment } from "../src/types.js";

const emptyFacts = {
  service: null,
  stylist: null,
  outlet: null,
  date: null,
  time: null,
  flexibility: null,
  appointmentReference: null,
  desiredOutcome: null,
  symptoms: null,
  photos: null,
  other: null,
};

function decision(overrides: Partial<AgentDecision>): AgentDecision {
  return {
    reply: "Thank you.",
    intent: "service_advice",
    risk: "green",
    confidence: 0.9,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    handoff: {
      required: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: { ...emptyFacts },
      missingFacts: [],
      clientAcknowledgement: null,
    },
    rationale: "fixture",
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyAssessment> = {}): PolicyAssessment {
  return {
    risk: "green",
    canAutoSend: true,
    requiresManagementNotification: false,
    requiresIncident: false,
    blockedActions: [],
    securityFlags: [],
    replyOverride: null,
    ...overrides,
  };
}

function handoff(
  overrides: Partial<HumanHandoffAssessment>,
): HumanHandoffAssessment {
  return {
    createTask: true,
    taskType: null,
    scope: "task_only",
    priority: "high",
    assignedRole: "receptionist",
    assignedOutlet: "Tanglin Mall",
    summary: "fixture",
    requestedAction: "fixture",
    collectedFacts: { ...emptyFacts },
    missingFacts: [],
    clientReplyOverride: null,
    clientVisibleStatus: null,
    dedupeKey: "fixture",
    reason: "fixture",
    ...overrides,
  };
}

test("Juliane's natural first-person appointment ownership passes without bureaucratic keywords", () => {
  const input = {
    clientMessage:
      "Good morning. Could I please change the appointment to next weekend when Aleksandra is back from her break?",
    reply:
      "Good morning. Of course — I can help move this morning’s appointment to next weekend with Aleksandra. Would Saturday 5 or Sunday 6 September suit you better, and what time range would be most convenient? I’ll check the appointment details and her availability, then update you here before making any change.",
    decision: decision({ intent: "appointment_change" }),
    policy: policy(),
    handoff: handoff({
      taskType: "appointment_change",
      collectedFacts: {
        ...emptyFacts,
        service: "Kid’s boy Haircut (below 10yrs)",
        stylist: "Aleksandra",
        outlet: "Tanglin Mall",
        date: "Next weekend",
      },
      missingFacts: ["date", "time"],
    }),
    risk: "green" as const,
  };

  const legacy = assessLegacyFinalResponseQuality(input);
  const aligned = assessFinalResponseQuality(input);
  assert.equal(legacy.passed, false);
  assert.ok(legacy.issues.some((issue) => /clear human ownership/i.test(issue)));
  assert.ok(legacy.issues.some((issue) => /outcome will be confirmed/i.test(issue)));
  assert.equal(aligned.passed, true);
  assert.deepEqual(aligned.issues, []);
  assert.equal(aligned.checks.ownership, true);
});

test("Neo's consolidated legal reply passes when direct ownership routes a durable review", () => {
  const input = {
    clientMessage: "[Unsupported WhatsApp message received]",
    reply:
      "Thank you. I’m sorry—the two messages sent after the letter did not come through in a readable format, and the text visible here ends part-way through paragraph 19(a). I recognise the seriousness of the matters raised. I’m bringing the readable correspondence, including the evidence-preservation request, to Hera’s senior management as a priority. Please resend only the missing material as a PDF, pasted text or clear images; there is no need to repeat anything already visible. I’ll confirm receipt here and keep you updated on the next step.",
    decision: decision({ intent: "privacy_legal", risk: "red" }),
    policy: policy({
      risk: "red",
      requiresIncident: true,
      requiresManagementNotification: true,
    }),
    handoff: handoff({
      taskType: "privacy_legal",
      scope: "full_takeover",
      priority: "urgent",
      assignedRole: "privacy_officer",
      collectedFacts: {
        ...emptyFacts,
        outlet: "Tanglin Mall",
        appointmentReference: "LQ/CIV/2026/0417",
        desiredOutcome: "Legal response and evidence preservation",
      },
    }),
    risk: "red" as const,
  };

  const legacy = assessLegacyFinalResponseQuality(input);
  const aligned = assessFinalResponseQuality(input);
  assert.equal(legacy.passed, false);
  assert.ok(legacy.issues.some((issue) => /authorised review/i.test(issue)));
  assert.equal(aligned.passed, true);
  assert.deepEqual(aligned.issues, []);
  assert.equal(aligned.checks.ownership, true);
});

test("alignment does not weaken booking completion, legal review or complaint-manager safeguards", () => {
  const appointment = assessFinalResponseQuality({
    clientMessage: "Please move my appointment.",
    reply: "Your booking is confirmed for next weekend.",
    decision: decision({ intent: "appointment_change" }),
    policy: policy(),
    handoff: handoff({ taskType: "appointment_change" }),
    risk: "green",
  });
  assert.equal(appointment.passed, false);
  assert.ok(appointment.issues.some((issue) => /booking completion/i.test(issue)));

  const vagueLegal = assessFinalResponseQuality({
    clientMessage: "This is a legal request.",
    reply: "I will handle this and keep you updated.",
    decision: decision({ intent: "privacy_legal", risk: "red" }),
    policy: policy({ risk: "red", requiresIncident: true }),
    handoff: handoff({
      taskType: "privacy_legal",
      scope: "full_takeover",
      priority: "urgent",
      assignedRole: "privacy_officer",
    }),
    risk: "red",
  });
  assert.equal(vagueLegal.passed, false);
  assert.ok(vagueLegal.issues.some((issue) => /authorised review/i.test(issue)));

  const unnamedComplaint = assessFinalResponseQuality({
    clientMessage: "I am very unhappy with my balayage.",
    reply:
      "I’m sorry that the balayage has left you unhappy. I’ll review the details and update you here with the next step.",
    decision: decision({ intent: "complaint", risk: "amber" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    handoff: handoff({
      taskType: "complaint_review",
      scope: "full_takeover",
      assignedRole: "salon_manager",
      collectedFacts: {
        ...emptyFacts,
        service: "balayage",
        outlet: "Tanglin Mall",
      },
    }),
    risk: "amber",
  });
  assert.equal(unnamedComplaint.passed, false);
  assert.ok(
    unnamedComplaint.issues.some((issue) => /management ownership/i.test(issue)),
  );
});
