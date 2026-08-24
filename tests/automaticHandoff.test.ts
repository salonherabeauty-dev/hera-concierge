import assert from "node:assert/strict";
import test from "node:test";
import {
  assessHumanHandoff,
  HUMAN_HANDOFF_POLICY_VERSION,
} from "../src/policy/handoff.js";
import type {
  AgentDecision,
  AgentHandoffFacts,
  PolicyAssessment,
} from "../src/types.js";

const emptyFacts: AgentHandoffFacts = {
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

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "Certainly. May I confirm the outlet?",
    intent: "booking",
    risk: "green",
    confidence: 0.98,
    language: "English",
    sources: [],
    factualBasis: ["client_provided_fact"],
    proposedActions: ["ask_clarifying_question"],
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
    rationale: "Automatic handoff test fixture.",
    ...overrides,
  };
}

test("complete booking details create one structured reception handoff", () => {
  const result = assessHumanHandoff({
    message:
      "Please book Irene for a root colour touch-up and toner at Tanglin Mall on Friday 28 August around 2 pm.",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    policy: policy(),
    decision: decision({
      intent: "availability",
      proposedActions: ["create_handoff_task"],
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour touch-up and toner",
          stylist: "Irene",
          outlet: "Tanglin Mall",
          date: "Friday, 28 August",
          time: "around 2 pm",
        },
        missingFacts: [],
        clientAcknowledgement:
          "Thank you. I’ve noted Friday, 28 August at around 2 pm for a root colour touch-up and toner with Irene at Tanglin Mall. Our reception team will now check live availability and confirm the appointment with you.",
      },
    }),
  });

  assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.0.0");
  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "booking_action");
  assert.equal(result.scope, "task_only");
  assert.equal(result.assignedRole, "receptionist");
  assert.equal(result.assignedOutlet, "Tanglin Mall");
  assert.deepEqual(result.missingFacts, []);
  assert.equal(
    result.dedupeKey,
    "automatic-handoff:booking_action:message-1",
  );
  assert.match(result.clientReplyOverride ?? "", /check live availability/i);
  assert.doesNotMatch(result.clientReplyOverride ?? "", /already booked|is confirmed/i);
});

test("incomplete booking waits for the missing outlet instead of creating a task", () => {
  const result = assessHumanHandoff({
    message:
      "I would like Irene for a root colour touch-up and toner on Friday 28 August around 2 pm.",
    conversationId: "conversation-2",
    sourceMessageId: "message-2",
    policy: policy(),
    decision: decision({
      handoff: {
        required: false,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: null,
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour touch-up and toner",
          stylist: "Irene",
          date: "Friday, 28 August",
          time: "around 2 pm",
        },
        missingFacts: ["outlet"],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, false);
  assert.deepEqual(result.missingFacts, ["outlet"]);
  assert.equal(result.dedupeKey, null);
  assert.equal(result.clientReplyOverride, null);
});

test("a stylist is optional when the client has no preference", () => {
  const result = assessHumanHandoff({
    message:
      "Any suitable stylist is fine. Root colour touch-up at Tanglin Mall on Friday 28 August around 2 pm.",
    conversationId: "conversation-3",
    sourceMessageId: "message-3",
    policy: policy(),
    decision: decision({
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour touch-up",
          outlet: "Tanglin Mall",
          date: "Friday, 28 August",
          time: "around 2 pm",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.equal(result.collectedFacts.stylist, null);
});

test("false booking confirmation language is rejected and replaced", () => {
  const result = assessHumanHandoff({
    message:
      "Root colour at Tanglin Mall on Friday 28 August around 2 pm please.",
    conversationId: "conversation-4",
    sourceMessageId: "message-4",
    policy: policy(),
    decision: decision({
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: null,
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour",
          outlet: "Tanglin Mall",
          date: "Friday, 28 August",
          time: "around 2 pm",
        },
        missingFacts: [],
        clientAcknowledgement:
          "Your appointment is confirmed and already booked for 2 pm.",
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.doesNotMatch(result.clientReplyOverride ?? "", /already booked|is confirmed/i);
  assert.match(result.clientReplyOverride ?? "", /reception team/i);
});

test("explicit human requests create a full takeover task even without booking facts", () => {
  const result = assessHumanHandoff({
    message: "Please let me speak to a human receptionist now.",
    conversationId: "conversation-5",
    sourceMessageId: "message-5",
    policy: policy(),
    decision: decision({
      intent: "other",
      handoff: {
        required: true,
        taskType: "client_requested_human",
        scope: "full_takeover",
        priority: "high",
        assignedRole: "receptionist",
        assignedOutlet: null,
        summary: "Client asked for a person.",
        requestedAction: null,
        collectedFacts: { ...emptyFacts },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "client_requested_human");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.priority, "high");
});

test("black-risk safety cases create an emergency handoff without replacing safety guidance", () => {
  const result = assessHumanHandoff({
    message: "I cannot breathe and my face is swelling.",
    conversationId: "conversation-6",
    sourceMessageId: "message-6",
    policy: policy({
      risk: "black",
      requiresManagementNotification: true,
      requiresIncident: true,
    }),
    decision: decision({
      intent: "medical_safety",
      risk: "black",
      handoff: {
        required: true,
        taskType: "medical_safety",
        scope: "emergency",
        priority: "emergency",
        assignedRole: "technical_lead",
        assignedOutlet: null,
        summary: "Urgent safety concern.",
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          symptoms: "Cannot breathe and face swelling",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "medical_safety");
  assert.equal(result.scope, "emergency");
  assert.equal(result.priority, "emergency");
  assert.equal(result.clientReplyOverride, null);
});
