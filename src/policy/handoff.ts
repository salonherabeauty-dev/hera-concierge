import type {
  AgentDecision,
  AgentHandoffFacts,
  AgentHandoffProposal,
  HandoffAssignedRole,
  HandoffFactKey,
  HandoffPriority,
  HandoffScope,
  HandoffTaskType,
  PolicyAssessment,
} from "../types.js";

export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.0.0";

const HUMAN_REQUEST_PATTERNS = [
  /\b(?:speak|talk|chat|connect|transfer|pass me|put me through)\b.{0,28}\b(?:human|person|receptionist|manager|staff|someone)\b/i,
  /\b(?:human|person|receptionist|manager|staff)\b.{0,28}\b(?:please|now|instead|take over)\b/i,
  /\b(?:no|stop)\s+(?:bot|ai|automated replies?)\b/i,
  /真人|人工客服|转人工|经理|店长/u,
  /pegawai|manusia|pengurus|penyambut tetamu/i,
  /மனிதர்|மேலாளர்|வரவேற்பாளர்/u,
];

const ARRIVAL_PATTERNS = [
  /\b(?:i am|i'm|we are|we're)\s+(?:here|outside|at the salon|in the lift|at reception)\b/i,
  /\b(?:arrived|waiting at reception|coming up in the lift)\b/i,
  /\b(?:running|will be)\s+(?:late|[0-9]{1,3}\s*(?:mins?|minutes?)\s+late)\b/i,
];

const SAME_DAY_PATTERNS = [
  /\b(?:today|this afternoon|this evening|tonight|same[ -]?day|right now|as soon as possible|asap)\b/i,
  /今天|今日|下午|今晚|马上|尽快/u,
];

