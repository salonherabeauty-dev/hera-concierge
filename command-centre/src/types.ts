export type ViewName = "overview" | "tasks" | "conversations" | "quality" | "audit" | "settings";
export type Risk = "green" | "amber" | "red" | "black";
export type Priority = "normal" | "high" | "urgent" | "emergency";
export type TaskStatus = "new" | "assigned" | "accepted" | "waiting_client" | "waiting_internal" | "resolved" | "cancelled";

export interface Staff {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  outletScope: string[];
  status: string;
}

export interface Task {
  id: string;
  conversationId: string;
  taskType: string;
  scope: "task_only" | "full_takeover" | "emergency";
  priority: Priority;
  status: TaskStatus;
  assignedRole: string | null;
  assignedOutlet: string | null;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  summary: string;
  requestedAction: string;
  clientVisibleStatus: string | null;
  dueAt: string | null;
  version: number;
  clientDisplayName: string;
  phoneEnding: string;
  conversationRisk: Risk;
  conversationMode: "ai" | "management";
  lastMessagePreview: string;
  lastMessageAt: string;
  overdue: boolean;
  collectedFacts: unknown;
  missingFacts: unknown;
}

export interface Conversation {
  id: string;
  clientDisplayName: string;
  phoneEnding: string;
  preferredLanguage: string | null;
  status: string;
  operatingMode: "ai" | "management";
  currentRisk: Risk;
  humanTakeoverUntil: string | null;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageDirection: "inbound" | "outbound" | null;
  openTaskCount: number;
  highestPriority: Priority | null;
}

export interface ConversationMessage {
  id: string;
  direction: "inbound" | "outbound";
  kind: string;
  text: string;
  aiGenerated: boolean;
  deliveryStatus: string;
  providerTimestamp: string | null;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ConversationMessage[];
  tasks: Task[];
  notes: Array<{ id: string; body: string; authorDisplayName: string; createdAt: string }>;
  incidents: Array<{ id: string; category: string; severity: Risk; status: string; clientSummary: string; createdAt: string }>;
  candidates: Array<{ id: string; text: string; status: string; authorization: string; providerMessageId: string | null; createdAt: string }>;
}

export interface Dashboard {
  generatedAt: string;
  mode: "shadow" | "live";
  readiness: "healthy" | "attention" | "critical";
  counts: Record<string, number> & {
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
  priorityTasks: Task[];
  recentConversations: Conversation[];
  recentAudit: Array<{ id: string; eventType: string; targetType: string; actorId: string | null; createdAt: string }>;
}
