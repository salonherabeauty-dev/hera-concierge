import type { AgentDecision, AgentIntent } from "../types.js";

const BOOKING_INTENTS = new Set<AgentIntent>([
  "booking",
  "availability",
  "appointment_change",
]);

export const BOOKING_OWNERSHIP_PRINCIPLE = [
  "For booking, availability and appointment-change requests, lead with a positive acknowledgement and ownership of the next useful step.",
  "Ask only the single missing detail needed next, using the service, stylist, outlet, date and time already supplied in the conversation.",
  "Do not open with a system limitation and do not push a generic booking link when one focused question can progress the request.",
  "Use the booking link only when the client asks to self-book or when it is the clearest verified next step.",
  "Qualify availability or completion as subject to live system confirmation, and never claim a booking was created, changed or confirmed without tool evidence.",
].join(" ");

export const BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE = [
  "For booking, availability and appointment-change replies, reject a response that opens with inability, exposes a system limitation before helping, repeats details already supplied, or pushes a generic booking link before asking the one missing detail.",
  "A compliant reply begins with calm ownership, asks only the focused detail needed next, reduces client effort and keeps any availability or completion subject to live system confirmation.",
].join(" ");

export function isBookingIntent(intent: AgentIntent): boolean {
  return BOOKING_INTENTS.has(intent);
}

export function bookingDecisionRequiresApprovedEvidence(
  decision: AgentDecision,
): boolean {
  if (!isBookingIntent(decision.intent)) return false;

  return (
    decision.factualBasis.includes("approved_hera_source") ||
    decision.factualBasis.includes("current_client_record") ||
    decision.proposedActions.includes("share_booking_link") ||
    /https?:\/\//i.test(decision.reply)
  );
}
