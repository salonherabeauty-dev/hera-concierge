from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


path = "src/policy/handoff.ts"
text = read(path)
text = replace_once(
    text,
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.1.0";',
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.1.1";',
    "bump policy version",
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
  // Highest consequence wins. Arrival wording or a request for a person must
  // never downgrade a safety, privacy, refund or complaint case.
  if (
    input.policy.risk === "black" ||
    input.decision.intent === "medical_safety"
  ) {
    return "medical_safety";
  }
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "complaint") return "complaint_review";
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "arrival_issue";
  }
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

old_missing = '''    if (missingFacts.length > 0) {
      return {
        createTask: false,
        taskType,
        scope: "task_only",
        priority: priorityFor(taskType, input.policy, input.message),
        assignedRole: "receptionist",
        assignedOutlet: facts.outlet,
        summary: null,
        requestedAction: null,
        collectedFacts: facts,
        missingFacts,
        clientReplyOverride: null,
        clientVisibleStatus: null,
        dedupeKey: null,
        reason: `Booking handoff is waiting for: ${missingFacts.join(", ")}.`,
      };
    }'''
new_missing = '''    if (missingFacts.length > 0 && !requestedHuman) {
      return {
        createTask: false,
        taskType,
        scope: "task_only",
        priority: priorityFor(taskType, input.policy, input.message),
        assignedRole: "receptionist",
        assignedOutlet: facts.outlet,
        summary: null,
        requestedAction: null,
        collectedFacts: facts,
        missingFacts,
        clientReplyOverride: null,
        clientVisibleStatus: null,
        dedupeKey: null,
        reason: `Booking handoff is waiting for: ${missingFacts.join(", ")}.`,
      };
    }'''
text = replace_once(text, old_missing, new_missing, "allow explicit-human incomplete booking handoff")

old_authority = '''  const requiredScope =
    input.policy.risk === "black" ? "emergency" : scopeFor(taskType);
  const scope = strongestScope(proposal.scope, requiredScope);
  const requiredPriority =
    input.policy.risk === "black"
      ? "emergency"
      : priorityFor(taskType, input.policy, input.message);
  const priority = strongestPriority(proposal.priority, requiredPriority);
  const managerExplicitlyRequested = MANAGER_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const assignedRole =
    taskType === "client_requested_human" && managerExplicitlyRequested
      ? "salon_manager"
      : taskType === "other" && proposal.assignedRole
        ? proposal.assignedRole
        : assignedRoleFor(taskType);'''
new_authority = '''  const requiredScope =
    input.policy.risk === "black"
      ? "emergency"
      : requestedHuman
        ? "full_takeover"
        : scopeFor(taskType);
  const scope = strongestScope(proposal.scope, requiredScope);
  const basePriority = priorityFor(taskType, input.policy, input.message);
  const requiredPriority =
    input.policy.risk === "black"
      ? "emergency"
      : requestedHuman && basePriority === "normal"
        ? "high"
        : basePriority;
  const priority = strongestPriority(proposal.priority, requiredPriority);
  const managerExplicitlyRequested = MANAGER_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const baseAssignedRole =
    taskType === "other" && proposal.assignedRole
      ? proposal.assignedRole
      : assignedRoleFor(taskType);
  const assignedRole =
    managerExplicitlyRequested && baseAssignedRole === "receptionist"
      ? "salon_manager"
      : baseAssignedRole;'''
text = replace_once(text, old_authority, new_authority, "enforce explicit takeover authority")

old_ack = '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : taskType === "other"
        ? safeAcknowledgement(proposal.clientAcknowledgement) ??
          defaultAcknowledgement(taskType, facts)
        : defaultAcknowledgement(taskType, facts);'''
new_ack = '''  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : requestedHuman
        ? defaultAcknowledgement("client_requested_human", facts)
        : taskType === "other"
          ? safeAcknowledgement(proposal.clientAcknowledgement) ??
            defaultAcknowledgement(taskType, facts)
          : defaultAcknowledgement(taskType, facts);'''
text = replace_once(text, old_ack, new_ack, "acknowledge explicit human request")
write(path, text)

path = "tests/automaticHandoff.test.ts"
text = read(path)
text = replace_once(
    text,
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.1.0");',
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.1.1");',
    "update policy version test",
)

insert_before = '''test("black-risk safety cases create an emergency handoff without replacing safety guidance", () => {'''
new_tests = '''test("medical safety outranks arrival wording and a manager request", () => {
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
        summary: null,
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
        summary: null,
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

test("a manager request on a complete booking keeps the booking task and pauses AI", () => {
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
        summary: null,
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
  assert.equal(result.priority, "high");
  assert.equal(result.assignedRole, "salon_manager");
  assert.match(result.clientReplyOverride ?? "", /direct assistance|staff member/i);
});

test("an explicit human request creates a booking task even while details are missing", () => {
  const result = assessHumanHandoff({
    message: "Please let me speak to a receptionist about booking Irene on Friday.",
    conversationId: "conversation-booking-human-incomplete",
    sourceMessageId: "message-booking-human-incomplete",
    policy: policy(),
    decision: decision({
      intent: "booking",
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
          stylist: "Irene",
          date: "Friday",
        },
        missingFacts: ["service", "outlet", "time"],
        clientAcknowledgement: null,
      },
    }),
  });

  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "booking_action");
  assert.equal(result.scope, "full_takeover");
  assert.equal(result.priority, "high");
  assert.equal(result.assignedRole, "receptionist");
  assert.deepEqual(result.missingFacts, ["service", "outlet", "time"]);
});

'''
text = replace_once(text, insert_before, new_tests + insert_before, "add precedence tests")
write(path, text)

original_ci = '''name: Hera receptionist verification

on:
  push:
    branches:
      - feat/hera-ai-receptionist-foundation
      - feat/360dialog-coexistence-adapter
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - name: Install locked dependencies
        run: npm ci
      - name: Strict type check and complete automated suite
        run: npm test
      - name: Credential scan
        run: npm run credential:scan
      - name: Production dependency audit
        run: npm audit --omit=dev --audit-level=high
'''
write(".github/workflows/ci.yml", original_ci)

(ROOT / "scripts/.automatic-handoff-final-trigger").unlink(missing_ok=True)
(ROOT / "scripts/refine-handoff-precedence.py").unlink(missing_ok=True)
(ROOT / ".github/workflows/refine-handoff-precedence.yml").unlink(missing_ok=True)
