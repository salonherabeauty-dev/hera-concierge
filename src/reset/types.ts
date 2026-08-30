import type {
  BookingSummary,
  ConversationMessage,
  JsonValue,
  KnowledgeResult,
  StoredMessage,
} from "../types.js";

export type ResetTurnStatus =
  | "collecting"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "superseded";

export type ResetDraftStatus =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "superseded"
  | "held"
  | "sent";

export interface ResetIngestResult {
  inserted: boolean;
  messageId: string;
  conversationId: string;
  contactId: string;
  turnId: string | null;
  draftRunId: string | null;
}

export interface ResetClaimedDraft {
  draftRunId: string;
  turnId: string;
}

export interface ResetTurnRecord {
  id: string;
  conversationId: string;
  contactId: string;
  version: number;
  status: ResetTurnStatus;
  deliveryControl: "human_only";
  fragmentIds: string[];
  assembledText: string;
  attachments: JsonValue[];
  firstFragmentAt: string;
  lastFragmentAt: string;
  settleAt: string;
  supersededByTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResetDraftRecord {
  id: string;
  turnId: string;
  generation: number;
  status: ResetDraftStatus;
  origin: "ai" | "human_manual";
  candidateText: string | null;
  candidateHash: string | null;
  replyRequired: boolean | null;
  modelId: string | null;
  modelCalls: number;
  rewriteUsed: boolean;
  evidence: JsonValue[];
  validationIssues: JsonValue[];
  modelMetadata: JsonValue;
  failureCode: string | null;
  failureMessage: string | null;
  processAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResetContactContext {
  id: string;
  waId: string;
  profileName: string | null;
  preferredLanguage: string | null;
}

export interface ResetConversationContext {
  id: string;
  operatingMode: "ai" | "management";
  currentRisk: "green" | "amber" | "red" | "black";
  lastMessageAt: string;
}

export interface ResetDraftContext {
  draft: ResetDraftRecord;
  turn: ResetTurnRecord;
  contact: ResetContactContext;
  conversation: ResetConversationContext;
  fragments: StoredMessage[];
  history: ConversationMessage[];
}

export interface ResetEvidencePacket {
  queries: string[];
  knowledge: KnowledgeResult[];
  bookings: BookingSummary[];
  tanglinOnly: true;
  liveAvailabilityVerified: false;
  retrievalWarnings: string[];
}

export interface ResetModelDraft {
  replyRequired: boolean;
  finalReply: string;
  intent: string;
  currentEmergency: boolean;
  reviewPriority: "normal" | "care" | "urgent" | "emergency";
  requestedAction: string | null;
  factsStillMissing: string[];
  usedEvidenceIds: string[];
}

export interface ResetModelCallResult {
  output: ResetModelDraft;
  modelId: string;
  usage: JsonValue;
  latencyMs: number;
}

export interface ResetValidationResult {
  passed: boolean;
  issues: string[];
}

export interface ResetMaterializedTurn {
  text: string;
  attachments: Array<{
    type: "image" | "file";
    data: Uint8Array;
    mediaType: string;
    filename?: string;
  }>;
  warnings: string[];
  transcriptionCount: number;
}

export interface ResetConversationState {
  conversationId: string;
  turn: ResetTurnRecord | null;
  draft: ResetDraftRecord | null;
}
