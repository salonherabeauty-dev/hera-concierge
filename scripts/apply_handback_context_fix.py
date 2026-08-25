from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"Expected patch anchor was not found in {path}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


handoff = ROOT / "src/policy/handoff.ts"
replace_once(
    handoff,
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.1.1";',
    'export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.2.0";',
)

replace_once(
    handoff,
    '''const FALSE_COMPLETION_PATTERNS = [
''',
    '''const BOOKING_ACTION_PATTERNS = [
  /\\b(?:book|booking|appointment|reserve|reservation|schedule|slot)\\b/i,
  /\\b(?:available|availability)\\b.{0,60}\\b(?:today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b/i,
  /\\b(?:can|could|may)\\s+(?:i|we)\\b.{0,45}\\b(?:come|book|reserve|schedule|see)\\b/i,
  /\\b(?:i|we)(?:'d| would)?\\s+(?:like|want|need)\\s+to\\s+(?:book|reserve|schedule|come|see)\\b/i,
];

const INFORMATIONAL_SERVICE_PATTERNS = [
  /\\b(?:do|does|is|are)\\s+(?:hera|you|the salon|this outlet)\\b.{0,50}\\b(?:offer|provide|have|do)\\b/i,
  /\\b(?:do|does)\\s+(?:tanglin(?: mall)?|sentosa|quayside(?: isle)?)\\b.{0,50}\\b(?:offer|provide|have)\\b/i,
  /\\b(?:what|which)\\s+(?:services?|treatments?)\\b/i,
];

const APPOINTMENT_CHANGE_PATTERNS = [
  /\\b(?:change|move|reschedule|cancel|amend)\\b.{0,50}\\b(?:appointment|booking|slot|time|date)\\b/i,
  /\\b(?:appointment|booking|slot)\\b.{0,50}\\b(?:change|move|reschedule|cancel|amend)\\b/i,
];

const TECHNICAL_REVIEW_PATTERNS = [
  /\\b(?:bleach|strand test|patch test|chemical|rebond|relaxer|perm|keratin|hair damage|breakage|scalp reaction)\\b/i,
];

const FALSE_COMPLETION_PATTERNS = [
''',
)

replace_once(
    handoff,
    '''function uniqueMissing(values: HandoffFactKey[]): HandoffFactKey[] {
  return [...new Set(values)];
}
''',
    '''function uniqueMissing(values: HandoffFactKey[]): HandoffFactKey[] {
  return [...new Set(values)];
}

function bookingActionRequested(message: string, intent: AgentDecision["intent"]): boolean {
  if (intent === "booking" || intent === "availability") return true;
  const informational = INFORMATIONAL_SERVICE_PATTERNS.some((pattern) => pattern.test(message));
  const explicitAction = BOOKING_ACTION_PATTERNS.some((pattern) => pattern.test(message));
  return explicitAction && !informational;
}

function proposalSupportedByCurrentTurn(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  proposal: AgentHandoffProposal;
}): boolean {
  if (!input.proposal.required) return false;
  const taskType = input.proposal.taskType ?? "other";
  if (taskType === "booking_action") {
    return bookingActionRequested(input.message, input.decision.intent);
  }
  if (taskType === "appointment_change") {
    return (
      input.decision.intent === "appointment_change" ||
      APPOINTMENT_CHANGE_PATTERNS.some((pattern) => pattern.test(input.message))
    );
  }
  if (taskType === "arrival_issue") {
    return ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message));
  }
  if (taskType === "client_requested_human") {
    return HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message));
  }
  if (taskType === "complaint_review") return input.decision.intent === "complaint";
  if (taskType === "refund_finance") return input.decision.intent === "refund_compensation";
  if (taskType === "privacy_legal" || taskType === "security_review") {
    return input.decision.intent === "privacy_legal";
  }
  if (taskType === "medical_safety") {
    return input.decision.intent === "medical_safety" || input.policy.risk === "black";
  }
  if (taskType === "technical_review") {
    return (
      input.policy.risk !== "green" ||
      TECHNICAL_REVIEW_PATTERNS.some((pattern) => pattern.test(input.message))
    );
  }
  return (
    input.decision.intent === "other" &&
    input.decision.proposedActions.includes("create_handoff_task")
  );
}

function normalizedForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function staleInformationalReply(input: {
  message: string;
  decision: AgentDecision;
  proposal: AgentHandoffProposal;
}): string | null {
  if (
    input.proposal.taskType !== "booking_action" ||
    !input.proposal.required ||
    bookingActionRequested(input.message, input.decision.intent)
  ) {
    return null;
  }

  const message = normalizedForComparison(input.message);
  const facts = normalizedFacts(input.proposal.collectedFacts);
  const staleValues = [
    facts.service,
    facts.stylist,
    facts.date,
    facts.time,
    facts.flexibility,
    facts.appointmentReference,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizedForComparison)
    .filter((value) => value.length >= 2 && !message.includes(value));

  const bookingLanguage = [
    /\\blive availability\\b/i,
    /\\b(?:booking|appointment|slot)\\b/i,
    /\\breception\\b/i,
    /\\b(?:booked|confirmed|reserved|secured)\\b/i,
  ];
  const sentences = input.decision.reply
    .split(/(?<=[.!?])\\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const retained = sentences.filter((sentence) => {
    const normalized = normalizedForComparison(sentence);
    if (staleValues.some((value) => normalized.includes(value))) return false;
    if (bookingLanguage.some((pattern) => pattern.test(sentence))) return false;
    return true;
  });
  const cleaned = retained.join(" ").trim();
  if (cleaned) return cleaned.slice(0, 1000);

  return "I could not verify the outlet-specific service from the approved information. Hera’s team can confirm whether this service is offered at the requested outlet.";
}
''',
)

