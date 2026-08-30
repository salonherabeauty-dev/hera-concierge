import type { JsonValue, MessageKind } from "../types.js";

export const RESET_TURN_STATUSES = [
  "collecting",
  "processing",
  "ready",
  "failed",
  "superseded",
] as const;

export type ResetTurnStatus = (typeof RESET_TURN_STATUSES)[number];

export interface ResetTurnFragment {
  messageId: string;
  kind: MessageKind;
  text: string | null;
  media: JsonValue | null;
  providerTimestamp: string;
  readable: boolean;
  rawType: string;
}

export interface ClaimedResetTurnJob {
  jobId: string;
  turnId: string;
  conversationId: string;
  contactId: string;
  version: number;
  sourceMessageId: string | null;
  lastFragmentMessageId: string;
  consolidatedText: string;
  fragments: ResetTurnFragment[];
  firstFragmentAt: string;
  lastFragmentAt: string;
  attempts: number;
}

export interface ResetTurnContact {
  id: string;
  waId: string;
  profileName: string | null;
  preferredLanguage: string | null;
}

export interface ResetConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  kind: MessageKind;
  text: string;
  createdAt: string;
}

export interface ResetKnowledgeEvidence {
  id: string;
  title: string;
  excerpt: string;
  sourceUrl: string | null;
  version: string;
  score: number;
  category: "service" | "price" | "staff" | "policy" | "authority";
}

export interface ResetAppointmentEvidence {
  id: string;
  clientName: string;
  serviceName: string;
  stylistName: string | null;
  locationName: string | null;
  appointmentAt: string;
  bookingStatus: string;
  price: number | null;
  currency: string;
}

export interface ResetEvidenceBundle {
  channel: "Tanglin Mall WhatsApp";
  outlet: "Tanglin Mall";
  turnId: string;
  turnVersion: number;
  client: {
    displayName: string | null;
    whatsappEnding: string;
  };
  consolidatedClientTurn: string;
  fragments: ResetTurnFragment[];
  recentConversation: ResetConversationMessage[];
  knowledge: ResetKnowledgeEvidence[];
  currentClientAppointments: ResetAppointmentEvidence[];
  authorityBoundaries: {
    mayDraft: true;
    maySendAutomatically: false;
    mayWriteTimely: false;
    mayConfirmLiveAvailability: false;
    mayConfirmBookingChangeWithoutVerifiedOutcome: false;
    mayApproveRefundOrCompensation: false;
    humanApprovalRequired: true;
  };
}

export const RESET_REVIEW_PRIORITIES = [
  "normal",
  "care",
  "urgent",
  "emergency",
] as const;

export type ResetReviewPriority = (typeof RESET_REVIEW_PRIORITIES)[number];

export const RESET_INTENTS = [
  "greeting",
  "service_information",
  "stylist_recommendation",
  "price_enquiry",
  "booking_enquiry",
  "appointment_change",
  "cancellation",
  "complaint",
  "refund_request",
  "medical_or_scalp_concern",
  "privacy_or_legal",
  "late_arrival",
  "image_or_attachment",
  "acknowledgement",
  "other",
] as const;

export type ResetIntent = (typeof RESET_INTENTS)[number];

export interface ResetDraftDecision {
  replyRecommended: boolean;
  finalReply: string;
  intent: ResetIntent;
  currentEmergency: boolean;
  currentEmergencyReason: string | null;
  reviewPriority: ResetReviewPriority;
  verifiedFactsUsed: Array<{
    sourceId: string;
    claim: string;
  }>;
  factsStillMissing: string[];
  rationaleSummary: string;
}

export interface ResetDraftValidation {
  passed: boolean;
  issues: string[];
  checkedAt: string;
  policyVersion: string;
}

export interface ResetDraftResult {
  decision: ResetDraftDecision;
  finalReply: string;
  modelId: string;
  modelAttempts: 1 | 2;
  evidence: ResetEvidenceBundle;
  validation: ResetDraftValidation;
  usage: JsonValue;
  latencyMs: number;
}

export interface ResetTurnSummary {
  conversationId: string;
  turnId: string | null;
  turnVersion: number | null;
  turnStatus: ResetTurnStatus | null;
  deliveryControl: "human_only" | null;
  candidateId: string | null;
  candidateText: string | null;
  candidateHash: string | null;
  candidateModelId: string | null;
  candidateModelAttempts: number | null;
  candidateStatus: "ready" | "superseded" | "rejected" | "sent" | null;
  failureCode: string | null;
  failureMessage: string | null;
  firstFragmentAt: string | null;
  lastFragmentAt: string | null;
  settleAt: string | null;
}
