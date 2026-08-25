import type { AgentDecision, PolicyAssessment } from "../types.js";

export const SERVICE_INFORMATION_POLICY_VERSION = "hera-service-information-1.0.0";
export const CURL_SERVICE_SOURCE_ID = "hera-operator-curly-service-matrix-v2";

export interface ServiceInformationAssessment {
  matched: boolean;
  reply: string | null;
  reason: string;
  sourceIds: string[];
}

const CURL_TERMS = /\b(?:curly|curl|curls|wavy|waves|coily|coils|textured hair)\b/i;
const SERVICE_TERMS = /\b(?:haircut|haircuts|cut|cuts|service|services|specialist|specialise|specialize|offer|offers|provide|provides|have|has|do)\b/i;
const SPECIALIST_MATCH = /(?:\b(?:who|which|recommend|recommended|best|most suitable|specialist|stylist)\b.{0,80}\b(?:curly|curl|curls|wavy|waves|coily|coils)\b|\b(?:curly|curl|curls|wavy|waves|coily|coils)\b.{0,80}\b(?:specialist|stylist|recommend|best|most suitable)\b)/i;
const BOOKING_OR_LIVE_ACTION = /\b(?:book|booking|appointment|reserve|reservation|schedule|slot|slots|available|availability|reschedule|cancel|change my appointment|today|tomorrow|this friday|this saturday|this sunday|next week|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
const HUMAN_AUTHORITY = /\b(?:human|person|receptionist|manager|owner|staff member|take over|speak to|talk to|call me)\b/i;
const HIGH_CONSEQUENCE = /\b(?:complaint|unhappy|refund|compensation|damage|damaged|burn|burning|pain|allergy|allergic|swelling|rash|hair loss|lawyer|legal|cctv|privacy|pdpa|delete my data|chargeback)\b/i;
const PRICE_TERMS = /\b(?:price|prices|pricing|cost|how much|gst)\b/i;

const TANGIN = /\btanglin(?: mall)?\b/i;
const SENTOSA = /\b(?:sentosa(?: cove)?|quayside(?: isle)?)\b/i;

function noMatch(reason: string): ServiceInformationAssessment {
  return { matched: false, reply: null, reason, sourceIds: [] };
}

function curlyServiceReply(message: string): string {
  if (TANGIN.test(message)) {
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
  const message = input.message.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
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
    BOOKING_OR_LIVE_ACTION.test(message) ||
    HUMAN_AUTHORITY.test(message) ||
    HIGH_CONSEQUENCE.test(message) ||
    PRICE_TERMS.test(message)
  ) {
    return noMatch("The current turn requests an action, authority or additional answer beyond pure service information.");
  }
  if (!CURL_TERMS.test(message)) {
    return noMatch("The current turn is not a curly-service information question.");
  }

  if (SPECIALIST_MATCH.test(message)) {
    return {
      matched: true,
      reply: curlySpecialistReply(),
      reason: "Answered a pure curl-specialist matching question from the operator-approved service matrix.",
      sourceIds: [CURL_SERVICE_SOURCE_ID],
    };
  }

  if (!SERVICE_TERMS.test(message)) {
    return noMatch("The current turn does not ask whether Hera provides a curly service.");
  }

  return {
    matched: true,
    reply: curlyServiceReply(message),
    reason: "Answered a pure curly-service-at-outlet question directly from the operator-approved service matrix.",
    sourceIds: [CURL_SERVICE_SOURCE_ID],
  };
}
