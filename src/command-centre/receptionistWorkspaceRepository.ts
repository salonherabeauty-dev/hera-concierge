import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { JsonValue, RiskLevel } from "../types.js";

export interface ReceptionistQueueItem {
  candidateId: string;
  conversationId: string;
  sourceMessageId: string;
  clientDisplayName: string;
  phoneEnding: string;
  risk: RiskLevel;
  clientMessage: string;
  candidateText: string;
  responseHash: string;
  candidateStatus: string;
  candidateCreatedAt: string;
  canApprove: boolean;
  approvalBlockReason: string | null;
}

export interface ReceptionistActionResult {
  ok: boolean;
  state: string;
  code: string | null;
  candidateId: string | null;
  approvedOutboxId: string | null;
  reviewId: string | null;
  conversationId: string | null;
  sourceMessageId: string | null;
  candidateHash: string | null;
  responseHash: string | null;
  phoneEnding: string | null;
  deliveryStatus: string | null;
  providerMessageId: string | null;
  editedByHuman: boolean;
  details: JsonValue;
}

export interface ReceptionistSendReservation
  extends ReceptionistActionResult {
  approvedOutboxId: string;
  reviewId: string;
  conversationId: string;
  sourceMessageId: string;
  candidateHash: string;
  responseHash: string;
  phoneEnding: string;
  toWaId: string;
  messageText: string;
}

export interface ReceptionistRegenerationResult {
  ok: boolean;
  state: string;
  code: string | null;
  candidateId: string | null;
  conversationId: string | null;
  sourceMessageId: string | null;
  jobId: string | null;
  details: JsonValue;
}

