import assert from "node:assert/strict";
import test from "node:test";
import { assessFinalResponseQuality } from "../src/policy/finalResponseQuality.js";
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

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
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

function handoff(overrides: Partial<HumanHandoffAssessment> = {}): HumanHandoffAssessment {
  return {
    createTask: false,
    taskType: null,
    scope: null,
    priority: null,
    assignedRole: null,
    assignedOutlet: null,
    summary: null,
    requestedAction: null,
    collectedFacts: { ...emptyFacts },
    missingFacts: [],
    clientReplyOverride: null,
    clientVisibleStatus: null,
    dedupeKey: null,
    reason: "fixture",
    ...overrides,
  };
}

test("blocks the crude generic manager handoff that escaped the earlier verifier", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "My curly haircut is uneven and I want the salon manager to review it.",
    reply: "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.",
    decision: decision({ intent: "complaint", risk: "amber" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    risk: "amber",
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
        outlet: "Tanglin Mall",
        other: "uneven layers",
      },
    }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /crude generic/i.test(issue)));
  assert.ok(result.issues.some((issue) => /experience or concern/i.test(issue)));
});

test("passes a specific, empathetic and non-liability complaint acknowledgement", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "My curly haircut is uneven and I want the salon manager to review it.",
    reply: "Thank you for explaining this, and I’m sorry this experience has left you unhappy. I’ve placed your concern regarding your curly haircut at Tanglin Mall with Hera’s salon manager for a careful review. Please share clear photos of the result if convenient; they will help the manager review it carefully. The manager will assess the details and advise the appropriate next step after the review.",
    decision: decision({ intent: "complaint", risk: "amber" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    risk: "amber",
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
        outlet: "Tanglin Mall",
        other: "uneven layers",
      },
    }),
  });
  assert.equal(result.passed, true);
});

test("blocks false booking completion and accepts live-availability ownership", () => {
  const booking = handoff({
    createTask: true,
    taskType: "booking_action",
    scope: "task_only",
    priority: "normal",
    assignedRole: "receptionist",
    assignedOutlet: "Tanglin Mall",
    collectedFacts: {
      ...emptyFacts,
      service: "root colour",
      outlet: "Tanglin Mall",
      date: "Friday",
      time: "2 pm",
    },
  });
  const bad = assessFinalResponseQuality({
    clientMessage: "Root colour at Tanglin Mall Friday 2 pm.",
    reply: "Your booking is confirmed at Tanglin Mall for root colour on Friday at 2 pm.",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: booking,
    risk: "green",
  });
  assert.equal(bad.passed, false);
  const good = assessFinalResponseQuality({
    clientMessage: "Root colour at Tanglin Mall Friday 2 pm.",
    reply: "Thank you. I’ve noted root colour at Tanglin Mall on Friday at 2 pm. Our reception team will check live availability and confirm the actual outcome with you.",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: booking,
    risk: "green",
  });
  assert.equal(good.passed, true);
});

test("blocks internal queue language and unverified privacy completion", () => {
  const internal = assessFinalResponseQuality({
    clientMessage: "I am at the salon.",
    reply: "I’ve placed this in our internal priority queue for the outlet workflow.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff({
      createTask: true,
      taskType: "arrival_issue",
      scope: "task_only",
      priority: "urgent",
      assignedRole: "salon_manager",
    }),
    risk: "green",
  });
  assert.equal(internal.passed, false);
  const privacy = assessFinalResponseQuality({
    clientMessage: "Delete my data.",
    reply: "Your personal data has been deleted.",
    decision: decision({ intent: "privacy_legal", risk: "red" }),
    policy: policy({ risk: "red" }),
    handoff: handoff({
      createTask: true,
      taskType: "privacy_legal",
      scope: "full_takeover",
      priority: "urgent",
      assignedRole: "privacy_officer",
    }),
    risk: "red",
  });
  assert.equal(privacy.passed, false);
});

test("requires emergency guidance and allows a direct routine service answer", () => {
  const emergency = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: "A staff member will contact you as soon as available.",
    decision: decision({ intent: "medical_safety", risk: "black" }),
    policy: policy({ risk: "black", requiresIncident: true }),
    handoff: handoff({
      createTask: true,
      taskType: "medical_safety",
      scope: "emergency",
      priority: "emergency",
      assignedRole: "technical_lead",
    }),
    risk: "black",
  });
  assert.equal(emergency.passed, false);
  const routine = assessFinalResponseQuality({
    clientMessage: "Do you offer curly haircuts at Tanglin Mall?",
    reply: "Yes. Hera’s Tanglin Mall atelier offers specialist curly haircuts for waves, curls and coils. Share a current hair photo and the shape you would like us to address, and we’ll guide you to the most suitable next step.",
    decision: decision({ intent: "service_advice" }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(routine.passed, true);
});
