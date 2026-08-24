export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export const RISK_LEVELS = ["green", "amber", "red", "black"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const MESSAGE_KINDS = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "interactive",
  "button",
  "location",
  "contacts",
  "reaction",
  "order",
  "system",
  "unknown",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MediaReference {
  id: string;
  mimeType?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

export interface InboundMessage {
  providerMessageId: string;
  fromWaId: string;
  profileName?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  kind: MessageKind;
  text: string;
  media?: MediaReference;
  contextMessageId?: string;
  providerTimestamp: string;
  raw: JsonValue;
}

export interface WhatsAppStatusEvent {
  providerMessageId: string;
  recipientWaId?: string;
  status: "sent" | "delivered" | "read" | "failed" | "deleted" | "unknown";
  providerTimestamp: string;
  errors: JsonValue[];
  raw: JsonValue;
}

export interface ParsedWhatsAppWebhook {
  inbound: InboundMessage[];
  statuses: WhatsAppStatusEvent[];
}

export interface IngestResult {
  inserted: boolean;
  messageId: string;
  conversationId: string;
  contactId: string;
  jobId: string | null;
}

export interface ReceptionistJob {
  id: string;
  kind: "process_inbound";
  sourceMessageId: string;
  payload: JsonValue;
  attempts: number;
  maxAttempts: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  contactId: string;
  providerMessageId: string | null;
  direction: "inbound" | "outbound";
  kind: MessageKind;
  text: string;
  media: MediaReference | null;
  providerTimestamp: string | null;
  createdAt: string;
}

export interface ContactContext {
  id: string;
  waId: string;
  profileName: string | null;
  preferredLanguage: string | null;
}

export interface JobContext {
  job: ReceptionistJob;
  message: StoredMessage;
  contact: ContactContext;
  conversationRisk: RiskLevel;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  kind: MessageKind;
  text: string;
  createdAt: string;
}

export interface BookingSummary {
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

export interface KnowledgeResult {
  id: string;
  title: string;
  excerpt: string;
  sourceUrl: string | null;
  version: string;
  score: number;
}

export const AGENT_INTENTS = [
  "greeting",
  "booking",
  "availability",
  "pricing",
  "service_advice",
  "stylist_matching",
  "location_hours",
  "appointment_lookup",
  "appointment_change",
  "preconsultation",
  "complaint",
  "refund_compensation",
  "medical_safety",
  "privacy_legal",
  "media_followup",
  "other",
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

export const AGENT_ACTIONS = [
  "answer",
  "ask_clarifying_question",
  "share_booking_link",
  "request_photos",
  "request_appointment_details",
  "create_handoff_task",
  "open_incident",
  "notify_management",
  "urgent_safety_guidance",
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export const AGENT_FACTUAL_BASES = [
  "approved_hera_source",
  "current_client_record",
  "client_provided_fact",
  "deterministic_calculation",
  "general_hairdressing_knowledge",
  "safety_policy",
  "no_factual_claim",
] as const;
export type AgentFactualBasis = (typeof AGENT_FACTUAL_BASES)[number];


export const HANDOFF_TASK_TYPES = [
  "booking_action",
  "appointment_change",
  "arrival_issue",
  "group_booking",
  "complaint_review",
  "refund_finance",
  "medical_safety",
  "technical_review",
  "privacy_legal",
  "accessibility_arrangement",
  "consent_media",
  "lost_property",
  "client_requested_human",
  "security_review",
  "system_failure",
  "other",
] as const;
export type HandoffTaskType = (typeof HANDOFF_TASK_TYPES)[number];

export const HANDOFF_SCOPES = ["task_only", "full_takeover", "emergency"] as const;
export type HandoffScope = (typeof HANDOFF_SCOPES)[number];

export const HANDOFF_PRIORITIES = ["normal", "high", "urgent", "emergency"] as const;
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number];

export const HANDOFF_ASSIGNED_ROLES = [
  "owner",
  "managing_director",
  "salon_manager",
  "receptionist",
  "technical_lead",
  "finance_admin",
  "privacy_officer",
] as const;
export type HandoffAssignedRole = (typeof HANDOFF_ASSIGNED_ROLES)[number];

export const HANDOFF_FACT_KEYS = [
  "service",
  "stylist",
  "outlet",
  "date",
  "time",
  "flexibility",
  "appointmentReference",
  "desiredOutcome",
  "symptoms",
  "photos",
  "other",
] as const;
export type HandoffFactKey = (typeof HANDOFF_FACT_KEYS)[number];

export interface AgentHandoffFacts {
  service: string | null;
  stylist: string | null;
  outlet: string | null;
  date: string | null;
  time: string | null;
  flexibility: string | null;
  appointmentReference: string | null;
  desiredOutcome: string | null;
  symptoms: string | null;
  photos: string | null;
  other: string | null;
}

export interface AgentHandoffProposal {
  required: boolean;
  taskType: HandoffTaskType | null;
  scope: HandoffScope | null;
  priority: HandoffPriority | null;
  assignedRole: HandoffAssignedRole | null;
  assignedOutlet: string | null;
  summary: string | null;
  requestedAction: string | null;
  collectedFacts: AgentHandoffFacts;
  missingFacts: HandoffFactKey[];
  clientAcknowledgement: string | null;
}

export interface AutomaticHandoffInput {
  conversationId: string;
  sourceMessageId: string;
  taskType: HandoffTaskType;
  scope: HandoffScope;
  priority: HandoffPriority;
  assignedRole: HandoffAssignedRole | null;
  assignedOutlet: string | null;
  summary: string;
  requestedAction: string;
  collectedFacts: AgentHandoffFacts;
  missingFacts: HandoffFactKey[];
  clientVisibleStatus: string | null;
  dueAt?: string | null;
  dedupeKey: string;
}

export interface AutomaticHandoffResult {
  inserted: boolean;
  updated: boolean;
  taskId: string;
  status: string;
  version: number;
}

export interface SourceReference {
  id: string;
  title: string;
}

export interface AgentDecision {
  reply: string;
  intent: AgentIntent;
  risk: RiskLevel;
  confidence: number;
  language: string;
  sources: SourceReference[];
  factualBasis: AgentFactualBasis[];
  proposedActions: AgentAction[];
  requiresManagementNotification: boolean;
  handoff?: AgentHandoffProposal;
  rationale: string;
}

export interface PolicyAssessment {
  risk: RiskLevel;
  canAutoSend: boolean;
  requiresManagementNotification: boolean;
  requiresIncident: boolean;
  blockedActions: string[];
  securityFlags: string[];
  replyOverride: string | null;
}

export interface OutboxItem {
  id: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  toWaId: string;
  targetType: "client" | "management";
  body: string;
  dedupeKey: string;
  authorization: "auto" | "management";
  attempts: number;
  maxAttempts: number;
}

export interface OperationalSnapshot {
  activeJobs: number;
  deadJobs: number;
  activeOutbox: number;
  deadOutbox: number;
  openIncidents: number;
  blackIncidents: number;
  oldestActiveJobCreatedAt: string | null;
  oldestActiveOutboxCreatedAt: string | null;
}

export interface DrainSummary {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsRetried: number;
  outboxClaimed: number;
  outboxSent: number;
  outboxShadowed: number;
  outboxRetried: number;
  outboxDead: number;
}
