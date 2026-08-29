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
import {
  assessServiceInformation,
  SERVICE_INFORMATION_POLICY_VERSION,
} from "./serviceInformation.js";
import { promptInjectionReplyFor } from "./risk.js";

export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.4.0";

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

const BOOKING_ACTION_PATTERNS = [
  /\b(?:book|booking|appointment|reserve|reservation|schedule|slot)\b/i,
  /\b(?:available|availability)\b.{0,60}\b(?:today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
  /\b(?:can|could|may)\s+(?:i|we)\b.{0,45}\b(?:come|book|reserve|schedule|see)\b/i,
  /\b(?:i|we)(?:'d| would)?\s+(?:like|want|need)\s+to\s+(?:book|reserve|schedule|come|see)\b/i,
];

const INFORMATIONAL_SERVICE_PATTERNS = [
  /\b(?:do|does|is|are)\s+(?:hera|you|the salon|this outlet)\b.{0,50}\b(?:offer|provide|have|do)\b/i,
  /\b(?:do|does)\s+(?:tanglin(?: mall)?|sentosa|quayside(?: isle)?)\b.{0,50}\b(?:offer|provide|have)\b/i,
  /\b(?:what|which)\s+(?:services?|treatments?)\b/i,
];

const APPOINTMENT_CHANGE_PATTERNS = [
  /\b(?:change|move|reschedule|cancel|amend)\b.{0,50}\b(?:appointment|booking|slot|time|date)\b/i,
  /\b(?:appointment|booking|slot)\b.{0,50}\b(?:change|move|reschedule|cancel|amend)\b/i,
];

const TECHNICAL_REVIEW_PATTERNS = [
  /\b(?:bleach|strand test|patch test|chemical|rebond|relaxer|perm|keratin|hair damage|breakage|scalp reaction)\b/i,
];

const FALSE_COMPLETION_PATTERNS = [
  /\b(?:i|we)(?:'ve| have| already)?\s+(?:booked|confirmed|reserved|secured|changed|cancelled)\b/i,
  /\b(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured|changed|cancelled)\b/i,
];

const URL_PATTERN = /https?:\/\//i;

const MANAGER_REQUEST_PATTERNS = [
  /\b(?:manager|owner|managing director|person in charge)\b/i,
  /经理|店长|负责人/u,
  /pengurus|orang yang bertanggungjawab/i,
  /மேலாளர்|பொறுப்பாளர்/u,
];

const OUTLET_ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "Tanglin Mall",
    patterns: [/\btanglin(?: mall)?\b/i],
  },
  {
    canonical: "Sentosa Quayside Isle",
    patterns: [/\bsentosa\b/i, /\bquayside(?: isle)?\b/i],
  },
];

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

function canonicalOutlet(value: string | null | undefined): string | null {
  const candidate = clean(value, 160);
  if (!candidate) return null;
  for (const outlet of OUTLET_ALIASES) {
    if (outlet.patterns.some((pattern) => pattern.test(candidate))) {
      return outlet.canonical;
    }
  }
  return null;
}

function normalizedFacts(value: AgentHandoffFacts | undefined): AgentHandoffFacts {
  const source = value ?? EMPTY_FACTS;
  return {
    service: clean(source.service, 200),
    stylist: clean(source.stylist, 160),
    outlet: canonicalOutlet(source.outlet),
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
    /\blive availability\b/i,
    /\b(?:booking|appointment|slot)\b/i,
    /\breception\b/i,
    /\b(?:booked|confirmed|reserved|secured)\b/i,
  ];
  const sentences = input.decision.reply
    .split(/(?<=[.!?])\s+/)
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
  if (taskType === "medical_safety") return "Client safety concern requires priority human review.";
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
      "Review the symptoms and service context promptly, confirm that the appropriate safety guidance was given, and contact the client only within the team's professional scope.",
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
    return `Thank you. I’ve noted ${bookingDescription(facts)}. Our reception team will now check live availability and update you with the available option or confirmed outcome.`;
  }
  if (taskType === "appointment_change") {
    return "Thank you. I’ve passed your appointment-change request to our reception team for verification and confirmation.";
  }
  if (taskType === "client_requested_human") {
    return "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.";
  }
  if (taskType === "complaint_review") {
    const service = facts.service ? ` regarding your ${facts.service}` : "";
    const outlet = facts.outlet ? ` at ${facts.outlet}` : "";
    const visualConcern = [facts.other, facts.desiredOutcome]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const photoRequest =
      !facts.photos &&
      /\b(?:uneven|colour|color|cut|layers?|shape|length|fringe|hair|result|finish|breakage|damage)\b/i.test(
        visualConcern,
      )
        ? " Please share clear photos of the result if convenient; they will help the manager review it carefully."
        : "";
    return `Thank you for explaining this, and I’m sorry this experience has left you unhappy. I’ve placed your concern${service}${outlet} with Hera’s salon manager for a careful review.${photoRequest} The manager will assess the details and advise the appropriate next step after the review.`;
  }
  if (taskType === "refund_finance") {
    return "Thank you. I’ve placed the transaction request with the authorised team for verification and a confirmed outcome.";
  }
  if (taskType === "privacy_legal") {
    return "Thank you. I’ve routed this to Hera’s authorised privacy team for direct review.";
  }
  if (taskType === "arrival_issue") {
    return "Thank you for updating us. I’ve placed this in the outlet team’s urgent queue for immediate coordination.";
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
  if (taskType === "medical_safety") return "full_takeover";
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
  if (policy.risk === "black") return "emergency";
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(message))) return "urgent";
  if (taskType === "medical_safety") {
    return policy.risk === "red" ? "urgent" : "high";
  }
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
  if (
    input.policy.securityFlags.includes("prompt_injection_attempt") &&
    input.policy.replyOverride === promptInjectionReplyFor(input.message)
  ) {
    return null;
  }
  // Highest consequence wins. A request for a person changes ownership and
  // scope, but it must not erase the underlying booking, safety or complaint action.
  if (
    input.policy.risk === "black" ||
    input.decision.intent === "medical_safety"
  ) {
    return "medical_safety";
  }
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "appointment_change") return "appointment_change";
  if (input.decision.intent === "booking" || input.decision.intent === "availability") {
    return "booking_action";
  }
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "client_requested_human";
  }
  if (ARRIVAL_PATTERNS.some((pattern) => pattern.test(input.message))) {
    return "arrival_issue";
  }
  if (!input.proposal.required) return null;
  return proposalSupportedByCurrentTurn(input)
    ? input.proposal.taskType ?? "other"
    : null;
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
  const requestedHuman = HUMAN_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const serviceInformation = assessServiceInformation({
    message: input.message,
    decision: input.decision,
    policy: input.policy,
  });
  if (serviceInformation.matched && serviceInformation.reply) {
    return {
      createTask: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: { ...EMPTY_FACTS },
      missingFacts: [],
      clientReplyOverride: serviceInformation.reply,
      clientVisibleStatus: null,
      dedupeKey: null,
      reason: `${serviceInformation.reason} Policy ${SERVICE_INFORMATION_POLICY_VERSION}; sources ${serviceInformation.sourceIds.join(", ")}.`,
    };
  }
  const taskType = taskTypeFor({
    message: input.message,
    decision: input.decision,
    policy: input.policy,
    proposal,
  });

  if (!taskType) {
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

  let missingFacts = uniqueMissing(proposal.missingFacts);
  if (taskType === "booking_action") {
    // Booking readiness is deterministic. Optional preferences such as stylist
    // and flexibility can never prevent a complete request from reaching reception.
    missingFacts = bookingMissingFacts(facts);
    if (missingFacts.length > 0 && !requestedHuman) {
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
      : baseAssignedRole;
  const assignedOutlet = canonicalOutlet(proposal.assignedOutlet) ?? facts.outlet;
  // Known task classes use deterministic internal wording. The model may supply
  // custom wording only for an uncategorised task, never for booking or authority claims.
  const summary =
    taskType === "other"
      ? clean(proposal.summary, 1000) ?? defaultSummary(taskType, facts)
      : defaultSummary(taskType, facts);
  const requestedAction =
    taskType === "other"
      ? clean(proposal.requestedAction, 1200) ?? defaultRequestedAction(taskType)
      : defaultRequestedAction(taskType);
  const acknowledgement =
    taskType === "medical_safety"
      ? null
      : taskType === "complaint_review"
        ? defaultAcknowledgement(taskType, facts)
        : requestedHuman
          ? defaultAcknowledgement("client_requested_human", facts)
          : taskType === "other"
            ? safeAcknowledgement(proposal.clientAcknowledgement) ??
              defaultAcknowledgement(taskType, facts)
            : defaultAcknowledgement(taskType, facts);

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