function risk(value: unknown): RiskLevel {
  if (value === "amber" || value === "red" || value === "black") {
    return value;
  }
  return "green";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function actionResult(value: unknown): ReceptionistActionResult {
  const result = record(value, "receptionist action result");
  return {
    ok: result.ok === true,
    state: requiredString(result.state, "state"),
    code: optionalString(result.code),
    candidateId: optionalString(result.candidateId),
    approvedOutboxId: optionalString(result.approvedOutboxId),
    reviewId: optionalString(result.reviewId),
    conversationId: optionalString(result.conversationId),
    sourceMessageId: optionalString(result.sourceMessageId),
    candidateHash: optionalString(result.candidateHash),
    responseHash: optionalString(result.responseHash),
    phoneEnding: optionalString(result.phoneEnding),
    deliveryStatus: optionalString(result.deliveryStatus),
    providerMessageId: optionalString(result.providerMessageId),
    editedByHuman: result.editedByHuman === true,
    details: (result.details ?? {}) as JsonValue,
  };
}

function sendReservation(value: unknown): ReceptionistSendReservation {
  const result = record(value, "receptionist send reservation");
  const mapped = actionResult(result);
  if (!mapped.ok) {
    throw new Error("Cannot map a blocked receptionist send reservation");
  }
  return {
    ...mapped,
    approvedOutboxId: requiredString(
      result.approvedOutboxId,
      "approvedOutboxId",
    ),
    reviewId: requiredString(result.reviewId, "reviewId"),
    conversationId: requiredString(result.conversationId, "conversationId"),
    sourceMessageId: requiredString(
      result.sourceMessageId,
      "sourceMessageId",
    ),
    candidateHash: requiredString(result.candidateHash, "candidateHash"),
    responseHash: requiredString(result.responseHash, "responseHash"),
    phoneEnding: requiredString(result.phoneEnding, "phoneEnding"),
    toWaId: requiredString(result.toWaId, "toWaId"),
    messageText: requiredString(result.messageText, "messageText"),
  };
}

function regenerationResult(
  value: unknown,
): ReceptionistRegenerationResult {
  const result = record(value, "receptionist regeneration result");
  return {
    ok: result.ok === true,
    state: requiredString(result.state, "state"),
    code: optionalString(result.code),
    candidateId: optionalString(result.candidateId),
    conversationId: optionalString(result.conversationId),
    sourceMessageId: optionalString(result.sourceMessageId),
    jobId: optionalString(result.jobId),
    details: (result.details ?? {}) as JsonValue,
  };
}

export class ReceptionistWorkspaceRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          "X-Client-Info": "hera-receptionist-workspace/1.0",
        },
      },
    });
  }

  async listQueue(input: {
    actorUserId: string;
    conversationId?: string | null;
    limit?: number;
  }): Promise<ReceptionistQueueItem[]> {
    const { data, error } = await this.database.rpc(
      "ai_cc_list_receptionist_queue",
      {
        p_actor_user_id: input.actorUserId,
        p_conversation_id: input.conversationId ?? null,
        p_limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
      },
    );
    if (error) {
      throw new Error(`list receptionist queue: ${error.message}`);
    }

    return (Array.isArray(data) ? data : []).map((value) => {
      const row = record(value, "receptionist queue row");
      return {
        candidateId: requiredString(
          row.candidate_outbox_id,
          "candidate_outbox_id",
        ),
        conversationId: requiredString(
          row.conversation_id,
          "conversation_id",
        ),
        sourceMessageId: requiredString(
          row.source_message_id,
          "source_message_id",
        ),
        clientDisplayName: requiredString(
          row.client_display_name,
          "client_display_name",
        ),
        phoneEnding: requiredString(row.phone_ending, "phone_ending"),
        risk: risk(row.risk),
        clientMessage: requiredString(
          row.client_message,
          "client_message",
        ),
        candidateText: requiredString(
          row.candidate_text,
          "candidate_text",
        ),
        responseHash: requiredString(row.response_hash, "response_hash"),
        candidateStatus: requiredString(
          row.candidate_status,
          "candidate_status",
        ),
        candidateCreatedAt: requiredString(
          row.candidate_created_at,
          "candidate_created_at",
        ),
        canApprove: row.can_send === true,
        approvalBlockReason: optionalString(row.block_reason),
      };
    });
  }

  async reserveSend(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedCandidateHash: string;
    expectedPhoneEnding: string;
    finalMessageText: string;
  }): Promise<ReceptionistActionResult | ReceptionistSendReservation> {
    const { data, error } = await this.database.rpc(
      "ai_cc_reserve_receptionist_send",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_final_message_text: input.finalMessageText,
      },
    );
    if (error) {
      throw new Error(`reserve receptionist send: ${error.message}`);
    }
    const mapped = actionResult(data);
    return mapped.ok && mapped.state === "send_reserved"
      ? sendReservation(data)
      : mapped;
  }

  async preflightSend(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    expectedSourceMessageId: string;
    expectedCandidateHash: string;
    expectedFinalHash: string;
    expectedPhoneEnding: string;
  }): Promise<ReceptionistActionResult | ReceptionistSendReservation> {
    const { data, error } = await this.database.rpc(
      "ai_cc_preflight_receptionist_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_final_hash: input.expectedFinalHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) {
      throw new Error(`preflight receptionist send: ${error.message}`);
    }
    const mapped = actionResult(data);
    return mapped.ok && mapped.state === "ready_to_send"
      ? sendReservation(data)
      : mapped;
  }

  async completeSend(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    providerMessageId: string;
  }): Promise<ReceptionistActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_complete_receptionist_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_provider_message_id: input.providerMessageId,
      },
    );
    if (error) {
      throw new Error(`complete receptionist send: ${error.message}`);
    }
    return actionResult(data);
  }

  async failSend(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    failureCode: string;
  }): Promise<ReceptionistActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_fail_receptionist_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_failure_code: input.failureCode,
      },
    );
    if (error) {
      throw new Error(`fail receptionist send: ${error.message}`);
    }
    return actionResult(data);
  }

  async hold(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedCandidateHash: string;
    expectedPhoneEnding: string;
  }): Promise<ReceptionistActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_reject_human_delivery_candidate",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_response_hash: input.expectedCandidateHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_reason:
          "Held for human handling from the simplified Hera Reception workspace.",
      },
    );
    if (error) {
      throw new Error(`hold receptionist conversation: ${error.message}`);
    }
    return actionResult(data);
  }

  async requestRegeneration(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedCandidateHash: string;
    expectedPhoneEnding: string;
  }): Promise<ReceptionistRegenerationResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_request_receptionist_regeneration",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) {
      throw new Error(`request receptionist regeneration: ${error.message}`);
    }
    return regenerationResult(data);
  }

  async recoverRegeneration(input: {
    actorUserId: string;
    jobId: string;
    reason: string;
  }): Promise<ReceptionistRegenerationResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_recover_receptionist_regeneration",
      {
        p_job_id: input.jobId,
        p_actor_user_id: input.actorUserId,
        p_reason: input.reason,
      },
    );
    if (error) {
      throw new Error(`recover receptionist regeneration: ${error.message}`);
    }
    return regenerationResult(data);
  }
}