const FALSE_COMPLETION_PATTERNS = [
  /\b(?:i|we)(?:'ve| have| already)?\s+(?:booked|confirmed|reserved|secured|changed|cancelled)\b/i,
  /\b(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured|changed|cancelled)\b/i,
];

const URL_PATTERN = /https?:\/\//i;

const EMPTY_FACTS: AgentHandoffFacts = {
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

const BOOKING_REQUIRED_FACTS: HandoffFactKey[] = [
  "service",
  "outlet",
  "date",
  "time",
];

export interface HumanHandoffAssessment {
  createTask: boolean;
  taskType: HandoffTaskType | null;
  scope: HandoffScope | null;
  priority: HandoffPriority | null;
  assignedRole: HandoffAssignedRole | null;
  assignedOutlet: string | null;
  summary: string | null;
  requestedAction: string | null;
  collectedFacts: AgentHandoffFacts;
  missingFacts: HandoffFactKey[];
  clientReplyOverride: string | null;
  clientVisibleStatus: string | null;
  dedupeKey: string | null;
  reason: string;
}

function clean(value: string | null | undefined, maximum = 1200): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizedFacts(value: AgentHandoffFacts | undefined): AgentHandoffFacts {
  const source = value ?? EMPTY_FACTS;
  return {
    service: clean(source.service, 200),
    stylist: clean(source.stylist, 160),
    outlet: clean(source.outlet, 160),
    date: clean(source.date, 160),
    time: clean(source.time, 160),
    flexibility: clean(source.flexibility, 240),
    appointmentReference: clean(source.appointmentReference, 240),
    desiredOutcome: clean(source.desiredOutcome, 400),
    symptoms: clean(source.symptoms, 600),
    photos: clean(source.photos, 240),
    other: clean(source.other, 600),
  };
}

function defaultProposal(decision: AgentDecision): AgentHandoffProposal {
  return (
    decision.handoff ?? {
      required: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: { ...EMPTY_FACTS },
      missingFacts: [],
      clientAcknowledgement: null,
    }
  );
}

function uniqueMissing(values: HandoffFactKey[]): HandoffFactKey[] {
  return [...new Set(values)];
}

function bookingMissingFacts(facts: AgentHandoffFacts): HandoffFactKey[] {
  return BOOKING_REQUIRED_FACTS.filter((key) => !facts[key]);
}

function safeAcknowledgement(value: string | null): string | null {
  const candidate = clean(value, 1000);
  if (!candidate) return null;
  if (FALSE_COMPLETION_PATTERNS.some((pattern) => pattern.test(candidate))) return null;
  if (URL_PATTERN.test(candidate)) return null;
  return candidate;
}

function bookingDescription(facts: AgentHandoffFacts): string {
  const service = facts.service ?? "the requested service";
  const stylist = facts.stylist ? ` with ${facts.stylist}` : "";
  const outlet = facts.outlet ? ` at ${facts.outlet}` : "";
  const date = facts.date ? ` on ${facts.date}` : "";
  const time = facts.time ? ` at ${facts.time}` : "";
  return `${service}${stylist}${outlet}${date}${time}`.replace(/\s+/g, " ").trim();
}

function defaultSummary(
  taskType: HandoffTaskType,
  facts: AgentHandoffFacts,
): string {
  if (taskType === "booking_action") {
    return `Booking request: ${bookingDescription(facts)}`.slice(0, 1000);
  }
  if (taskType === "appointment_change") {
    return `Appointment change request${facts.appointmentReference ? `: ${facts.appointmentReference}` : ""}`.slice(0, 1000);
  }
  if (taskType === "complaint_review") return "Client service concern requires management review.";
  if (taskType === "refund_finance") return "Client financial or refund request requires authorised review.";
  if (taskType === "medical_safety") return "Urgent client safety concern requires immediate human attention.";
  if (taskType === "privacy_legal") return "Client privacy or legal request requires authorised handling.";
  if (taskType === "client_requested_human") return "Client explicitly requested direct human assistance.";
  if (taskType === "arrival_issue") return "Time-sensitive arrival or appointment-day issue.";
  return "Client request requires a human action.";
}

function defaultRequestedAction(taskType: HandoffTaskType): string {
  const actions: Record<HandoffTaskType, string> = {
    booking_action:
      "Check live availability in Timely, create the appointment if the client accepts an available option, and confirm the actual outcome.",
    appointment_change:
      "Verify the current appointment, complete the requested change or provide available alternatives, and confirm the actual outcome.",
    arrival_issue:
      "Contact the correct outlet immediately and coordinate the time-sensitive appointment issue.",
    group_booking:
      "Review staffing, timing, service scope and deposit requirements, then coordinate the group booking.",
    complaint_review:
      "Review the conversation and service evidence, contact the client with management ownership, and decide the authorised recovery action.",
    refund_finance:
      "Verify the transaction and appointment records, then obtain the authorised financial decision before responding.",
    medical_safety:
      "Review immediately, ensure emergency guidance has been given, and contact the client only when it is safe and appropriate.",
    technical_review:
      "Arrange senior technical review before any chemical-service commitment is made.",
    privacy_legal:
      "Route to the authorised privacy or legal handler and preserve all relevant records.",
    accessibility_arrangement:
      "Confirm and arrange the requested accessibility or privacy accommodation with the correct outlet.",
    consent_media:
      "Review the consent or media request and complete the authorised action.",
    lost_property:
      "Check with the correct outlet and update the client with the verified outcome.",
    client_requested_human:
      "A Hera staff member should take over the conversation and assist the client directly.",
    security_review:
      "Review the security concern, preserve evidence and take the authorised protective action.",
    system_failure:
      "Investigate the operational failure and ensure the client receives a verified human response.",
    other:
      "Review the request, complete the required human action and record the verified outcome.",
  };
  return actions[taskType];
}

function defaultAcknowledgement(
  taskType: HandoffTaskType,
  facts: AgentHandoffFacts,
): string | null {
  if (taskType === "medical_safety") return null;
  if (taskType === "booking_action") {
    return `Thank you. I’ve noted ${bookingDescription(facts)}. Our reception team will now check live availability and confirm the appointment with you.`;
  }
  if (taskType === "appointment_change") {
    return "Thank you. I’ve passed your appointment-change request to our reception team for verification and confirmation.";
  }
  if (taskType === "client_requested_human") {
    return "Certainly. I’ve arranged for a member of Hera’s team to take over this conversation and assist you directly.";
  }
  if (taskType === "complaint_review") {
    return "Thank you for explaining this. I’ve arranged for Hera’s management team to review the matter and continue assisting you directly.";
  }
  if (taskType === "refund_finance") {
    return "Thank you. I’ve arranged for the authorised team to review the transaction and contact you with the verified outcome.";
  }
  if (taskType === "privacy_legal") {
    return "Thank you. I’ve routed this to Hera’s authorised privacy and management team for direct review.";
  }
  if (taskType === "arrival_issue") {
    return "Thank you for updating us. I’ve alerted the outlet team so they can assist with the appointment immediately.";
  }
  return "Thank you. I’ve passed this to the appropriate Hera team for direct review and action.";
}

function assignedRoleFor(taskType: HandoffTaskType): HandoffAssignedRole {
  if (taskType === "complaint_review" || taskType === "arrival_issue") return "salon_manager";
  if (taskType === "refund_finance") return "managing_director";
  if (taskType === "medical_safety" || taskType === "technical_review") return "technical_lead";
  if (taskType === "privacy_legal" || taskType === "consent_media" || taskType === "security_review") {
    return "privacy_officer";
  }
  return "receptionist";
}

function scopeFor(taskType: HandoffTaskType): HandoffScope {
  if (taskType === "medical_safety") return "emergency";
  if (
    taskType === "complaint_review" ||
    taskType === "refund_finance" ||
    taskType === "privacy_legal" ||
    taskType === "client_requested_human" ||
    taskType === "security_review"
  ) {
    return "full_takeover";
  }
  return "task_only";
}

function strongestScope(
  proposed: HandoffScope | null,
  required: HandoffScope,
): HandoffScope {
  const rank: Record<HandoffScope, number> = {
    task_only: 0,
    full_takeover: 1,
    emergency: 2,
  };
  return proposed && rank[proposed] > rank[required] ? proposed : required;
}

function priorityFor(
  taskType: HandoffTaskType,
  policy: PolicyAssessment,
  message: string,
): HandoffPriority {
  if (policy.risk === "black" || taskType === "medical_safety") return "emergency";
  if (taskType === "privacy_legal" || taskType === "security_review" || taskType === "arrival_issue") {
    return "urgent";
  }
  if (
    taskType === "complaint_review" ||
    taskType === "refund_finance" ||
    taskType === "appointment_change" ||
    taskType === "client_requested_human"
  ) {
    return "high";
  }
  if (taskType === "booking_action" && SAME_DAY_PATTERNS.some((pattern) => pattern.test(message))) {
    return "high";
  }
  return "normal";
}

function strongestPriority(
  proposed: HandoffPriority | null,
  required: HandoffPriority,
): HandoffPriority {
  const rank: Record<HandoffPriority, number> = {
    normal: 0,
    high: 1,
    urgent: 2,
    emergency: 3,
  };
  return proposed && rank[proposed] > rank[required] ? proposed : required;
}

function taskTypeFor(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  proposal: AgentHandoffProposal;
}): HandoffTaskType | null {
  if (input.policy.risk === "black" || input.decision.intent === "medical_safety") {
    return "medical_safety";
  }
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) return "arrival_issue";
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }
  if (input.decision.intent === "appointment_change") return "appointment_change";
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  if (input.decision.intent === "booking" || input.decision.intent === "availability") {
    return "booking_action";
  }
  return input.proposal.required ? input.proposal.taskType ?? "other" : null;
}

