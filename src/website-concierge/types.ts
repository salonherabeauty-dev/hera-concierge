import type { JsonValue } from "../types.js";

export const WEBSITE_CONCIERGE_OUTLETS = [
  "unspecified",
  "tanglin",
  "sentosa",
  "either",
] as const;

export type WebsiteConciergeOutlet =
  (typeof WEBSITE_CONCIERGE_OUTLETS)[number];

export const WEBSITE_CONCIERGE_INTENTS = [
  "greeting",
  "service_information",
  "hair_technical_guidance",
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
  "unrelated",
  "other",
] as const;

export type WebsiteConciergeIntent =
  (typeof WEBSITE_CONCIERGE_INTENTS)[number];

export const WEBSITE_CONCIERGE_ACTIONS = [
  "none",
  "book_online",
  "contact_tanglin",
  "contact_sentosa",
  "contact_management",
  "seek_urgent_medical_care",
] as const;

export type WebsiteConciergeAction =
  (typeof WEBSITE_CONCIERGE_ACTIONS)[number];

export interface WebsiteConciergeHistoryMessage {
  role: "visitor" | "concierge";
  body: string;
  createdAt: string;
}

export interface WebsiteConciergeKnowledgeEvidence {
  id: string;
  title: string;
  excerpt: string;
  sourceUrl: string | null;
  version: string;
  score: number;
  category: "service" | "price" | "staff" | "policy" | "authority";
  outletScope: WebsiteConciergeOutlet;
}

export interface WebsiteConciergeEvidenceBundle {
  channel: "Hera public website";
  visitorOutlet: WebsiteConciergeOutlet;
  outletClarificationOperationallyRelevant: boolean;
  visitorMessage: string;
  history: WebsiteConciergeHistoryMessage[];
  knowledge: WebsiteConciergeKnowledgeEvidence[];
  authorityBoundaries: {
    mayAnswerDirectly: true;
    maySendWhatsApp: false;
    mayWriteTimely: false;
    mayConfirmLiveAvailability: false;
    mayConfirmBookingOrAppointmentChange: false;
    mayApproveRefundOrCompensation: false;
    mayDiagnoseMedicalCondition: false;
  };
  contactOptions: {
    bookingUrl: string;
    tanglinPhone: string;
    tanglinWhatsAppUrl: string;
    sentosaPhone: string;
  };
}

export interface WebsiteConciergeDecision {
  reply: string;
  intent: WebsiteConciergeIntent;
  resolvedOutlet: WebsiteConciergeOutlet;
  needsOutletClarification: boolean;
  suggestedActions: WebsiteConciergeAction[];
  verifiedFactsUsed: Array<{
    sourceId: string;
    claim: string;
  }>;
  factsStillMissing: string[];
  rationaleSummary: string;
}

export interface WebsiteConciergeValidation {
  passed: boolean;
  issues: string[];
  policyVersion: string;
  checkedAt: string;
}

export interface WebsiteConciergeResult {
  decision: WebsiteConciergeDecision;
  reply: string;
  modelId: string;
  modelAttempts: 1 | 2;
  evidence: WebsiteConciergeEvidenceBundle;
  validation: WebsiteConciergeValidation;
  usage: JsonValue;
  latencyMs: number;
}
