from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = "src/policy/handoff.ts"
text = read(path)
text = text.replace(
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.0.1";',
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.0.2";',
    1,
)

old_task_type = '''function taskTypeFor(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  proposal: AgentHandoffProposal;
}): HandoffTaskType | null {
  if (input.policy.risk === "black") return "medical_safety";
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) return "arrival_issue";
  if (input.decision.intent === "medical_safety") return "medical_safety";
  if (input.decision.intent === "appointment_change") return "appointment_change";
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  if (input.decision.intent === "booking" || input.decision.intent === "availability") {
    return "booking_action";
  }
  return input.proposal.required ? input.proposal.taskType ?? "other" : null;
}'''
new_task_type = '''function taskTypeFor(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  proposal: AgentHandoffProposal;
}): HandoffTaskType | null {
  // The highest-consequence intent must determine the task. An arrival phrase
  // or a request for a person must never downgrade a safety, refund, privacy or
  // complaint case into a generic queue.
  if (input.policy.risk === "black" || input.decision.intent === "medical_safety") {
    return "medical_safety";
  }
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "complaint") return "complaint_review";
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) return "arrival_issue";
  if (input.decision.intent === "appointment_change") return "appointment_change";
  if (input.decision.intent === "booking" || input.decision.intent === "availability") {
    return "booking_action";
  }
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }
  return input.proposal.required ? input.proposal.taskType ?? "other" : null;
}'''
text = replace_once(text, old_task_type, new_task_type, "replace task precedence")

text = replace_once(
    text,
    '''  const proposal = defaultProposal(input.decision);
  const facts = normalizedFacts(proposal.collectedFacts);
  const taskType = taskTypeFor({''',
    '''  const proposal = defaultProposal(input.decision);
  const facts = normalizedFacts(proposal.collectedFacts);
  const requestedHuman = HUMAN_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const taskType = taskTypeFor({''',
    "capture explicit human request",
)

text = replace_once(
    text,
    '''  const requiredScope =
    input.policy.risk === "black" ? "emergency" : scopeFor(taskType);''',
    '''  const requiredScope =
    input.policy.risk === "black"
      ? "emergency"
      : requestedHuman
        ? "full_takeover"
        : scopeFor(taskType);''',
    "enforce explicit takeover scope",
)

text = replace_once(
    text,
    '''  const managerExplicitlyRequested = MANAGER_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const assignedRole =
    taskType === "client_requested_human" && managerExplicitlyRequested
      ? "salon_manager"
      : assignedRoleFor(taskType);''',
    '''  const managerExplicitlyRequested = MANAGER_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const baseAssignedRole = assignedRoleFor(taskType);
  const assignedRole =
    managerExplicitlyRequested && baseAssignedRole === "receptionist"
      ? "salon_manager"
      : baseAssignedRole;''',
    "preserve specialised authority",
)

text = replace_once(
    text,
    '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : defaultAcknowledgement(taskType, facts);''',
    '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : requestedHuman
        ? defaultAcknowledgement("client_requested_human", facts)
        : defaultAcknowledgement(taskType, facts);''',
    "acknowledge explicit human request",
)
write(path, text)

path = "tests/automaticHandoff.test.ts"
text = read(path)
text = text.replace(
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.0.1");',
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.0.2");',
    1,
)
insert_before = '''test("black-risk safety cases create an emergency handoff without replacing safety guidance", () => {'''
new_tests = '''test("medical safety outranks an arrival phrase", () => {
  const result = assessHumanHandoff({
    message: "I am at the salon and my scalp is burning badly. Please get a manager.",
    conversationId: "conversation-medical-arrival",
    sourceMessageId: "message-medical-arrival",
    policy: policy({ risk: "red", requiresIncident: true }),
    decision: decision({
      intent: "medical_safety",
      risk: "red",
      handoff: {
        required: true,
        taskType: "medical_safety",
        scope: "full_takeover",
        priority: "urgent",
        assignedRole: "technical_lead",
        assignedOutlet: "Tanglin Mall",
        summary: "Scalp burning at the salon.",
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          outlet: "Tanglin Mall",
          symptoms: "Scalp burning badly",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.taskType, "medical_safety");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.assignedRole, "technical_lead");
});

test("a manager request preserves the underlying complaint task", () => {
  const result = assessHumanHandoff({
    message: "I am very unhappy and need to speak to the manager.",
    conversationId: "conversation-complaint-manager",
    sourceMessageId: "message-complaint-manager",
    policy: policy({ risk: "amber", requiresIncident: true }),
    decision: decision({
      intent: "complaint",
      risk: "amber",
      handoff: {
        required: true,
        taskType: "complaint_review",
        scope: "full_takeover",
        priority: "high",
        assignedRole: "salon_manager",
        assignedOutlet: null,
        summary: "Client complaint and manager request.",
        requestedAction: null,
        collectedFacts: { ...emptyFacts },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.taskType, "complaint_review");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.assignedRole, "salon_manager");
});

test("a human request on a complete booking keeps the booking action and pauses AI", () => {
  const result = assessHumanHandoff({
    message:
      "Please let me speak to the manager about booking Irene at Tanglin Mall this Friday at 2 pm for root colour.",
    conversationId: "conversation-booking-manager",
    sourceMessageId: "message-booking-manager",
    policy: policy(),
    decision: decision({
      intent: "booking",
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: "Complete booking request.",
        requestedAction: null,
        collectedFacts: {
          ...emptyFacts,
          service: "root colour",
          stylist: "Irene",
          outlet: "Tanglin Mall",
          date: "this Friday",
          time: "2 pm",
        },
        missingFacts: [],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.taskType, "booking_action");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.assignedRole, "salon_manager");
  assert.match(result.clientReplyOverride ?? "", /team member/i);
});

'''
text = replace_once(text, insert_before, new_tests + insert_before, "add precedence tests")
write(path, text)

path = "tests/automaticHandoffWorkerContract.test.ts"
text = read(path)
text = text.replace(
    'assert.match(worker, /hera-human-handoff-1\\.0\\.1/);',
    'assert.match(worker, /hera-human-handoff-1\\.0\\.2/);',
    1,
)
write(path, text)

(ROOT / "scripts/refine-handoff-precedence.py").unlink(missing_ok=True)
(ROOT / ".github/workflows/refine-handoff-precedence.yml").unlink(missing_ok=True)
