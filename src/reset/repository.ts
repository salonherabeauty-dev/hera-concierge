import { createClient } from "@supabase/supabase-js";
import {
  SupabaseReceptionistRepository,
  type ReceptionistRepository,
} from "../db/repository.js";
import type {
  InboundMessage,
  IngestResult,
  JsonValue,
} from "../types.js";
import type {
  ClaimedResetTurnJob,
  ResetConversationMessage,
  ResetDraftResult,
  ResetTurnContact,
  ResetTurnFragment,
  ResetTurnSummary,
} from "./types.js";

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reset repository received an invalid database row.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new Error(`Reset repository row is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Reset repository row is missing ${field}.`);
  }
  return parsed;
}

function conversationSnapshot(value: unknown): ResetConversationMessage[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "Reset repository row is missing generation_authorized_conversation_context.",
    );
  }
  return value.map((entry, index) => {
    const item = row(entry);
    return {
      id: requiredString(item.id, `conversation_context[${index}].id`),
      direction: item.direction === "outbound" ? "outbound" : "inbound",
      kind: requiredString(
        item.kind,
        `conversation_context[${index}].kind`,
      ) as ResetConversationMessage["kind"],
      text: typeof item.text === "string" ? item.text : "",
      createdAt: requiredString(
        item.createdAt,
        `conversation_context[${index}].createdAt`,
      ),
    };
  });
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").trim().slice(0, 500) ||
    "The AI could not prepare this reply.";
}

function safeFailureCode(error: unknown): string {
  const source = error instanceof Error && error.name
    ? error.name
    : "draft_failed";
  return source
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "draft_failed";
}

export interface ResetAppendResult {
  turnId: string;
  status: "collecting";
  settleAt: string;
  substantive: boolean;
  legacyJobSuppressed: boolean;
}

export interface ResetSendReservation {
  ok: boolean;
  state: string | null;
  code: string | null;
  reservationId: string | null;
  toWaId: string | null;
  messageText: string | null;
  finalHash: string | null;
  editedByHuman: boolean;
  providerMessageId: string | null;
}

export interface ResetGenerationRequestState {
  turnId: string;
  turnStatus: string;
  turnModelAttempts: number;
  settleAt: string;
  jobStatus: string;
  jobModelAttempts: number;
  availableAt: string;
}

export interface ResetGenerationAuthorization {
  ok: boolean;
  state: string | null;
  code: string | null;
  requestId: string | null;
  generationRun: number | null;
}

