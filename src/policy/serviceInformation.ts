import type { AgentDecision, PolicyAssessment } from "../types.js";

export const SERVICE_INFORMATION_POLICY_VERSION = "hera-service-information-1.0.1";
export const CURL_SERVICE_SOURCE_ID =
  "hera-kb-v4:hera-operator-approved-curl-service-matrix-version-2";

export interface ServiceInformationAssessment {
  matched: boolean;
  reply: string | null;
  reason: string;
  sourceIds: string[];
}

const CURL_TERMS =
  /\b(?:curly|curl|curls|wavy|waves|coily|coils|afro|textured hair|[234][abc])\b/i;
const SERVICE_TERMS =
  /\b(?:haircut|haircuts|cut|cuts|service|services|specialist|specialise|specialize|offer|offers|provide|provides|have|has|do)\b/i;
const SPECIALIST_MATCH =
  /(?:\b(?:who|which|recommend|recommended|best|most suitable|specialist|stylist)\b.{0,80}\b(?:curly|curl|curls|wavy|waves|coily|coils|afro|[234][abc])\b|\b(?:curly|curl|curls|wavy|waves|coily|coils|afro|[234][abc])\b.{0,80}\b(?:specialist|stylist|recommend|best|most suitable)\b)/i;
const EXPLICIT_BOOKING_ACTION =
  /\b(?:book|booking|appointment|reserve|reservation|schedule|slot|slots|reschedule|cancel|change my appointment)\b/i;
const SERVICE_ACTION_REQUEST =
  /(?:\b(?:i|we)(?:'d| would)?\s+(?:like|want|need)\s+(?:to\s+)?(?:get|have|book|schedule)\b|\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have|book|schedule)\b)/i;
const AVAILABILITY_TERMS = /\b(?:available|availability)\b/i;
const SCHEDULE_AVAILABILITY_REQUEST =
  /(?:\b(?:do you have|is there|are there)\s+(?:any\s+)?(?:appointment|appointments|booking|bookings|slot|slots|availability)\b|\b(?:check|show|find)\b.{0,30}\b(?:availability|available)\b|\bwhen\b.{0,30}\bavailable\b)/i;
const DATE_OR_TIME =
  /\b(?:today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
const NAMED_STYLIST_AVAILABILITY =
  /\b(?:is|are)\s+(?:(?:Alina|Phoeve|Irene|Adam|Ilze|Tamson|Aleksandra|Monica|Rain|Leah|Johnny|Aldy|Gabriela)|(?:(?:my|your|the|a|any)\s+)?(?:stylist|colourist|hairdresser|specialist))\s+available\b/i;
const HUMAN_AUTHORITY =
  /\b(?:human|person|receptionist|manager|owner|staff member|take over|speak to|talk to|call me)\b/i;
const HIGH_CONSEQUENCE =
  /\b(?:complaint|unhappy|refund|compensation|damage|damaged|destroyed|burn|burning|pain|allergy|allergic|swelling|rash|hair loss|lawyer|legal|cctv|privacy|pdpa|delete my data|chargeback)\b/i;
const PRICE_TERMS = /\b(?:price|prices|pricing|cost|how much|gst)\b/i;

const TANGLIN = /\btanglin(?: mall)?\b/i;
const SENTOSA = /\b(?:sentosa(?: cove)?|quayside(?: isle)?)\b/i;

function noMatch(reason: string): ServiceInformationAssessment {
  return { matched: false, reply: null, reason, sourceIds: [] };
}

function requestsLiveAvailability(message: string): boolean {
  if (!AVAILABILITY_TERMS.test(message)) return false;
  return (
    SCHEDULE_AVAILABILITY_REQUEST.test(message) ||
    DATE_OR_TIME.test(message) ||
    NAMED_STYLIST_AVAILABILITY.test(message)
  );
}

function curlyServiceReply(message: string): string {
  if (TANGLIN.test(message)) {
    return "Yes. Hera’s Tanglin Mall atelier offers specialist curly haircuts for waves, curls and coils, with curl-defining and hydration care available where suitable. For the most accurate stylist match, share a current hair photo and the shape or concern you would like us to address.";
  }
  if (SENTOSA.test(message)) {
    return "Yes. Hera’s Quayside Isle, Sentosa Cove atelier offers specialist curly haircuts for waves, curls and coils, with curl-defining and hydration care available where suitable. For the most accurate stylist match, share a current hair photo and the shape or concern you would like us to address.";
  }
  return "Yes. Hera offers specialist curly haircuts at both Tanglin Mall and Quayside Isle, Sentosa Cove, with curl-defining and hydration care available where suitable. Share a current hair photo and the shape or concern you would like us to address, and we’ll guide you to the most suitable curl specialist.";
}

function curlySpecialistReply(): string {
  return "Among Hera’s team members specifically profiled for curl work, Alina is Rëzocut-certified and known for curl architecture; Phoeve is REZO Cut and Cadō Academy certified; and Irene is known for precision cutting and curl transformations. The most suitable match depends on your curl pattern, desired shape and maintenance preferences; live schedules and atelier assignments still need confirmation.";
}

export function assessServiceInformation(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
}): ServiceInformationAssessment {
  const message = input.message
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return noMatch("No current client message was supplied.");
  if (
    input.policy.risk !== "green" ||
    input.policy.requiresIncident ||
    input.policy.requiresManagementNotification ||
    input.decision.requiresManagementNotification
  ) {
    return noMatch("Higher-consequence policy handling takes precedence.");
  }
  if (
    EXPLICIT_BOOKING_ACTION.test(message) ||
    SERVICE_ACTION_REQUEST.test(message) ||
    requestsLiveAvailability(message) ||
    HUMAN_AUTHORITY.test(message) ||
    HIGH_CONSEQUENCE.test(message) ||
    PRICE_TERMS.test(message)
  ) {
    return noMatch(
      "The current turn requests an action, authority or additional answer beyond pure service information.",
    );
  }
  if (!CURL_TERMS.test(message)) {
    return noMatch("The current turn is not a curly-service information question.");
  }

  if (SPECIALIST_MATCH.test(message)) {
    return {
      matched: true,
      reply: curlySpecialistReply(),
      reason:
        "Answered a pure curl-specialist matching question from the operator-approved service matrix.",
      sourceIds: [CURL_SERVICE_SOURCE_ID],
    };
  }

  if (!SERVICE_TERMS.test(message)) {
    return noMatch("The current turn does not ask whether Hera provides a curly service.");
  }

  return {
    matched: true,
    reply: curlyServiceReply(message),
    reason:
      "Answered a pure curly-service-at-outlet question directly from the operator-approved service matrix.",
    sourceIds: [CURL_SERVICE_SOURCE_ID],
  };
}
