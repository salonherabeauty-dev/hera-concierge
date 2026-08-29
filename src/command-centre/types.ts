import type { JsonValue, RiskLevel } from "../types.js";

export const COMMAND_CENTRE_ROLES = [
  "owner",
  "managing_director",
  "salon_manager",
  "receptionist",
  "technical_lead",
  "finance_admin",
  "privacy_officer",
  "auditor",
] as const;
export type CommandCentreRole = (typeof COMMAND_CENTRE_ROLES)[number];

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

export const HANDOFF_STATUSES = [
  "new",
  "assigned",
  "accepted",
  "waiting_client",
  "waiting_internal",
  "resolved",
  "cancelled",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface CommandCentreStaff {
  userId: string;
  email: string;
  displayName: string;
  role: CommandCentreRole;
  outletScope: string[];
  status: "active" | "suspended" | "disabled";
  permissions: JsonValue;
}

export interface CommandCentreSession {
  staff: CommandCentreStaff;
  csrfToken: string;
}

export interface HandoffTaskSummary {
  id: string;
  conversationId: string;
  sourceMessageId: string | null;
  incidentId: string | null;
  taskType: HandoffTaskType;
  scope: HandoffScope;
  priority: HandoffPriority;
  status: HandoffStatus;
  assignedRole: Exclude<CommandCentreRole, "auditor"> | null;
  assignedOutlet: string | null;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  summary: string;
  requestedAction: string;
  collectedFacts: JsonValue;
  missingFacts: JsonValue;
  clientVisibleStatus: string | null;
  dueAt: string | null;
  acceptedAt: string | null;
  resolvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  clientDisplayName: string;
  phoneEnding: string;
  conversationRisk: RiskLevel;
  conversationMode: "ai" | "management";
  lastMessagePreview: string;
  lastMessageAt: string;
  overdue: boolean;
}

export interface ConversationSummary {
  id: string;
  contactId: string;
  clientDisplayName: string;
  phoneEnding: string;
  preferredLanguage: string | null;
  status: "active" | "paused" | "resolved" | "blocked";
  operatingMode: "ai" | "management";
  currentRisk: RiskLevel;
  humanTakeoverUntil: string | null;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageDirection: "inbound" | "outbound" | null;
  openTaskCount: number;
  highestPriority: HandoffPriority | null;
}

export interface ConversationMessageView {
  id: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string;
  aiGenerated: boolean;
  deliveryStatus: string;
  providerTimestamp: string | null;
  createdAt: string;
  media: JsonValue | null;
}

export interface CommandCentreNoteView {
  id: string;
  body: string;
  authorDisplayName: string;
  createdAt: string;
}

export interface IncidentView {
  id: string;
  category: string;
  severity: Exclude<RiskLevel, "green">;
  status: string;
  clientSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateReplyView {
  id: string;
  sourceMessageId: string | null;
  text: string;
  status: string;
  authorization: string;
  providerMessageId: string | null;
  createdAt: string;
}

export interface DecisionTraceView {
  id: string;
  sourceMessageId: string;
  stage: "response" | "verification" | "policy";
  modelId: string | null;
  promptVersion: string;
  policyVersion: string;
  risk: RiskLevel;
  confidence: number;
  output: JsonValue;
  latencyMs: number | null;
  createdAt: string;
}

export interface ConversationJobView {
  id: string;
  sourceMessageId: string;
  status: "pending" | "processing" | "retry" | "completed" | "dead";
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingContextView {
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

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: ConversationMessageView[];
  tasks: HandoffTaskSummary[];
  notes: CommandCentreNoteView[];
  incidents: IncidentView[];
  candidates: CandidateReplyView[];
  decisions: DecisionTraceView[];
  jobs: ConversationJobView[];
  bookings: BookingContextView[];
}

export interface CommandCentreDashboard {
  generatedAt: string;
  mode: "shadow" | "pilot" | "live";
  readiness: "healthy" | "attention" | "critical";
  counts: {
    needsAction: number;
    overdueTasks: number;
    humanHandling: number;
    aiHandling: number;
    waitingClient: number;
    waitingInternal: number;
    openIncidents: number;
    criticalIncidents: number;
    activeJobs: number;
    deadJobs: number;
    activeOutbox: number;
    deadOutbox: number;
    providerSends: number;
  };
  quality: {
    eligibleCases: number;
    humanReviewedCases: number;
    launchMetricCases: number;
    passCases: number;
    failCases: number;
    needsReviewCases: number;
    passRate: number;
  };
  priorityTasks: HandoffTaskSummary[];
  recentConversations: ConversationSummary[];
  recentAudit: Array<{
    id: string;
    eventType: string;
    targetType: string;
    targetId: string | null;
    actorId: string | null;
    createdAt: string;
    details: JsonValue;
  }>;
}

export interface CreateHandoffTaskInput {
  conversationId: string;
  sourceMessageId?: string | null;
  incidentId?: string | null;
  taskType: HandoffTaskType;
  scope: HandoffScope;
  priority: HandoffPriority;
  assignedRole?: Exclude<CommandCentreRole, "auditor"> | null;
  assignedOutlet?: string | null;
  summary: string;
  requestedAction: string;
  collectedFacts?: JsonValue;
  missingFacts?: JsonValue;
  clientVisibleStatus?: string | null;
  dueAt?: string | null;
  dedupeKey: string;
}