replace_once(
    handoff,
    '''  return input.proposal.required ? input.proposal.taskType ?? "other" : null;
}
''',
    '''  if (!input.proposal.required) return null;
  return proposalSupportedByCurrentTurn(input)
    ? input.proposal.taskType ?? "other"
    : null;
}
''',
)

replace_once(
    handoff,
    '''  if (!taskType) {
    return {
      createTask: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: facts,
      missingFacts: uniqueMissing(proposal.missingFacts),
      clientReplyOverride: null,
      clientVisibleStatus: null,
      dedupeKey: null,
      reason: "No human authority or external action is required.",
    };
  }
''',
    '''  if (!taskType) {
    const replyOverride = staleInformationalReply({
      message: input.message,
      decision: input.decision,
      proposal,
    });
    return {
      createTask: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: facts,
      missingFacts: uniqueMissing(proposal.missingFacts),
      clientReplyOverride: replyOverride,
      clientVisibleStatus: null,
      dedupeKey: null,
      reason: replyOverride
        ? "A stale booking proposal from earlier conversation history was rejected for this informational turn."
        : "No human authority or external action is required.",
    };
  }
''',
)

receptionist = ROOT / "src/ai/receptionist.ts"
replace_once(
    receptionist,
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.5.1";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.5.1";',
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.6.0";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.6.0";',
)
replace_once(
    receptionist,
    '''  "Reduce client effort. Use reliable details already present in the current conversation or current-client record, do not make the client repeat them, and never expose internal handoffs, queues, model names or operational terminology.",
''',
    '''  "Reduce client effort. Use reliable details already present in the current conversation or current-client record, do not make the client repeat them, and never expose internal handoffs, queues, model names or operational terminology.",
  "The latest client turn governs the current intent. Conversation history is reference only: never resurrect an earlier or completed booking, handoff, date, time, stylist or service unless the latest client message explicitly continues that action. A service-information question such as ‘Do you offer this service?’ is not a booking or live-availability request.",
''',
)
replace_once(
    receptionist,
    '''  "Verify the handoff proposal against the complete supplied conversation history. Approve it only when every collected fact is supported, every missing fact is genuinely missing, the task type, scope, priority and assigned role are appropriate, and the client acknowledgement does not claim an uncompleted action. If it is wrong or incomplete, return a complete correctedHandoff.",
''',
    '''  "Verify the handoff proposal against the complete supplied conversation history. Approve it only when every collected fact is supported, every missing fact is genuinely missing, the task type, scope, priority and assigned role are appropriate, and the client acknowledgement does not claim an uncompleted action. If it is wrong or incomplete, return a complete correctedHandoff.",
  "The latest client turn controls whether a new action exists. Reject any handoff that resurrects an earlier booking, date, time, stylist, outlet or service when the latest message is only a new informational question. ‘Do you offer this service?’ is not permission to reopen a completed booking task.",
''',
)