export function assessHumanHandoff(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  conversationId: string;
  sourceMessageId: string;
}): HumanHandoffAssessment {
  const proposal = defaultProposal(input.decision);
  const facts = normalizedFacts(proposal.collectedFacts);
  const taskType = taskTypeFor({
    message: input.message,
    decision: input.decision,
    policy: input.policy,
    proposal,
  });

  if (!taskType) {
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

  let missingFacts = uniqueMissing(proposal.missingFacts);
  if (taskType === "booking_action") {
    missingFacts = uniqueMissing([...missingFacts, ...bookingMissingFacts(facts)]);
    if (missingFacts.length > 0) {
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
    }
  }

  const requiredScope =
    input.policy.risk === "black" ? "emergency" : scopeFor(taskType);
  const scope = strongestScope(proposal.scope, requiredScope);
  const requiredPriority =
    input.policy.risk === "black"
      ? "emergency"
      : priorityFor(taskType, input.policy, input.message);
  const priority = strongestPriority(proposal.priority, requiredPriority);
  const assignedRole =
    taskType === "other" && proposal.assignedRole
      ? proposal.assignedRole
      : assignedRoleFor(taskType);
  const assignedOutlet = clean(proposal.assignedOutlet, 160) ?? facts.outlet;
  const summary =
    clean(proposal.summary, 1000) ?? defaultSummary(taskType, facts);
  const requestedAction =
    clean(proposal.requestedAction, 1200) ?? defaultRequestedAction(taskType);
  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : safeAcknowledgement(proposal.clientAcknowledgement) ??
        defaultAcknowledgement(taskType, facts);

  return {
    createTask: true,
    taskType,
    scope,
    priority,
    assignedRole,
    assignedOutlet,
    summary,
    requestedAction,
    collectedFacts: facts,
    missingFacts,
    clientReplyOverride: acknowledgement,
    clientVisibleStatus: acknowledgement,
    dedupeKey: `automatic-handoff:${taskType}:${input.sourceMessageId}`,
    reason: "A human authority, live-system check or external action is required.",
  };
}
