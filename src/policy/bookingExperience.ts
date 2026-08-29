import type { AgentDecision, AgentIntent } from "../types.js";

const BOOKING_INTENTS = new Set<AgentIntent>([
  "booking",
  "availability",
  "appointment_change",
]);

export const TANGLIN_WHATSAPP_CHANNEL_RULE = [
  "This WhatsApp channel is exclusively for Hera Hair Beauty at Tanglin Mall.",
  "Treat Tanglin Mall as verified channel context for every inbound client message on this number, including booking, appointment-change, complaint, refund, safety and general-service conversations.",
  "Never ask which outlet or atelier the client visited or prefers, never offer Tanglin Mall versus Sentosa, and never route this channel's client response to Sentosa Cove or Quayside Isle.",
  "When an outlet fact or assigned outlet is required, use Tanglin Mall without making the client repeat it.",
  "A client may ask a general informational question about Sentosa, but that does not change the ownership of this Tanglin Mall WhatsApp conversation.",
].join(" ");

export const BOOKING_OWNERSHIP_PRINCIPLE = [
  TANGLIN_WHATSAPP_CHANNEL_RULE,
  "For booking, availability and appointment-change requests, lead with a positive acknowledgement and ownership of the next useful step.",
  "Ask only the single missing detail needed next, using the service, stylist, Tanglin Mall outlet, date and time already supplied or established by the channel.",
  "Do not open with a system limitation and do not push a generic booking link when one focused question can progress the request.",
  "Use the booking link only when the client asks to self-book or when it is the clearest verified next step.",
  "Qualify availability or completion as subject to live system confirmation, and never claim a booking was created, changed or confirmed without tool evidence.",
].join(" ");

export const BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE = [
  TANGLIN_WHATSAPP_CHANNEL_RULE,
  "Reject any reply or handoff that asks the client which outlet or atelier, offers a choice between Tanglin Mall and Sentosa, assigns the conversation to Sentosa, or treats the outlet as missing; the verified outlet for this channel is Tanglin Mall.",
  "For booking, availability and appointment-change replies, reject a response that opens with inability, exposes a system limitation before helping, repeats details already supplied, or pushes a generic booking link before asking the one genuinely missing detail.",
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