export class ResetReceptionistRepository {
  readonly knowledgeRepository: ReceptionistRepository;
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          "X-Client-Info": "hera-receptionist-reset-v3/1.0",
        },
      },
    });
    this.knowledgeRepository = new SupabaseReceptionistRepository(
      url,
      serviceRoleKey,
    );
  }

  async ingestInboundWithoutLegacyJob(
    message: InboundMessage,
  ): Promise<IngestResult & { turnId: string | null }> {
    const { data, error } = await this.database.rpc(
      "ai_ingest_whatsapp_message_reset_v3",
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
    if (error) {
      throw new Error(`ingest reset WhatsApp message: ${error.message}`);
    }
    const value = row(data);
    const inserted = value.inserted === true;
    return {
      inserted,
      messageId: requiredString(value.messageId, "messageId"),
      conversationId: requiredString(value.conversationId, "conversationId"),
      contactId: requiredString(value.contactId, "contactId"),
      jobId: null,
      turnId: inserted ? requiredString(value.turnId, "turnId") : null,
    };
  }

  async appendFragment(input: {
    ingest: IngestResult;
    message: InboundMessage;
  }): Promise<ResetAppendResult> {
    const { data, error } = await this.database.rpc(
      "ai_append_client_turn_fragment_v3",
      {
        p_conversation_id: input.ingest.conversationId,
        p_contact_id: input.ingest.contactId,
        p_message_id: input.ingest.messageId,
        p_kind: input.message.kind,
        p_text: input.message.text,
        p_media: input.message.media ?? null,
        p_provider_timestamp: input.message.providerTimestamp,
        p_raw: input.message.raw,
      },
    );
    if (error) {
      throw new Error(`append reset client-turn fragment: ${error.message}`);
    }
    const value = row(data);
    return {
      turnId: requiredString(value.turnId, "turnId"),
      status: "collecting",
      settleAt: requiredString(value.settleAt, "settleAt"),
      substantive: value.substantive === true,
      legacyJobSuppressed: value.legacyJobSuppressed === true,
    };
  }

  async claimAuthorizedTurnJob(input: {
    workerId: string;
    turnId: string;
    requestId: string;
  }): Promise<ClaimedResetTurnJob[]> {
    const { data, error } = await this.database.rpc(
      "ai_claim_authorized_turn_job_v3",
      {
        p_worker_id: input.workerId,
        p_turn_id: input.turnId,
        p_request_id: input.requestId,
      },
    );
    if (error) {
      throw new Error(`claim authorized reset turn job: ${error.message}`);
    }
    const values = Array.isArray(data) ? data : [];
    return values.map((value) => {
      const item = row(value);
      return {
        jobId: requiredString(item.job_id, "job_id"),
        turnId: requiredString(item.turn_id, "turn_id"),
        conversationId: requiredString(
          item.conversation_id,
          "conversation_id",
        ),
        contactId: requiredString(item.contact_id, "contact_id"),
        version: requiredNumber(item.version, "version"),
        sourceMessageId: optionalString(item.source_message_id),
        lastFragmentMessageId: requiredString(
          item.last_fragment_message_id,
          "last_fragment_message_id",
        ),
        consolidatedText:
          typeof item.consolidated_text === "string"
            ? item.consolidated_text
            : "",
        fragments: Array.isArray(item.fragments)
          ? item.fragments as ResetTurnFragment[]
          : [],
        firstFragmentAt: requiredString(
          item.first_fragment_at,
          "first_fragment_at",
        ),
        lastFragmentAt: requiredString(
          item.last_fragment_at,
          "last_fragment_at",
        ),
        attempts: requiredNumber(item.attempts, "attempts"),
        generationRun: requiredNumber(item.generation_run, "generation_run"),
        generationRequestId: requiredString(
          item.generation_request_id,
          "generation_request_id",
        ),
        generationAuthorizedBy: requiredString(
          item.generation_authorized_by,
          "generation_authorized_by",
        ),
        generationAuthorizedAt: requiredString(
          item.generation_authorized_at,
          "generation_authorized_at",
        ),
        generationAuthorizationConsumedAt: requiredString(
          item.generation_authorization_consumed_at,
          "generation_authorization_consumed_at",
        ),
        recentConversation: conversationSnapshot(
          item.generation_authorized_conversation_context,
        ),
        workerId: requiredString(item.worker_id, "worker_id"),
      };
    });
  }

  async authorizeGeneration(input: {
    actorUserId: string;
    turnId: string;
    requestId: string;
    expectedLastFragmentMessageId: string;
    expectedTurnContentHash: string;
  }): Promise<ResetGenerationAuthorization> {
    const { data, error } = await this.database.rpc(
      "ai_authorize_turn_generation_v3",
      {
        p_actor_user_id: input.actorUserId,
        p_turn_id: input.turnId,
        p_request_id: input.requestId,
        p_expected_last_fragment_message_id:
          input.expectedLastFragmentMessageId,
        p_expected_turn_content_hash: input.expectedTurnContentHash,
      },
    );
    if (error) throw new Error(`authorize reset generation: ${error.message}`);
    const value = row(data);
    return {
      ok: value.ok === true,
      state: optionalString(value.state),
      code: optionalString(value.code),
      requestId: optionalString(value.requestId),
      generationRun: typeof value.generationRun === "number"
        ? value.generationRun
        : null,
    };
  }

  async getGenerationRequestState(
    turnId: string,
  ): Promise<ResetGenerationRequestState | null> {
    const [turnResult, jobResult] = await Promise.all([
      this.database
        .from("ai_client_turns_v3")
        .select("id,status,model_attempts,settle_at")
        .eq("id", turnId)
        .maybeSingle(),
      this.database
        .from("ai_turn_jobs_v3")
        .select("turn_id,status,model_attempts,available_at")
        .eq("turn_id", turnId)
        .maybeSingle(),
    ]);
    if (turnResult.error) {
      throw new Error(`load reset generation turn: ${turnResult.error.message}`);
    }
    if (jobResult.error) {
      throw new Error(`load reset generation job: ${jobResult.error.message}`);
    }
    if (!turnResult.data || !jobResult.data) return null;
    const turn = row(turnResult.data);
    const job = row(jobResult.data);
    return {
      turnId: requiredString(turn.id, "id"),
      turnStatus: requiredString(turn.status, "status"),
      turnModelAttempts: requiredNumber(turn.model_attempts, "model_attempts"),
      settleAt: requiredString(turn.settle_at, "settle_at"),
      jobStatus: requiredString(job.status, "job.status"),
      jobModelAttempts: requiredNumber(job.model_attempts, "job.model_attempts"),
      availableAt: requiredString(job.available_at, "job.available_at"),
    };
  }

  async getContact(contactId: string): Promise<ResetTurnContact> {
    const { data, error } = await this.database
      .from("ai_contacts")
      .select("id,wa_id,profile_name,preferred_language")
      .eq("id", contactId)
      .single();
    if (error) throw new Error(`load reset contact: ${error.message}`);
    const item = row(data);
    return {
      id: requiredString(item.id, "id"),
      waId: requiredString(item.wa_id, "wa_id"),
      profileName: optionalString(item.profile_name),
      preferredLanguage: optionalString(item.preferred_language),
    };
  }

  async getRecentConversation(input: {
    conversationId: string;
    throughCreatedAt: string;
    limit?: number;
  }): Promise<ResetConversationMessage[]> {
    return this.knowledgeRepository.getConversationHistory(
      input.conversationId,
      Math.max(1, Math.min(input.limit ?? 20, 30)),
      input.throughCreatedAt,
    );
  }

  async finishReady(input: {
    job: ClaimedResetTurnJob;
    result: ResetDraftResult;
  }): Promise<{ state: "ready" | "superseded"; candidateId: string | null }> {
    const { data, error } = await this.database.rpc(
      "ai_finish_authorized_turn_ready_v3",
      {
      p_job_id: input.job.jobId,
      p_turn_id: input.job.turnId,
      p_request_id: input.job.generationRequestId,
      p_generation_run: input.job.generationRun,
      p_worker_id: input.job.workerId,
      p_model_id: input.result.modelId,
      p_model_attempts: input.result.modelAttempts,
      p_body: input.result.finalReply,
      p_evidence: input.result.evidence as unknown as JsonValue,
      p_validation: input.result.validation as unknown as JsonValue,
      },
    );
    if (error) throw new Error(`finish reset turn ready: ${error.message}`);
    const value = row(data);
    if (value.state === "superseded") {
      return { state: "superseded", candidateId: null };
    }
    if (value.ok !== true || value.state !== "ready") {
      throw new Error(
        `finish reset turn ready blocked: ${optionalString(value.code) ?? "unknown"}`,
      );
    }
    return {
      state: "ready",
      candidateId: optionalString(value.candidateId),
    };
  }

  async validateAuthorizedTurnJob(
    job: ClaimedResetTurnJob,
  ): Promise<"valid" | "superseded"> {
    const { data, error } = await this.database.rpc(
      "ai_validate_authorized_turn_job_v3",
      {
        p_job_id: job.jobId,
        p_turn_id: job.turnId,
        p_request_id: job.generationRequestId,
        p_generation_run: job.generationRun,
        p_worker_id: job.workerId,
      },
    );
    if (error) {
      throw new Error(`validate authorized reset turn job: ${error.message}`);
    }
    const value = row(data);
    if (value.ok === true && value.state === "valid") return "valid";
    if (value.state === "superseded") return "superseded";
    throw new Error(
      `validate authorized reset turn job blocked: ${optionalString(value.code) ?? "unknown"}`,
    );
  }

  async finishFailed(input: {
    job: ClaimedResetTurnJob;
    error: unknown;
    modelAttempts?: number;
    failureCode?: string;
    failureMessage?: string;
  }): Promise<"failed" | "superseded"> {
    const { data, error } = await this.database.rpc(
      "ai_finish_authorized_turn_failed_v3",
      {
      p_job_id: input.job.jobId,
      p_turn_id: input.job.turnId,
      p_request_id: input.job.generationRequestId,
      p_generation_run: input.job.generationRun,
      p_worker_id: input.job.workerId,
      p_failure_code: input.failureCode ?? safeFailureCode(input.error),
      p_failure_message:
        input.failureMessage ?? safeFailureMessage(input.error),
      p_model_attempts: Math.max(
        0,
        Math.min(input.modelAttempts ?? 0, 1),
      ),
      },
    );
    if (error) throw new Error(`finish reset turn failed: ${error.message}`);
    const value = row(data);
    if (value.state === "superseded") return "superseded";
    if (value.ok !== true || value.state !== "failed") {
      throw new Error(
        `finish reset turn failed blocked: ${optionalString(value.code) ?? "unknown"}`,
      );
    }
    return "failed";
  }

  async retryTurn(input: {
    actorUserId: string;
    turnId: string;
    requestId: string;
    expectedLastFragmentMessageId: string;
    expectedTurnContentHash: string;
  }): Promise<ResetGenerationAuthorization> {
    const { data, error } = await this.database.rpc(
      "ai_retry_and_authorize_turn_v3",
      {
        p_actor_user_id: input.actorUserId,
        p_turn_id: input.turnId,
        p_request_id: input.requestId,
        p_expected_last_fragment_message_id:
          input.expectedLastFragmentMessageId,
        p_expected_turn_content_hash: input.expectedTurnContentHash,
      },
    );
    if (error) throw new Error(`retry reset turn: ${error.message}`);
    const value = row(data);
    return {
      ok: value.ok === true,
      state: optionalString(value.state),
      code: optionalString(value.code),
      requestId: optionalString(value.requestId),
      generationRun: typeof value.generationRun === "number"
        ? value.generationRun
        : null,
    };
  }

  async getLatestTurnSummary(conversationId: string): Promise<ResetTurnSummary> {
    const { data, error } = await this.database
      .from("ai_client_turns_v3")
      .select(
        "id,conversation_id,version,status,delivery_control,candidate_id,failure_code,failure_message,first_fragment_at,last_fragment_at,settle_at,ai_reply_candidates_v3(id,body,body_hash,status,model_id,model_attempts)",
      )
      .eq("conversation_id", conversationId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`load reset turn summary: ${error.message}`);
    if (!data) {
      return {
        conversationId,
        turnId: null,
        turnVersion: null,
        turnStatus: null,
        deliveryControl: null,
        candidateId: null,
        candidateText: null,
        candidateHash: null,
        candidateModelId: null,
        candidateModelAttempts: null,
        candidateStatus: null,
        failureCode: null,
        failureMessage: null,
        firstFragmentAt: null,
        lastFragmentAt: null,
        settleAt: null,
      };
    }
    const item = row(data);
    const relation = item.ai_reply_candidates_v3;
    const candidateSource = Array.isArray(relation) ? relation[0] : relation;
    const candidate = candidateSource ? row(candidateSource) : null;
    const turnStatus = requiredString(item.status, "status") as ResetTurnSummary["turnStatus"];
    const candidateStatus = candidate
      ? requiredString(candidate.status, "candidate.status") as ResetTurnSummary["candidateStatus"]
      : null;
    return {
      conversationId,
      turnId: requiredString(item.id, "id"),
      turnVersion: requiredNumber(item.version, "version"),
      turnStatus,
      deliveryControl:
        item.delivery_control === "human_only" ? "human_only" : null,
      candidateId: candidate ? requiredString(candidate.id, "candidate.id") : null,
      candidateText: candidate ? requiredString(candidate.body, "candidate.body") : null,
      candidateHash: candidate ? requiredString(candidate.body_hash, "candidate.body_hash") : null,
      candidateModelId: candidate ? requiredString(candidate.model_id, "candidate.model_id") : null,
      candidateModelAttempts: candidate
        ? requiredNumber(candidate.model_attempts, "candidate.model_attempts")
        : null,
      candidateStatus,
      failureCode: optionalString(item.failure_code),
      failureMessage: optionalString(item.failure_message),
      firstFragmentAt: optionalString(item.first_fragment_at),
      lastFragmentAt: optionalString(item.last_fragment_at),
      settleAt: optionalString(item.settle_at),
    };
  }

  async listLatestTurnSummaries(
    conversationIds: string[],
  ): Promise<ResetTurnSummary[]> {
    const unique = [...new Set(conversationIds)].slice(0, 300);
    if (unique.length === 0) return [];
    return Promise.all(unique.map((id) => this.getLatestTurnSummary(id)));
  }

  async reserveHumanSend(input: {
    actorUserId: string;
    candidateId: string;
    turnId: string;
    turnVersion: number;
    candidateHash: string;
    phoneEnding: string;
    finalText: string;
  }): Promise<ResetSendReservation> {
    const { data, error } = await this.database.rpc(
      "ai_reserve_human_send_v3",
      {
        p_actor_user_id: input.actorUserId,
        p_candidate_id: input.candidateId,
        p_expected_turn_id: input.turnId,
        p_expected_turn_version: input.turnVersion,
        p_expected_candidate_hash: input.candidateHash,
        p_expected_phone_ending: input.phoneEnding,
        p_final_text: input.finalText,
      },
    );
    if (error) throw new Error(`reserve reset human send: ${error.message}`);
    const value = row(data);
    return {
      ok: value.ok === true,
      state: optionalString(value.state),
      code: optionalString(value.code),
      reservationId: optionalString(value.reservationId),
      toWaId: optionalString(value.toWaId),
      messageText: optionalString(value.messageText),
      finalHash: optionalString(value.finalHash),
      editedByHuman: value.editedByHuman === true,
      providerMessageId: optionalString(value.providerMessageId),
    };
  }

  async completeHumanSend(input: {
    reservationId: string;
    providerMessageId: string;
  }): Promise<void> {
    const { data, error } = await this.database.rpc(
      "ai_complete_human_send_v3",
      {
        p_reservation_id: input.reservationId,
        p_provider_message_id: input.providerMessageId,
      },
    );
    if (error) throw new Error(`complete reset human send: ${error.message}`);
    const value = row(data);
    if (value.ok !== true) {
      throw new Error(`complete reset human send: ${optionalString(value.code) ?? "blocked"}`);
    }
  }

  async failHumanSend(input: {
    reservationId: string;
    failureCode: string;
  }): Promise<void> {
    const { error } = await this.database.rpc("ai_fail_human_send_v3", {
      p_reservation_id: input.reservationId,
      p_failure_code: input.failureCode,
    });
    if (error) throw new Error(`fail reset human send: ${error.message}`);
  }
}
