import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTION_AUTHORITY_POLICY_VERSION,
  AGENT_ACTION_AUTHORITY,
  assessActionAuthority,
} from "../src/policy/actionAuthority.js";
import type { HumanHandoffAssessment } from "../src/policy/handoff.js";
import {
  AGENT_ACTIONS,
  type AgentDecision,
  type PolicyAssessment,
} from "../src/types.js";

const registryUrl = new URL(
  "../governance/action-authority-registry.json",
  import.meta.url,
);

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
    reply: "Yes, Hera offers this service.",
    intent: "service_advice",
    risk: "green",
    confidence: 0.95,
    language: "English",
    sources: [{ id: "hera-operator-v3:service", title: "Approved service" }],
    factualBasis: ["approved_hera_source"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    handoff: undefined,
    rationale: "Grounded answer",
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
  overrides: Partial<HumanHandoffAssessment> = {},
): HumanHandoffAssessment {
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
    reason: "No handoff",
    ...overrides,
  };
}

const completeManagerHandoff = handoff({
  createTask: true,
  taskType: "complaint_review",
  scope: "full_takeover",
  priority: "high",
  assignedRole: "salon_manager",
  assignedOutlet: "Tanglin Mall",
  summary: "Review the client's service concern.",
  requestedAction: "Review the result and advise the appropriate next step.",
  clientVisibleStatus: "The salon manager will review this concern.",
  dedupeKey: "complaint:message-1",
});

test("every model-proposed agent action has an explicit authority class", () => {
  assert.deepEqual(
    Object.keys(AGENT_ACTION_AUTHORITY).sort(),
    [...AGENT_ACTIONS].sort(),
  );
  assert.match(ACTION_AUTHORITY_POLICY_VERSION, /^hera-action-authority-/);
});

test("a grounded read-only answer passes with current-run evidence", () => {
  const assessment = assessActionAuthority({
    reply: "Yes, Hera offers specialist curly haircuts at Tanglin Mall.",
    decision: decision(),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(assessment.passed, true);
  assert.deepEqual(assessment.issues, []);
});

test("approved links, current-client records and calculations require their exact tool evidence", () => {
  const missingLink = assessActionAuthority({
    reply: "You can use Hera's booking page.",
    decision: decision({
      proposedActions: ["share_booking_link"],
      factualBasis: ["no_factual_claim"],
      sources: [],
    }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.ok(
    missingLink.issues.includes(
      "booking_link_missing_approved_digital_tool_evidence",
    ),
  );

  const missingRecord = assessActionAuthority({
    reply: "Your appointment record shows a haircut.",
    decision: decision({
      factualBasis: ["current_client_record"],
      sources: [],
    }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.ok(
    missingRecord.issues.includes(
      "current_client_record_claim_missing_read_evidence",
    ),
  );

  const missingCalculation = assessActionAuthority({
    reply: "The total after GST is $109.",
    decision: decision({
      factualBasis: ["deterministic_calculation"],
      sources: [],
    }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.ok(
    missingCalculation.issues.includes(
      "deterministic_calculation_claim_missing_tool_evidence",
    ),
  );
});

test("human ownership language requires a complete durable task", () => {
  const missingTask = assessActionAuthority({
    reply: "The salon manager will review this and contact you.",
    decision: decision({
      intent: "complaint",
      proposedActions: ["create_handoff_task"],
    }),
    policy: policy({ risk: "amber" }),
    handoff: handoff(),
    risk: "amber",
  });
  assert.ok(
    missingTask.issues.includes(
      "human_handoff_action_missing_complete_durable_task_contract",
    ),
  );
  assert.ok(
    missingTask.issues.includes("human_ownership_claim_without_durable_task"),
  );

  const durableTask = assessActionAuthority({
    reply:
      "I have placed your concern with the Tanglin Mall salon manager, who will review the result and advise the appropriate next step.",
    decision: decision({
      intent: "complaint",
      proposedActions: ["create_handoff_task"],
    }),
    policy: policy({ risk: "amber" }),
    handoff: completeManagerHandoff,
    risk: "amber",
  });
  assert.equal(durableTask.passed, true);
});

test("external writes, financial decisions, consent completion, liability and diagnosis fail closed", () => {
  const prohibitedReplies = [
    "Your appointment has been confirmed for tomorrow at 2 pm.",
    "We have an available slot at 2 pm today.",
    "Your refund has been approved and processed.",
    "You will receive a complimentary refinement.",
    "Your photo consent has been withdrawn.",
    "Hera is at fault for the result.",
    "This is a chemical burn.",
  ];

  for (const reply of prohibitedReplies) {
    const assessment = assessActionAuthority({
      reply,
      decision: decision({ factualBasis: ["no_factual_claim"], sources: [] }),
      policy: policy(),
      handoff: handoff(),
      risk: "green",
    });
    assert.equal(assessment.passed, false, reply);
  }
});

test("approved conditional policy explanation is not misclassified as an authorised outcome", () => {
  const assessment = assessActionAuthority({
    reply:
      "An eligible concern may receive a complimentary refinement only when the salon manager confirms that it relates to the original service and can be corrected safely.",
    decision: decision(),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(assessment.passed, true);
});

test("the machine-readable registry keeps write and financial authority outside AI", async () => {
  const registry = JSON.parse(await readFile(registryUrl, "utf8")) as {
    actions: Array<{
      id: string;
      authorityClass: string;
      runtimeStatus: string;
      requiredEvidence: string[];
      auditRequirement: string;
    }>;
    releaseDeclaration: {
      liveProductionApproved: boolean;
      shadowModeRequired: boolean;
    };
  };
  const actions = new Map(registry.actions.map((item) => [item.id, item]));

  for (const id of [
    "create_booking",
    "reschedule_booking",
    "cancel_booking",
    "confirm_live_availability",
    "approve_refund_voucher_or_compensation",
    "complete_privacy_deletion_or_legal_determination",
    "admit_liability",
    "diagnose_medical_condition_or_chemical_damage",
  ]) {
    const item = actions.get(id);
    assert.ok(item, id);
    assert.doesNotMatch(item.authorityClass, /^ai_authorised/);
    assert.ok(item.requiredEvidence.length > 0);
    assert.ok(item.auditRequirement.length > 0);
  }

  assert.equal(registry.releaseDeclaration.liveProductionApproved, false);
  assert.equal(registry.releaseDeclaration.shadowModeRequired, true);
});