test_file = ROOT / "tests/automaticHandoff.test.ts"
replace_once(
    test_file,
    '  assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.1.1");',
    '  assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.2.0");',
)
with test_file.open("a", encoding="utf-8") as handle:
    handle.write(
        r'''

test("an informational service question cannot resurrect a completed booking handoff", () => {
  const result = assessHumanHandoff({
    message: "Thank you. Does Hera offer curly haircuts at Tanglin Mall?",
    conversationId: "conversation-handback-info",
    sourceMessageId: "message-handback-info",
    policy: policy(),
    decision: decision({
      intent: "service_advice",
      reply:
        "Yes, Hera offers curly haircuts. I could not verify whether they are available specifically at Tanglin Mall, so reception will check this alongside Irene’s live availability for 2 pm.",
      proposedActions: ["answer", "create_handoff_task"],
      handoff: {
        required: true,
        taskType: "booking_action",
        scope: "task_only",
        priority: "normal",
        assignedRole: "receptionist",
        assignedOutlet: "Tanglin Mall",
        summary: "Earlier booking plus current service question.",
        requestedAction: "Recheck the earlier booking.",
        collectedFacts: {
          ...emptyFacts,
          service: "root colour touch-up and toner",
          stylist: "Irene",
          outlet: "Tanglin Mall",
          date: "Friday 28 August",
          time: "around 2 pm",
          flexibility: "between 1 pm and 4 pm",
          desiredOutcome: "Confirm the earlier booking and curly haircut service.",
        },
        missingFacts: [],
        clientAcknowledgement: "Reception will check live availability.",
      },
    }),
  });

  assert.equal(result.createTask, false);
  assert.equal(result.taskType, null);
  assert.equal(result.dedupeKey, null);
  assert.match(result.reason, /stale booking proposal/i);
  assert.equal(result.clientReplyOverride, "Yes, Hera offers curly haircuts.");
  assert.doesNotMatch(result.clientReplyOverride ?? "", /Irene|2 pm|reception|live availability/i);
});

test("a genuine current-turn availability request still creates a booking handoff", () => {
  const result = assessHumanHandoff({
    message: "Is Irene available at Tanglin Mall this Friday at 2 pm for a root colour touch-up?",
    conversationId: "conversation-current-availability",
    sourceMessageId: "message-current-availability",
    policy: policy(),
    decision: decision({
      intent: "service_advice",
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
          service: "root colour touch-up",
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

  assert.equal(result.createTask, true);
  assert.equal(result.taskType, "booking_action");
});
'''
    )

prompt_test = ROOT / "tests/handbackContextIsolation.test.ts"
prompt_test.write_text(
    '''import assert from "node:assert/strict";\nimport test from "node:test";\nimport { RESPONSE_INSTRUCTIONS, VERIFIER_INSTRUCTIONS } from "../src/ai/receptionist.js";\n\ntest("response and verifier prompts make the latest client turn authoritative", () => {\n  assert.match(RESPONSE_INSTRUCTIONS, /latest client turn governs the current intent/i);\n  assert.match(RESPONSE_INSTRUCTIONS, /not a booking or live-availability request/i);\n  assert.match(VERIFIER_INSTRUCTIONS, /latest client turn controls whether a new action exists/i);\n  assert.match(VERIFIER_INSTRUCTIONS, /not permission to reopen a completed booking task/i);\n});\n''',
    encoding="utf-8",
)

package_path = ROOT / "package.json"
package_data = json.loads(package_path.read_text(encoding="utf-8"))
package_data["scripts"]["build"] = "npm run build:command-centre"
package_path.write_text(json.dumps(package_data, indent=2) + "\n", encoding="utf-8")

(ROOT / "scripts/verify-ai-resumption-retry.ts").unlink(missing_ok=True)

# Remove the temporary patch machinery in the same bot commit.
Path(__file__).unlink(missing_ok=True)
(ROOT / ".github/workflows/apply-handback-context-fix.yml").unlink(missing_ok=True)
