import type {
  AgentDecision,
  PolicyAssessment,
  RiskLevel,
} from "../types.js";
import type { HumanHandoffAssessment } from "./handoff.js";

export const FINAL_RESPONSE_QUALITY_POLICY_VERSION =
  "hera-final-response-quality-1.0.0";

export interface FinalResponseQualityAssessment {
  passed: boolean;
  issues: string[];
  checks: {
    complete: boolean;
    clientFacing: boolean;
    safeAuthority: boolean;
    contextualEmpathy: boolean;
    specificity: boolean;
    ownership: boolean;
    nextStep: boolean;
    conciseTone: boolean;
  };
}

const INTERNAL_LANGUAGE =
  /\b(?:handoff|human-action task|internal queue|priority queue|workflow|verifier|model name|policy rule|backend|system prompt)\b/i;
const GENERIC_HUMAN_ACKNOWLEDGEMENT =
  /certainly\.?\s+i(?:'|’)ve sent your request to hera(?:'|’)s team for direct assistance\.?\s+a staff member will continue with you as soon as available\.?/i;
const BOOKING_COMPLETION =
  /\b(?:i|we)(?:'|’)ve\s+(?:booked|confirmed|reserved|secured)|\b(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured)\b/i;
const FINANCIAL_COMPLETION =
  /\b(?:refund|compensation|credit|voucher)\s+(?:is|has been|was|will be)\s+(?:approved|processed|issued|given|applied)\b|\b(?:i|we)(?:'|’)ve\s+(?:approved|processed|issued)\s+(?:a\s+)?(?:refund|compensation|credit|voucher)\b/i;
const PRIVACY_COMPLETION =
  /\b(?:your|the)\s+(?:data|number|photo|record)s?\s+(?:has|have)\s+been\s+(?:deleted|removed|erased)\b/i;
const LIABILITY_ADMISSION =
  /\b(?:we|hera|our stylist)\s+(?:damaged|destroyed|ruined|caused|were at fault|are liable)|\bour fault\b|\bwe accept liability\b/i;
const GUARANTEED_REMEDY =
  /\b(?:guaranteed|definitely|certainly)\s+(?:fix|resolve|refund|redo)|\b(?:free|complimentary)\s+(?:redo|service|treatment|correction)\b/i;
const EMPATHY =
  /\b(?:sorry|understand|appreciate|thank you for explaining|unhappy|concern|disappointed|frustrating|experience)\b/i;
const OWNERSHIP =
  /\b(?:manager|management|authorised team|privacy team|technical lead|reception team|outlet team|hera(?:'|’)s team|staff member)\b/i;
const NEXT_STEP =
  /\b(?:review|assess|check|verify|advise|confirm|contact|share|send|seek|arrange|coordinate|update|next step)\b/i;
const URGENT_SAFETY =
  /\b(?:urgent medical attention|emergency medical attention|emergency services|call 995|seek medical attention|stop using|stop the service|breathing difficulty|severe swelling|eye exposure)\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

function normalized(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesKnownFact(reply: string, fact: string | null): boolean {
  if (!fact) return true;
  const expected = normalized(fact);
  if (!expected) return true;
  return normalized(reply).includes(expected);
}

function sentenceCount(reply: string): number {
  return reply
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function taskType(input: {
  decision: AgentDecision;
  handoff: HumanHandoffAssessment;
}): string | null {
  if (input.handoff.taskType) return input.handoff.taskType;
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "medical_safety") return "medical_safety";
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  return null;
}

export function assessFinalResponseQuality(input: {
  clientMessage: string;
  reply: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  handoff: HumanHandoffAssessment;
  risk: RiskLevel;
}): FinalResponseQualityAssessment {
  const reply = input.reply.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const issues: string[] = [];
  const type = taskType(input);
  const facts = input.handoff.collectedFacts;

  if (!reply) issues.push("The final client reply is empty.");
  if (reply.length > 4000) issues.push("The final client reply exceeds the delivery limit.");
  if (INTERNAL_LANGUAGE.test(reply)) {
    issues.push("The final client reply exposes internal operational terminology.");
  }
  if (EMOJI.test(reply) || reply.includes("!")) {
    issues.push("The final client reply uses an emoji or exclamation mark.");
  }
  if (sentenceCount(reply) > 6) {
    issues.push("The final client reply is unnecessarily long.");
  }
  if (
    input.handoff.createTask &&
    type !== "client_requested_human" &&
    GENERIC_HUMAN_ACKNOWLEDGEMENT.test(reply)
  ) {
    issues.push("A specialised handoff was reduced to a crude generic human-assistance message.");
  }
  if (BOOKING_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unverified booking completion.");
  }
  if (FINANCIAL_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unauthorised financial outcome.");
  }
  if (PRIVACY_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unverified privacy action is complete.");
  }
  if (LIABILITY_ADMISSION.test(reply)) {
    issues.push("The final client reply admits liability or blame.");
  }
  if (GUARANTEED_REMEDY.test(reply)) {
    issues.push("The final client reply promises or guarantees a remedy.");
  }

  if (type === "complaint_review") {
    if (!EMPATHY.test(reply)) {
      issues.push("The complaint reply does not acknowledge the client’s experience or concern.");
    }
    if (!/\b(?:salon manager|manager|management)\b/i.test(reply)) {
      issues.push("The complaint reply does not identify management ownership.");
    }
    if (!/\b(?:review|assess|advise|next step)\b/i.test(reply)) {
      issues.push("The complaint reply does not explain the review or next step.");
    }
    if (!includesKnownFact(reply, facts.service)) {
      issues.push("The complaint reply omits the known service context.");
    }
    if (!includesKnownFact(reply, facts.outlet)) {
      issues.push("The complaint reply omits the known outlet context.");
    }
  }

  if (type === "booking_action") {
    if (!/\bcheck\b/i.test(reply) || !/\b(?:live\s+)?availability\b/i.test(reply)) {
      issues.push("The booking reply does not state that live availability still requires checking.");
    }
    if (!includesKnownFact(reply, facts.service) || !includesKnownFact(reply, facts.outlet)) {
      issues.push("The booking reply omits known booking details.");
    }
  }

  if (type === "appointment_change") {
    if (!/\b(?:verify|check|review)\b/i.test(reply)) {
      issues.push("The appointment-change reply does not state that the existing booking will be verified.");
    }
    if (!/\b(?:confirm|alternative|available|outcome)\b/i.test(reply)) {
      issues.push("The appointment-change reply does not explain how the verified outcome will be confirmed.");
    }
  }

  if (type === "refund_finance") {
    if (!/\b(?:authorised|finance|management|transaction)\b/i.test(reply)) {
      issues.push("The financial reply does not identify authorised review.");
    }
    if (!/\b(?:verify|review|assess|confirm)\b/i.test(reply)) {
      issues.push("The financial reply does not explain the verification step.");
    }
  }

  if (type === "medical_safety") {
    if ((input.risk === "black" || input.handoff.scope === "emergency") && !URGENT_SAFETY.test(reply)) {
      issues.push("The emergency reply does not preserve urgent safety guidance.");
    }
    if (/\bdiagnos(?:e|ed|is)|medically safe\b/i.test(reply)) {
      issues.push("The safety reply makes a diagnosis or medical-safety claim.");
    }
  }

  if (type === "privacy_legal") {
    if (!/\b(?:authorised|privacy|management|preserve|review)\b/i.test(reply)) {
      issues.push("The privacy or legal reply does not identify authorised handling.");
    }
  }

  if (type === "arrival_issue") {
    if (!/\b(?:outlet|reception|team|coordinate|contact)\b/i.test(reply)) {
      issues.push("The arrival reply does not explain direct outlet coordination.");
    }
  }

  if (!input.handoff.createTask && GENERIC_HUMAN_ACKNOWLEDGEMENT.test(reply)) {
    issues.push("The final reply claims a human escalation that was not created.");
  }

  const complete = Boolean(reply) && reply.length <= 4000;
  const clientFacing = !INTERNAL_LANGUAGE.test(reply);
  const safeAuthority = ![
    BOOKING_COMPLETION,
    FINANCIAL_COMPLETION,
    PRIVACY_COMPLETION,
    LIABILITY_ADMISSION,
    GUARANTEED_REMEDY,
  ].some((pattern) => pattern.test(reply));
  const contextualEmpathy = type === "complaint_review" ? EMPATHY.test(reply) : true;
  const specificity =
    type === "complaint_review" || type === "booking_action"
      ? includesKnownFact(reply, facts.service) && includesKnownFact(reply, facts.outlet)
      : true;
  const ownership = input.handoff.createTask ? OWNERSHIP.test(reply) : true;
  const nextStep = NEXT_STEP.test(reply) || !input.handoff.createTask;
  const conciseTone = !EMOJI.test(reply) && !reply.includes("!") && sentenceCount(reply) <= 6;

  return {
    passed: issues.length === 0,
    issues,
    checks: {
      complete,
      clientFacing,
      safeAuthority,
      contextualEmpathy,
      specificity,
      ownership,
      nextStep,
      conciseTone,
    },
  };
}
