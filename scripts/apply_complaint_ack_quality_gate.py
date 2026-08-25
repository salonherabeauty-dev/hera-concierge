from pathlib import Path

HANDOFF = Path("src/policy/handoff.ts")
TEST = Path("tests/complaintAcknowledgement.test.ts")

text = HANDOFF.read_text(encoding="utf-8")

replacements = [
    (
        'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.2.1";',
        'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.3.0";',
    ),
    (
        '''  if (taskType === "complaint_review") {
    return "Thank you for explaining this. I’ve placed the matter with Hera’s management team for direct review and follow-up.";
  }''',
        '''  if (taskType === "complaint_review") {
    const service = facts.service ? ` regarding your ${facts.service}` : "";
    const outlet = facts.outlet ? ` at ${facts.outlet}` : "";
    const visualConcern = [facts.other, facts.desiredOutcome]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const photoRequest =
      !facts.photos &&
      /\\b(?:uneven|colour|color|cut|layers?|shape|length|fringe|hair|result|finish|breakage|damage)\\b/i.test(
        visualConcern,
      )
        ? " Please share clear photos of the result if convenient; they will help the manager review it carefully."
        : "";
    return `Thank you for explaining this, and I’m sorry this experience has left you unhappy. I’ve placed your concern${service}${outlet} with Hera’s salon manager for a careful review.${photoRequest} The manager will assess the details and advise the appropriate next step after the review.`;
  }''',
    ),
    (
        '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : requestedHuman
        ? defaultAcknowledgement("client_requested_human", facts)
        : taskType === "other"
          ? safeAcknowledgement(proposal.clientAcknowledgement) ??
            defaultAcknowledgement(taskType, facts)
          : defaultAcknowledgement(taskType, facts);''',
        '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : taskType === "complaint_review"
        ? defaultAcknowledgement(taskType, facts)
        : requestedHuman
          ? defaultAcknowledgement("client_requested_human", facts)
          : taskType === "other"
            ? safeAcknowledgement(proposal.clientAcknowledgement) ??
              defaultAcknowledgement(taskType, facts)
            : defaultAcknowledgement(taskType, facts);''',
    ),
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one handoff replacement, found {count}: {old[:80]!r}")
    text = text.replace(old, new)

HANDOFF.write_text(text, encoding="utf-8")

existing_test = Path("tests/automaticHandoff.test.ts")
existing_text = existing_test.read_text(encoding="utf-8")
old_version = 'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.2.1");'
new_version = 'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.3.0");'
if existing_text.count(old_version) != 1:
    raise SystemExit("Expected one existing human handoff policy version assertion")
existing_test.write_text(existing_text.replace(old_version, new_version), encoding="utf-8")

TEST.write_text(
    '''import assert from "node:assert/strict";
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
    risk: "amber",
    canAutoSend: true,
    requiresManagementNotification: true,
    requiresIncident: true,
    blockedActions: [],
    securityFlags: [],
    replyOverride: null,
    ...overrides,
  };
}

function complaintDecision(): AgentDecision {
  return {
    reply: "I’m sorry to hear this. A manager can review it.",
    intent: "complaint",
    risk: "amber",
    confidence: 0.98,
    language: "English",
    sources: [],
    factualBasis: ["client_provided_fact"],
    proposedActions: ["create_handoff_task"],
    requiresManagementNotification: true,
    handoff: {
      required: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      summary: null,
      requestedAction: null,
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
        outlet: "Tanglin Mall",
        date: "yesterday",
        desiredOutcome:
          "Salon manager to review the uneven layers and explain what can be done.",
        other: "Client reports uneven layers and dissatisfaction with the result.",
      },
      missingFacts: ["stylist", "time", "appointmentReference", "photos"],
      clientAcknowledgement: null,
    },
    rationale: "The client raised a service concern and explicitly requested the salon manager.",
  };
}

test("an explicit manager request preserves a specific empathetic complaint acknowledgement", () => {
  const result = assessHumanHandoff({
    message:
      "Hi, I had a curly haircut at Tanglin Mall yesterday and the layers look uneven. I’m unhappy with the result and would like the salon manager to review it. Please tell me what can be done.",
    conversationId: "conversation-controlled-complaint",
    sourceMessageId: "message-controlled-complaint",
    policy: policy(),
    decision: complaintDecision(),
  });

  assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.3.0");
  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "complaint_review");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.priority, "high");
  assert.equal(result.assignedRole, "salon_manager");
  assert.equal(result.assignedOutlet, "Tanglin Mall");

  const reply = result.clientReplyOverride ?? "";
  assert.match(reply, /sorry this experience has left you unhappy/i);
  assert.match(reply, /curly haircut/i);
  assert.match(reply, /Tanglin Mall/i);
  assert.match(reply, /salon manager/i);
  assert.match(reply, /clear photos of the result/i);
  assert.match(reply, /appropriate next step after the review/i);
  assert.doesNotMatch(reply, /Certainly|direct assistance|staff member will continue/i);
  assert.doesNotMatch(
    reply,
    /our fault|we caused|we damaged|refund|compensation|complimentary|free redo|guaranteed/i,
  );
  assert.equal(result.clientVisibleStatus, reply);
});

test("a generic request for a human still receives the neutral direct-assistance acknowledgement", () => {
  const result = assessHumanHandoff({
    message: "Please let me speak to a human receptionist now.",
    conversationId: "conversation-generic-human",
    sourceMessageId: "message-generic-human",
    policy: policy({
      risk: "green",
      requiresIncident: false,
      requiresManagementNotification: false,
    }),
    decision: {
      ...complaintDecision(),
      intent: "other",
      risk: "green",
      requiresManagementNotification: false,
      handoff: {
        required: true,
        taskType: "client_requested_human",
        scope: "full_takeover",
        priority: "high",
        assignedRole: "receptionist",
        assignedOutlet: null,
        summary: null,
        requestedAction: null,
        collectedFacts: { ...emptyFacts },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    },
  });

  assert.equal(result.taskType, "client_requested_human");
  assert.match(result.clientReplyOverride ?? "", /direct assistance|staff member/i);
});
''',
    encoding="utf-8",
)

print("Applied complaint acknowledgement quality gate")
