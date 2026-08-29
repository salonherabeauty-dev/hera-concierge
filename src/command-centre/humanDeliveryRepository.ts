import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { JsonValue, RiskLevel } from "../types.js";

export type HumanDeliveryEscalationRole =
  | "salon_manager"
  | "technical_lead"
  | "finance_admin"
  | "privacy_officer";

export interface HumanDeliveryQueueItem {
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
  canReject: boolean;
  canEscalate: boolean;
  approvalBlockReason: string | null;
}

export interface HumanDeliveryActionResult {
  ok: boolean;
  state: string;
  code: string | null;
  candidateId: string | null;
  approvedOutboxId: string | null;
  reviewId: string | null;
  conversationId: string | null;
  sourceMessageId: string | null;
  responseHash: string | null;
  phoneEnding: string | null;
  deliveryStatus: string | null;
  providerMessageId: string | null;
  details: JsonValue;
}

export interface HumanDeliverySendReservation
  extends HumanDeliveryActionResult {
  approvedOutboxId: string;
  reviewId: string;
  sourceMessageId: string;
  responseHash: string;
  phoneEnding: string;
  toWaId: string;
  messageText: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
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

function risk(value: unknown): RiskLevel {
  if (value === "amber" || value === "red" || value === "black") {
    return value;
  }
  return "green";
}

function actionResult(value: unknown): HumanDeliveryActionResult {
  const result = object(value, "human delivery action result");
  return {
    ok: result.ok === true,
    state: requiredString(result.state, "state"),
    code: optionalString(result.code),
    candidateId: optionalString(result.candidateId),
    approvedOutboxId: optionalString(result.approvedOutboxId),
    reviewId: optionalString(result.reviewId),
    conversationId: optionalString(result.conversationId),
    sourceMessageId: optionalString(result.sourceMessageId),
    responseHash: optionalString(result.responseHash),
    phoneEnding: optionalString(result.phoneEnding),
    deliveryStatus: optionalString(result.deliveryStatus),
    providerMessageId: optionalString(result.providerMessageId),
    details: (result.details ?? {}) as JsonValue,
  };
}

function sendReservation(value: unknown): HumanDeliverySendReservation {
  const result = object(value, "human delivery send reservation");
  const base = actionResult(result);
  if (!base.ok) {
    throw new Error("Cannot map a blocked human delivery reservation");
  }
  return {
    ...base,
    approvedOutboxId: requiredString(
      result.approvedOutboxId,
      "approvedOutboxId",
    ),
    reviewId: requiredString(result.reviewId, "reviewId"),
    sourceMessageId: requiredString(
      result.sourceMessageId,
      "sourceMessageId",
    ),
    responseHash: requiredString(result.responseHash, "responseHash"),
    phoneEnding: requiredString(result.phoneEnding, "phoneEnding"),
    toWaId: requiredString(result.toWaId, "toWaId"),
    messageText: requiredString(result.messageText, "messageText"),
  };
}

export class SupabaseHumanDeliveryRepository {
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
          "X-Client-Info": "hera-human-approved-delivery/2.0",
        },
      },
    });
  }

  async listQueue(input: {
    actorUserId: string;
    conversationId?: string | null;
    limit?: number;
  }): Promise<HumanDeliveryQueueItem[]> {
    const { data, error } = await this.database.rpc(
      "ai_cc_list_human_delivery_queue",
      {
        p_actor_user_id: input.actorUserId,
        p_conversation_id: input.conversationId ?? null,
        p_limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
      },
    );
    if (error) {
      throw new Error(
        `list human delivery review queue: ${error.message}`,
      );
    }

    return (Array.isArray(data) ? data : []).map((value) => {
      const row = object(value, "human delivery queue row");
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
        responseHash: requiredString(
          row.response_hash,
          "response_hash",
        ),
        candidateStatus: requiredString(
          row.candidate_status,
          "candidate_status",
        ),
        candidateCreatedAt: requiredString(
          row.candidate_created_at,
          "candidate_created_at",
        ),
        canApprove: row.can_approve === true,
        canReject: row.can_reject === true,
        canEscalate: row.can_escalate === true,
        approvalBlockReason: optionalString(
          row.approval_block_reason,
        ),
      } satisfies HumanDeliveryQueueItem;
    });
  }

  async reserveApproval(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedResponseHash: string;
    expectedPhoneEnding: string;
  }): Promise<HumanDeliveryActionResult | HumanDeliverySendReservation> {
    const { data, error } = await this.database.rpc(
      "ai_cc_reserve_human_delivery_send",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_response_hash: input.expectedResponseHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) {
      throw new Error(
        `reserve human delivery send: ${error.message}`,
      );
    }
    const mapped = actionResult(data);
    return mapped.ok && mapped.state === "send_reserved"
      ? sendReservation(data)
      : mapped;
  }

  async preflight(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    expectedSourceMessageId: string;
    expectedResponseHash: string;
    expectedPhoneEnding: string;
  }): Promise<HumanDeliveryActionResult | HumanDeliverySendReservation> {
    const { data, error } = await this.database.rpc(
      "ai_cc_preflight_human_delivery_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_response_hash: input.expectedResponseHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) {
      throw new Error(
        `preflight human delivery send: ${error.message}`,
      );
    }
    const mapped = actionResult(data);
    return mapped.ok && mapped.state === "ready_to_send"
      ? sendReservation(data)
      : mapped;
  }

  async complete(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    providerMessageId: string;
  }): Promise<HumanDeliveryActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_complete_human_delivery_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_provider_message_id: input.providerMessageId,
      },
    );
    if (error) {
      throw new Error(
        `complete human delivery send: ${error.message}`,
      );
    }
    return actionResult(data);
  }

  async fail(input: {
    actorUserId: string;
    approvedOutboxId: string;
    reviewId: string;
    failureCode: string;
  }): Promise<HumanDeliveryActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_fail_human_delivery_send",
      {
        p_approved_outbox_id: input.approvedOutboxId,
        p_review_id: input.reviewId,
        p_actor_user_id: input.actorUserId,
        p_failure_code: input.failureCode,
      },
    );
    if (error) {
      throw new Error(`fail human delivery send: ${error.message}`);
    }
    return actionResult(data);
  }

  async reject(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedResponseHash: string;
    expectedPhoneEnding: string;
    reason: string;
  }): Promise<HumanDeliveryActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_reject_human_delivery_candidate",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_response_hash: input.expectedResponseHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_reason: input.reason,
      },
    );
    if (error) {
      throw new Error(
        `reject human delivery candidate: ${error.message}`,
      );
    }
    return actionResult(data);
  }

  async escalate(input: {
    actorUserId: string;
    candidateId: string;
    expectedSourceMessageId: string;
    expectedResponseHash: string;
    expectedPhoneEnding: string;
    escalationRole: HumanDeliveryEscalationRole;
    reason: string;
  }): Promise<HumanDeliveryActionResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_escalate_human_delivery_candidate",
      {
        p_candidate_outbox_id: input.candidateId,
        p_actor_user_id: input.actorUserId,
        p_expected_source_message_id: input.expectedSourceMessageId,
        p_expected_response_hash: input.expectedResponseHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_escalation_role: input.escalationRole,
        p_reason: input.reason,
      },
    );
    if (error) {
      throw new Error(
        `escalate human delivery candidate: ${error.message}`,
      );
    }
    return actionResult(data);
  }
}
