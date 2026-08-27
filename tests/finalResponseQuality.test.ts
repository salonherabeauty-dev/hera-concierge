import assert from "node:assert/strict";
import test from "node:test";
import { assessFinalResponseQuality } from "../src/policy/finalResponseQuality.js";
import { URGENT_SAFETY_REPLY } from "../src/policy/risk.js";
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

test("allows an incomplete booking clarification without inventing a handoff", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "I would like a curly haircut next week.",
    reply: "Certainly. Which Hera outlet would you prefer, and what date and time range would suit you best?",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: handoff({
      createTask: false,
      taskType: "booking_action",
      scope: "task_only",
      priority: "normal",
      assignedRole: "receptionist",
      missingFacts: ["outlet", "date", "time"],
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
      },
    }),
    risk: "green",
  });
  assert.equal(result.passed, true);
});

test("blocks any human escalation claim when no durable task exists", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "Please help me with this.",
    reply: "I’ve sent your request to reception, and the team will contact you shortly.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /not durably created/i.test(issue)));
});

test("accepts the neutral generic acknowledgement only when a human task exists", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "Please let me speak to a person.",
    reply: "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff({
      createTask: true,
      taskType: "client_requested_human",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "receptionist",
    }),
    risk: "green",
  });
  assert.equal(result.passed, true);
});

test("supports a reviewed Chinese complaint acknowledgement", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "我昨天在 Tanglin Mall 剪了卷发，层次不均，我很不满意，请经理审核。",
    reply: "感谢您说明情况，很抱歉这次卷发剪发的结果让您不满意。我已将您在 Tanglin Mall 的卷发剪发问题交给沙龙经理仔细审核。请在方便时发送清晰照片，经理会评估详情并建议下一步。",
    decision: decision({ intent: "complaint", risk: "amber", language: "Chinese" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "卷发剪发",
        outlet: "Tanglin Mall",
        other: "层次不均",
      },
    }),
    risk: "amber",
  });
  assert.equal(result.passed, true);
});

test("permits an explicit non-diagnosis disclaimer in an emergency reply", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: URGENT_SAFETY_REPLY,
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
  assert.equal(result.passed, true);
});

test("emergency containment requires 995 and an explicit instruction not to wait", () => {
  const emergencyDecision = decision({ intent: "medical_safety", risk: "black" });
  const emergencyPolicy = policy({ risk: "black", requiresIncident: true });
  const emergencyHandoff = handoff({
    createTask: true,
    taskType: "medical_safety",
    scope: "emergency",
    priority: "emergency",
    assignedRole: "technical_lead",
  });
  const without995 = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: "Please stop using the product and seek urgent medical help now. Do not wait for the salon to respond.",
    decision: emergencyDecision,
    policy: emergencyPolicy,
    handoff: emergencyHandoff,
    risk: "black",
  });
  assert.equal(without995.passed, false);
  assert.ok(without995.issues.some((issue) => /995/.test(issue)));

  const withoutDoNotWait = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: "Please call Singapore emergency services on 995 now and stop using the product. Hera’s team will follow up.",
    decision: emergencyDecision,
    policy: emergencyPolicy,
    handoff: emergencyHandoff,
    risk: "black",
  });
  assert.equal(withoutDoNotWait.passed, false);
  assert.ok(withoutDoNotWait.issues.some((issue) => /not to wait/i.test(issue)));
});
