import { createClient } from "@supabase/supabase-js";
import type {
  ConversationMessage,
  InboundMessage,
  JsonValue,
  StoredMessage,
} from "../types.js";
import type {
  ResetClaimedDraft,
  ResetConversationState,
  ResetDraftContext,
  ResetDraftRecord,
  ResetIngestResult,
  ResetTurnRecord,
} from "./types.js";

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reset database returned an invalid row");
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Reset database returned an invalid row set");
  return value.map(row);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Reset database row is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requiredNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Reset database row has invalid ${field}`);
  }
  return number;
}

function requireData<T>(
  data: T | null,
  error: { message: string } | null,
  operation: string,
): T {
  if (error) throw new Error(`${operation}: ${error.message}`);
  if (data === null) throw new Error(`${operation}: no data returned`);
  return data;
}

function jsonObject(value: unknown): JsonValue {
  if (!value || typeof value !== "object") return {};
  return value as JsonValue;
}

function jsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function turnRecord(value: unknown): ResetTurnRecord {
  const item = row(value);
  const status = requiredString(item.status, "turn.status") as ResetTurnRecord["status"];
  return {
    id: requiredString(item.id, "turn.id"),
    conversationId: requiredString(item.conversation_id, "turn.conversation_id"),
    contactId: requiredString(item.contact_id, "turn.contact_id"),
    version: requiredNumber(item.version, "turn.version"),
    status,
    deliveryControl: "human_only",
    fragmentIds: Array.isArray(item.fragment_ids)
      ? item.fragment_ids.filter((id): id is string => typeof id === "string")
      : [],
    assembledText: typeof item.assembled_text === "string" ? item.assembled_text : "",
    attachments: jsonArray(item.attachments),
    firstFragmentAt: requiredString(item.first_fragment_at, "turn.first_fragment_at"),
    lastFragmentAt: requiredString(item.last_fragment_at, "turn.last_fragment_at"),
    settleAt: requiredString(item.settle_at, "turn.settle_at"),
    supersededByTurnId: optionalString(item.superseded_by_turn_id),
    createdAt: requiredString(item.created_at, "turn.created_at"),
    updatedAt: requiredString(item.updated_at, "turn.updated_at"),
  };
}

function draftRecord(value: unknown): ResetDraftRecord {
  const item = row(value);
  return {
    id: requiredString(item.id, "draft.id"),
    turnId: requiredString(item.turn_id, "draft.turn_id"),
    generation: requiredNumber(item.generation, "draft.generation"),
    status: requiredString(item.status, "draft.status") as ResetDraftRecord["status"],
    origin: item.origin === "human_manual" ? "human_manual" : "ai",
    candidateText: optionalString(item.candidate_text),
    candidateHash: optionalString(item.candidate_hash),
    replyRequired:
      typeof item.reply_required === "boolean" ? item.reply_required : null,
    modelId: optionalString(item.model_id),
    modelCalls: requiredNumber(item.model_calls, "draft.model_calls"),
    rewriteUsed: item.rewrite_used === true,
    evidence: jsonArray(item.evidence),
    validationIssues: jsonArray(item.validation_issues),
    modelMetadata: jsonObject(item.model_metadata),
    failureCode: optionalString(item.failure_code),
    failureMessage: optionalString(item.failure_message),
    processAttempts: requiredNumber(item.process_attempts, "draft.process_attempts"),
    availableAt: requiredString(item.available_at, "draft.available_at"),
    lockedAt: optionalString(item.locked_at),
    completedAt: optionalString(item.completed_at),
    createdAt: requiredString(item.created_at, "draft.created_at"),
    updatedAt: requiredString(item.updated_at, "draft.updated_at"),
  };
}

function storedMessage(value: unknown): StoredMessage {
  const item = row(value);
  return {
    id: requiredString(item.id, "message.id"),
    conversationId: requiredString(item.conversation_id, "message.conversation_id"),
    contactId: requiredString(item.contact_id, "message.contact_id"),
    providerMessageId: optionalString(item.provider_message_id),
    direction: item.direction === "outbound" ? "outbound" : "inbound",
    kind: requiredString(item.kind, "message.kind") as StoredMessage["kind"],
    text: typeof item.text_body === "string" ? item.text_body : "",
    media: (item.media ?? null) as StoredMessage["media"],
    providerTimestamp: optionalString(item.provider_timestamp),
    createdAt: requiredString(item.created_at, "message.created_at"),
  };
}

function effectiveTime(message: StoredMessage): number {
  const provider = message.providerTimestamp
    ? Date.parse(message.providerTimestamp)
    : Number.NaN;
  const created = Date.parse(message.createdAt);
  return Number.isFinite(provider) ? provider : created;
}

function rpcResult(value: unknown, operation: string): Record<string, unknown> {
  const result = row(value);
  if (result.ok === false) {
    throw new Error(`${operation}:${optionalString(result.code) ?? optionalString(result.state) ?? "blocked"}`);
  }
  return result;
}

export class ResetReceptionistRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-receptionist-reset/1.0" } },
    });
  }

  async ingestInbound(message: InboundMessage): Promise<ResetIngestResult> {
    const { data, error } = await this.database.rpc(
      "ai_reset_ingest_whatsapp_message",
      {
        p_provider_message_id: message.providerMessageId,
        p_wa_id: message.fromWaId,
        p_profile_name: message.profileName ?? null,
        p_phone_number_id: message.phoneNumberId ?? null,
        p_business_account_id: message.businessAccountId ?? null,
        p_kind: message.kind,
        p_text: message.text,
        p_media: message.media ?? null,
        p_context_message_id: message.contextMessageId ?? null,
        p_provider_timestamp: message.providerTimestamp,
        p_raw: message.raw,
      },
    );
    const result = row(requireData(data, error, "reset ingest inbound"));
    return {
      inserted: result.inserted === true,
      messageId: requiredString(result.messageId, "messageId"),
      conversationId: requiredString(result.conversationId, "conversationId"),
      contactId: requiredString(result.contactId, "contactId"),
      turnId: optionalString(result.turnId),
      draftRunId: optionalString(result.draftRunId),
    };
  }

  async noteHumanOutbound(input: {
    conversationId: string;
    messageId: string;
    providerTimestamp: string;
  }): Promise<void> {
    const { error } = await this.database.rpc("ai_reset_note_human_outbound", {
      p_conversation_id: input.conversationId,
      p_message_id: input.messageId,
      p_provider_timestamp: input.providerTimestamp,
    });
    if (error) throw new Error(`reset note human outbound: ${error.message}`);
  }

  async reconcileTimeouts(): Promise<number> {
    const { data, error } = await this.database.rpc("ai_reset_reconcile_timeouts");
    if (error) throw new Error(`reset reconcile timeouts: ${error.message}`);
    return Number(data ?? 0);
  }

  async claimDrafts(workerId: string, limit = 3): Promise<ResetClaimedDraft[]> {
    const { data, error } = await this.database.rpc("ai_reset_claim_draft_runs", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    return rows(requireData(data, error, "reset claim drafts")).map((item) => ({
      draftRunId: requiredString(item.draft_run_id, "draft_run_id"),
      turnId: requiredString(item.turn_id, "turn_id"),
    }));
  }

  async loadDraftContext(draftRunId: string): Promise<ResetDraftContext> {
    const draftResult = await this.database
      .from("ai_reset_draft_runs")
      .select("*")
      .eq("id", draftRunId)
      .single();
    const draft = draftRecord(
      requireData(draftResult.data, draftResult.error, "load reset draft"),
    );

    const turnResult = await this.database
      .from("ai_reset_client_turns")
      .select("*")
      .eq("id", draft.turnId)
      .single();
    const turn = turnRecord(
      requireData(turnResult.data, turnResult.error, "load reset turn"),
    );

    const [contactResult, conversationResult, fragmentsResult, historyResult] =
      await Promise.all([
        this.database
          .from("ai_contacts")
          .select("id,wa_id,profile_name,preferred_language")
          .eq("id", turn.contactId)
          .single(),
        this.database
          .from("ai_conversations")
          .select("id,operating_mode,current_risk,last_message_at")
          .eq("id", turn.conversationId)
          .single(),
        this.database
          .from("ai_messages")
          .select(
            "id,conversation_id,contact_id,provider_message_id,direction,kind,text_body,media,provider_timestamp,created_at",
          )
          .in("id", turn.fragmentIds),
        this.database
          .from("ai_messages")
          .select(
            "id,conversation_id,contact_id,provider_message_id,direction,kind,text_body,media,provider_timestamp,created_at",
          )
          .eq("conversation_id", turn.conversationId)
          .order("created_at", { ascending: false })
          .limit(80),
      ]);

    const contact = row(
      requireData(contactResult.data, contactResult.error, "load reset contact"),
    );
    const conversation = row(
      requireData(
        conversationResult.data,
        conversationResult.error,
        "load reset conversation",
      ),
    );
    const fragments = rows(
      requireData(fragmentsResult.data, fragmentsResult.error, "load reset fragments"),
    )
      .map(storedMessage)
      .sort((left, right) => effectiveTime(left) - effectiveTime(right));

    const fragmentIds = new Set(turn.fragmentIds);
    const lastTurnTime = Date.parse(turn.lastFragmentAt);
    const history: ConversationMessage[] = rows(
      requireData(historyResult.data, historyResult.error, "load reset history"),
    )
      .map(storedMessage)
      .filter(
        (message) =>
          !fragmentIds.has(message.id) &&
          effectiveTime(message) <= lastTurnTime &&
          message.text.trim(),
      )
      .sort((left, right) => effectiveTime(left) - effectiveTime(right))
      .slice(-20)
      .map((message) => ({
        id: message.id,
        direction: message.direction,
        kind: message.kind,
        text: message.text,
        createdAt: message.createdAt,
      }));

    return {
      draft,
      turn,
      contact: {
        id: requiredString(contact.id, "contact.id"),
        waId: requiredString(contact.wa_id, "contact.wa_id"),
        profileName: optionalString(contact.profile_name),
        preferredLanguage: optionalString(contact.preferred_language),
      },
      conversation: {
        id: requiredString(conversation.id, "conversation.id"),
        operatingMode:
          conversation.operating_mode === "management" ? "management" : "ai",
        currentRisk: requiredString(
          conversation.current_risk,
          "conversation.current_risk",
        ) as ResetDraftContext["conversation"]["currentRisk"],
        lastMessageAt: requiredString(
          conversation.last_message_at,
          "conversation.last_message_at",
        ),
      },
      fragments,
      history,
    };
  }

  async markReady(input: {
    draftRunId: string;
    turnId: string;
    turnVersion: number;
    candidateText: string;
    replyRequired: boolean;
    modelId: string;
    modelCalls: number;
    rewriteUsed: boolean;
    evidence: JsonValue;
    validationIssues: JsonValue;
    modelMetadata: JsonValue;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc("ai_reset_mark_draft_ready", {
      p_draft_run_id: input.draftRunId,
      p_turn_id: input.turnId,
      p_turn_version: input.turnVersion,
      p_candidate_text: input.candidateText,
      p_reply_required: input.replyRequired,
      p_model_id: input.modelId,
      p_model_calls: input.modelCalls,
      p_rewrite_used: input.rewriteUsed,
      p_evidence: input.evidence,
      p_validation_issues: input.validationIssues,
      p_model_metadata: input.modelMetadata,
    });
    return rpcResult(requireData(data, error, "reset mark ready"), "reset_mark_ready");
  }

  async markFailed(input: {
    draftRunId: string;
    turnId: string;
    turnVersion: number;
    failureCode: string;
    failureMessage: string;
    modelCalls: number;
    modelMetadata: JsonValue;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc("ai_reset_mark_draft_failed", {
      p_draft_run_id: input.draftRunId,
      p_turn_id: input.turnId,
      p_turn_version: input.turnVersion,
      p_failure_code: input.failureCode,
      p_failure_message: input.failureMessage,
      p_model_calls: input.modelCalls,
      p_model_metadata: input.modelMetadata,
    });
    return rpcResult(requireData(data, error, "reset mark failed"), "reset_mark_failed");
  }

  async listStates(conversationIds: string[]): Promise<ResetConversationState[]> {
    const unique = [...new Set(conversationIds.filter(Boolean))].slice(0, 300);
    if (unique.length === 0) return [];
    await this.reconcileTimeouts();

    const turnsResult = await this.database
      .from("ai_reset_client_turns")
      .select("*")
      .in("conversation_id", unique)
      .neq("status", "superseded")
      .order("version", { ascending: false });
    const turns = rows(
      requireData(turnsResult.data, turnsResult.error, "list reset turns"),
    ).map(turnRecord);
    const latestByConversation = new Map<string, ResetTurnRecord>();
    for (const turn of turns) {
      if (!latestByConversation.has(turn.conversationId)) {
        latestByConversation.set(turn.conversationId, turn);
      }
    }

    const turnIds = [...latestByConversation.values()].map((turn) => turn.id);
    const draftsByTurn = new Map<string, ResetDraftRecord>();
    if (turnIds.length > 0) {
      const draftsResult = await this.database
        .from("ai_reset_draft_runs")
        .select("*")
        .in("turn_id", turnIds)
        .order("generation", { ascending: false });
      for (const draft of rows(
        requireData(draftsResult.data, draftsResult.error, "list reset drafts"),
      ).map(draftRecord)) {
        if (!draftsByTurn.has(draft.turnId)) draftsByTurn.set(draft.turnId, draft);
      }
    }

    return unique.map((conversationId) => {
      const turn = latestByConversation.get(conversationId) ?? null;
      return {
        conversationId,
        turn,
        draft: turn ? draftsByTurn.get(turn.id) ?? null : null,
      };
    });
  }

  async getState(conversationId: string): Promise<ResetConversationState> {
    return (
      await this.listStates([conversationId])
    )[0] ?? { conversationId, turn: null, draft: null };
  }

  async requestRegeneration(input: {
    actorUserId: string;
    turnId: string;
    expectedCandidateHash: string | null;
    expectedPhoneEnding: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc(
      "ai_reset_request_regeneration",
      {
        p_actor_user_id: input.actorUserId,
        p_turn_id: input.turnId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    return rpcResult(
      requireData(data, error, "request reset regeneration"),
      "reset_regenerate",
    );
  }

  async createManualCandidate(input: {
    actorUserId: string;
    turnId: string;
    expectedPhoneEnding: string;
    messageText: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc(
      "ai_reset_create_manual_candidate",
      {
        p_actor_user_id: input.actorUserId,
        p_turn_id: input.turnId,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_message_text: input.messageText,
      },
    );
    return rpcResult(
      requireData(data, error, "create reset manual candidate"),
      "reset_manual_candidate",
    );
  }

  async holdCandidate(input: {
    actorUserId: string;
    draftRunId: string;
    expectedCandidateHash: string;
    expectedPhoneEnding: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc("ai_reset_hold_candidate", {
      p_actor_user_id: input.actorUserId,
      p_draft_run_id: input.draftRunId,
      p_expected_candidate_hash: input.expectedCandidateHash,
      p_expected_phone_ending: input.expectedPhoneEnding,
    });
    return rpcResult(requireData(data, error, "hold reset candidate"), "reset_hold");
  }

  async reserveHumanSend(input: {
    actorUserId: string;
    draftRunId: string;
    expectedTurnId: string;
    expectedCandidateHash: string;
    expectedPhoneEnding: string;
    finalText: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc(
      "ai_reset_reserve_human_send",
      {
        p_actor_user_id: input.actorUserId,
        p_draft_run_id: input.draftRunId,
        p_expected_turn_id: input.expectedTurnId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
        p_final_text: input.finalText,
      },
    );
    return rpcResult(
      requireData(data, error, "reserve reset human send"),
      "reset_reserve_send",
    );
  }

  async completeHumanSend(input: {
    actorUserId: string;
    sendId: string;
    providerMessageId: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc(
      "ai_reset_complete_human_send",
      {
        p_actor_user_id: input.actorUserId,
        p_send_id: input.sendId,
        p_provider_message_id: input.providerMessageId,
      },
    );
    return rpcResult(
      requireData(data, error, "complete reset human send"),
      "reset_complete_send",
    );
  }

  async failHumanSend(input: {
    actorUserId: string;
    sendId: string;
    failureCode: string;
  }): Promise<void> {
    const { error } = await this.database.rpc("ai_reset_fail_human_send", {
      p_actor_user_id: input.actorUserId,
      p_send_id: input.sendId,
      p_failure_code: input.failureCode,
    });
    if (error) throw new Error(`fail reset human send: ${error.message}`);
  }

  async audit(
    eventType: string,
    targetType: string,
    targetId: string | null,
    details: JsonValue = {},
  ): Promise<void> {
    const { error } = await this.database.from("ai_audit_log").insert({
      actor_type: "system",
      actor_id: "hera_receptionist_reset",
      event_type: eventType,
      target_type: targetType,
      target_id: targetId,
      details,
    });
    if (error) throw new Error(`reset audit: ${error.message}`);
  }
}
