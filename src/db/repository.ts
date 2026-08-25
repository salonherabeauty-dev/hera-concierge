import { createClient } from "@supabase/supabase-js";
import type {
  AgentDecision,
  AutomaticHandoffInput,
  AutomaticHandoffResult,
  BookingSummary,
  ConversationMessage,
  InboundMessage,
  IngestResult,
  JsonValue,
  JobContext,
  KnowledgeResult,
  OperationalSnapshot,
  OutboxItem,
  ReceptionistJob,
  RiskLevel,
  StoredMessage,
  WhatsAppStatusEvent,
} from "../types.js";

interface RecordDecisionInput {
  conversationId: string;
  sourceMessageId: string;
  stage: "response" | "verification" | "policy";
  modelId: string | null;
  promptVersion: string;
  policyVersion: string;
  risk: RiskLevel;
  confidence: number;
  output: AgentDecision | JsonValue;
  usage?: JsonValue;
  latencyMs?: number;
}

interface OpenIncidentInput {
  conversationId: string;
  sourceMessageId: string;
  category: string;
  severity: Exclude<RiskLevel, "green">;
  clientSummary: string;
  evidence?: JsonValue;
}

interface QueueOutboundInput {
  conversationId: string | null;
  sourceMessageId: string | null;
  toWaId: string;
  targetType: "client" | "management";
  body: string;
  dedupeKey: string;
  authorization?: "auto" | "management";
}

interface WebsiteKnowledgeInput {
  title: string;
  body: string;
  sourceUrl: string;
  checksum: string;
  version: string;
  autoApprove: boolean;
  metadata?: JsonValue;
}

export interface ReceptionistRepository {
  ingestInbound(message: InboundMessage): Promise<IngestResult>;
  applyStatus(event: WhatsAppStatusEvent): Promise<void>;
  claimJobs(workerId: string, limit: number): Promise<ReceptionistJob[]>;
  claimJobsByIds?(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]>;
  getJobContext(job: ReceptionistJob): Promise<JobContext>;
  isInboundSuperseded(messageId: string): Promise<boolean>;
  getConversationHistory(
    conversationId: string,
    limit: number,
    throughCreatedAt: string,
  ): Promise<ConversationMessage[]>;
  lookupBookingsByWaId(waId: string, limit?: number): Promise<BookingSummary[]>;
  searchApprovedKnowledge(query: string, limit?: number): Promise<KnowledgeResult[]>;
  upsertWebsiteKnowledge(input: WebsiteKnowledgeInput): Promise<"draft" | "approved">;
  updateMessageText(messageId: string, text: string): Promise<void>;
  updateConversationRisk(conversationId: string, risk: RiskLevel): Promise<void>;
  recordDecision(input: RecordDecisionInput): Promise<void>;
  openIncident(input: OpenIncidentInput): Promise<void>;
  upsertAutomaticHandoff(input: AutomaticHandoffInput): Promise<AutomaticHandoffResult>;
  queueOutbound(input: QueueOutboundInput): Promise<void>;
  completeJob(jobId: string): Promise<void>;
  retryJob(job: ReceptionistJob, error: unknown): Promise<"retry" | "dead">;
  claimOutbox(workerId: string, limit: number): Promise<OutboxItem[]>;
  getOperationalSnapshot(): Promise<OperationalSnapshot>;
  getSourceMessageProviderTimestamp(messageId: string): Promise<string | null>;
  markOutboxShadowed(itemId: string): Promise<void>;
  markOutboxSent(itemId: string, providerMessageId: string): Promise<void>;
  retryOutbox(
    item: OutboxItem,
    error: unknown,
    retryable?: boolean,
  ): Promise<"retry" | "dead">;
  audit(eventType: string, targetType: string, targetId: string | null, details?: JsonValue): Promise<void>;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1500);
}

function retryAt(attempts: number): string {
  const seconds = Math.min(900, 10 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function requireData<T>(data: T | null, error: { message: string } | null, operation: string): T {
  if (error) throw new Error(`${operation}: ${error.message}`);
  if (data === null) throw new Error(`${operation}: no data returned`);
  return data;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Database returned an invalid row");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Database row is missing ${field}`);
  return value;
}

function effectiveTimestamp(providerTimestamp: unknown, createdAt: string): number {
  const provider =
    typeof providerTimestamp === "string" ? Date.parse(providerTimestamp) : Number.NaN;
  if (Number.isFinite(provider)) return provider;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) throw new Error("Database row has an invalid created_at");
  return created;
}

export class SupabaseReceptionistRepository implements ReceptionistRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-ai-receptionist/2.0" } },
    });
  }

  async ingestInbound(message: InboundMessage): Promise<IngestResult> {
    const { data, error } = await this.database.rpc("ai_ingest_whatsapp_message", {
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
    });
    const value = row(requireData(data, error, "ingest inbound message"));
    return {
      inserted: value.inserted === true,
      messageId: requiredString(value.messageId, "messageId"),
      conversationId: requiredString(value.conversationId, "conversationId"),
      contactId: requiredString(value.contactId, "contactId"),
      jobId: typeof value.jobId === "string" ? value.jobId : null,
    };
  }

  async applyStatus(event: WhatsAppStatusEvent): Promise<void> {
    const { error } = await this.database.rpc("ai_apply_whatsapp_status", {
      p_provider_message_id: event.providerMessageId,
      p_status: event.status,
      p_provider_timestamp: event.providerTimestamp,
      p_errors: event.errors,
      p_raw: event.raw,
    });
    if (error) throw new Error(`apply WhatsApp status: ${error.message}`);
  }

  async claimJobs(workerId: string, limit: number): Promise<ReceptionistJob[]> {
    const { data, error } = await this.database.rpc("ai_claim_jobs", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    const values = requireData(data, error, "claim jobs") as unknown[];
    return values.map((value) => {
      const item = row(value);
      return {
        id: requiredString(item.id, "id"),
        kind: "process_inbound",
        sourceMessageId: requiredString(item.source_message_id, "source_message_id"),
        payload: (item.payload ?? {}) as JsonValue,
        attempts: Number(item.attempts),
        maxAttempts: Number(item.max_attempts),
      };
    });
  }

  async claimJobsByIds(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]> {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);
    if (uniqueJobIds.length === 0) return [];
    const { data, error } = await this.database.rpc("ai_claim_jobs_by_ids", {
      p_worker_id: workerId,
      p_job_ids: uniqueJobIds,
    });
    const values = requireData(data, error, "claim targeted jobs") as unknown[];
    return values.map((value) => {
      const item = row(value);
      return {
        id: requiredString(item.id, "id"),
        kind: "process_inbound",
        sourceMessageId: requiredString(item.source_message_id, "source_message_id"),
        payload: (item.payload ?? {}) as JsonValue,
        attempts: Number(item.attempts),
        maxAttempts: Number(item.max_attempts),
      };
    });
  }

  async getJobContext(job: ReceptionistJob): Promise<JobContext> {
    const messageResult = await this.database
      .from("ai_messages")
      .select(
        "id,conversation_id,contact_id,provider_message_id,direction,kind,text_body,media,provider_timestamp,created_at",
      )
      .eq("id", job.sourceMessageId)
      .single();
    const messageRow = row(requireData(messageResult.data, messageResult.error, "load source message"));

    const contactResult = await this.database
      .from("ai_contacts")
      .select("id,wa_id,profile_name,preferred_language")
      .eq("id", requiredString(messageRow.contact_id, "contact_id"))
      .single();
    const contactRow = row(requireData(contactResult.data, contactResult.error, "load contact"));

    const conversationResult = await this.database
      .from("ai_conversations")
      .select("current_risk")
      .eq("id", requiredString(messageRow.conversation_id, "conversation_id"))
      .single();
    const conversationRow = row(
      requireData(
        conversationResult.data,
        conversationResult.error,
        "load conversation risk",
      ),
    );
    const conversationRisk = conversationRow.current_risk;
    if (
      conversationRisk !== "green" &&
      conversationRisk !== "amber" &&
      conversationRisk !== "red" &&
      conversationRisk !== "black"
    ) {
      throw new Error("Database row has an invalid current_risk");
    }

    const message: StoredMessage = {
      id: requiredString(messageRow.id, "id"),
      conversationId: requiredString(messageRow.conversation_id, "conversation_id"),
      contactId: requiredString(messageRow.contact_id, "contact_id"),
      providerMessageId:
        typeof messageRow.provider_message_id === "string" ? messageRow.provider_message_id : null,
      direction: messageRow.direction === "outbound" ? "outbound" : "inbound",
      kind: messageRow.kind as StoredMessage["kind"],
      text: typeof messageRow.text_body === "string" ? messageRow.text_body : "",
      media: (messageRow.media ?? null) as StoredMessage["media"],
      providerTimestamp:
        typeof messageRow.provider_timestamp === "string" ? messageRow.provider_timestamp : null,
      createdAt: requiredString(messageRow.created_at, "created_at"),
    };

    return {
      job,
      message,
      contact: {
        id: requiredString(contactRow.id, "id"),
        waId: requiredString(contactRow.wa_id, "wa_id"),
        profileName: typeof contactRow.profile_name === "string" ? contactRow.profile_name : null,
        preferredLanguage:
          typeof contactRow.preferred_language === "string"
            ? contactRow.preferred_language
            : null,
      },
      conversationRisk,
    };
  }

  async isInboundSuperseded(messageId: string): Promise<boolean> {
    const { data, error } = await this.database.rpc("ai_is_inbound_superseded", {
      p_message_id: messageId,
    });
    if (error) throw new Error(`check inbound chronology: ${error.message}`);
    if (typeof data !== "boolean") {
      throw new Error("check inbound chronology: invalid database response");
    }
    return data;
  }

  async getConversationHistory(
    conversationId: string,
    limit: number,
    throughCreatedAt: string,
  ): Promise<ConversationMessage[]> {
    const requestedLimit = Math.max(1, Math.min(limit, 30));
    const fetchLimit = Math.max(30, Math.min(requestedLimit * 3, 100));
    const { data, error } = await this.database
      .from("ai_messages")
      .select("id,direction,kind,text_body,provider_timestamp,created_at")
      .eq("conversation_id", conversationId)
      .lte("created_at", throughCreatedAt)
      .order("created_at", { ascending: false })
      .limit(fetchLimit);
    const values = requireData(data, error, "load conversation history") as unknown[];
    return values
      .map((value) => {
        const item = row(value);
        const createdAt = requiredString(item.created_at, "created_at");
        return {
          orderAt: effectiveTimestamp(item.provider_timestamp, createdAt),
          createdAt,
          message: {
            id: requiredString(item.id, "id"),
            direction: item.direction === "outbound" ? "outbound" as const : "inbound" as const,
            kind: item.kind as ConversationMessage["kind"],
            text: typeof item.text_body === "string" ? item.text_body : "",
            createdAt,
          },
        };
      })
      .sort((a, b) => a.orderAt - b.orderAt || a.createdAt.localeCompare(b.createdAt))
      .slice(-requestedLimit)
      .map((item) => item.message);
  }

  async lookupBookingsByWaId(waId: string, limit = 10): Promise<BookingSummary[]> {
    const { data, error } = await this.database.rpc("ai_lookup_bookings_by_mobile", {
      p_mobile: `+${waId}`,
      p_limit: limit,
    });
    const values = requireData(data, error, "lookup bookings") as unknown[];
    return values.map((value) => {
      const item = row(value);
      return {
        id: requiredString(item.id, "id"),
        clientName: requiredString(item.client_name, "client_name"),
        serviceName: requiredString(item.service_name, "service_name"),
        stylistName: typeof item.stylist_name === "string" ? item.stylist_name : null,
        locationName: typeof item.location_name === "string" ? item.location_name : null,
        appointmentAt: requiredString(item.appointment_at, "appointment_at"),
        bookingStatus: requiredString(item.booking_status, "booking_status"),
        price: item.price === null || item.price === undefined ? null : Number(item.price),
        currency: requiredString(item.currency, "currency"),
      };
    });
  }

  async searchApprovedKnowledge(query: string, limit = 5): Promise<KnowledgeResult[]> {
    if (!query.trim()) return [];
    const { data, error } = await this.database.rpc("ai_search_knowledge", {
      p_query: query.slice(0, 500),
      p_limit: limit,
    });
    const values = requireData(data, error, "search approved knowledge") as unknown[];
    return values.map((value) => {
      const item = row(value);
      return {
        id: requiredString(item.id, "id"),
        title: requiredString(item.title, "title"),
        excerpt: requiredString(item.excerpt, "excerpt"),
        sourceUrl: typeof item.source_url === "string" ? item.source_url : null,
        version: requiredString(item.version, "version"),
        score: Number(item.score),
      };
    });
  }

  async upsertWebsiteKnowledge(
    input: WebsiteKnowledgeInput,
  ): Promise<"draft" | "approved"> {
    const { data, error } = await this.database.rpc("ai_upsert_website_knowledge", {
      p_title: input.title,
      p_body: input.body,
      p_source_url: input.sourceUrl,
      p_checksum: input.checksum,
      p_version: input.version,
      p_auto_approve: input.autoApprove,
      p_metadata: input.metadata ?? {},
    });
    const value = requireData(data, error, "upsert website knowledge");
    return value === "approved" ? "approved" : "draft";
  }

  async updateMessageText(messageId: string, value: string): Promise<void> {
    const { error } = await this.database
      .from("ai_messages")
      .update({ text_body: value.slice(0, 12_000), updated_at: new Date().toISOString() })
      .eq("id", messageId);
    if (error) throw new Error(`update message text: ${error.message}`);
  }

  async updateConversationRisk(conversationId: string, risk: RiskLevel): Promise<void> {
    const { error } = await this.database
      .from("ai_conversations")
      .update({ current_risk: risk, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (error) throw new Error(`update conversation risk: ${error.message}`);
  }

  async recordDecision(input: RecordDecisionInput): Promise<void> {
    const { error } = await this.database.from("ai_decisions").upsert(
      {
        conversation_id: input.conversationId,
        source_message_id: input.sourceMessageId,
        stage: input.stage,
        model_id: input.modelId,
        prompt_version: input.promptVersion,
        policy_version: input.policyVersion,
        risk: input.risk,
        confidence: input.confidence,
        output: input.output,
        usage: input.usage ?? {},
        latency_ms: input.latencyMs ?? null,
      },
      {
        onConflict: "source_message_id,stage,prompt_version,policy_version",
        ignoreDuplicates: true,
      },
    );
    if (error) throw new Error(`record AI decision: ${error.message}`);
  }

  async openIncident(input: OpenIncidentInput): Promise<void> {
    const { error } = await this.database.from("ai_incidents").upsert(
      {
        conversation_id: input.conversationId,
        source_message_id: input.sourceMessageId,
        category: input.category,
        severity: input.severity,
        client_summary: input.clientSummary.slice(0, 4000),
        evidence: input.evidence ?? {},
      },
      { onConflict: "source_message_id,category", ignoreDuplicates: true },
    );
    if (error) throw new Error(`open incident: ${error.message}`);
  }


  async upsertAutomaticHandoff(
    input: AutomaticHandoffInput,
  ): Promise<AutomaticHandoffResult> {
    const { data, error } = await this.database.rpc(
      "ai_upsert_automatic_handoff",
      {
        p_conversation_id: input.conversationId,
        p_source_message_id: input.sourceMessageId,
        p_task_type: input.taskType,
        p_scope: input.scope,
        p_priority: input.priority,
        p_assigned_role: input.assignedRole,
        p_assigned_outlet: input.assignedOutlet,
        p_summary: input.summary,
        p_requested_action: input.requestedAction,
        p_collected_facts: input.collectedFacts,
        p_missing_facts: input.missingFacts,
        p_client_visible_status: input.clientVisibleStatus,
        p_due_at: input.dueAt ?? null,
        p_dedupe_key: input.dedupeKey,
      },
    );
    const value = row(requireData(data, error, "upsert automatic handoff"));
    return {
      inserted: value.inserted === true,
      updated: value.updated === true,
      taskId: requiredString(value.taskId, "taskId"),
      status: requiredString(value.status, "status"),
      version: Number(value.version),
    };
  }

  async queueOutbound(input: QueueOutboundInput): Promise<void> {
    const { error } = await this.database.from("ai_outbox").upsert(
      {
        conversation_id: input.conversationId,
        source_message_id: input.sourceMessageId,
        to_wa_id: input.toWaId,
        target_type: input.targetType,
        body: { text: input.body.trim().slice(0, 4000) },
        dedupe_key: input.dedupeKey,
        send_authorization: input.authorization ?? "auto",
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
    if (error) throw new Error(`queue outbound message: ${error.message}`);
  }

  async completeJob(jobId: string): Promise<void> {
    const { error } = await this.database
      .from("ai_jobs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (error) throw new Error(`complete job: ${error.message}`);
  }

  async retryJob(job: ReceptionistJob, errorValue: unknown): Promise<"retry" | "dead"> {
    const status = job.attempts >= job.maxAttempts ? "dead" : "retry";
    const { error } = await this.database
      .from("ai_jobs")
      .update({
        status,
        available_at: status === "retry" ? retryAt(job.attempts) : new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: errorText(errorValue),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    if (error) throw new Error(`retry job: ${error.message}`);
    return status;
  }

  async claimOutbox(workerId: string, limit: number): Promise<OutboxItem[]> {
    const { data, error } = await this.database.rpc("ai_claim_outbox", {
      p_worker_id: workerId,
      p_limit: limit,
    });
    const values = requireData(data, error, "claim outbox") as unknown[];
    return values.map((value) => {
      const item = row(value);
      const body = row(item.body);
      return {
        id: requiredString(item.id, "id"),
        conversationId:
          typeof item.conversation_id === "string" ? item.conversation_id : null,
        sourceMessageId:
          typeof item.source_message_id === "string" ? item.source_message_id : null,
        toWaId: requiredString(item.to_wa_id, "to_wa_id"),
        targetType: item.target_type === "management" ? "management" : "client",
        body: requiredString(body.text, "body.text"),
        dedupeKey: requiredString(item.dedupe_key, "dedupe_key"),
        authorization:
          item.send_authorization === "management" ? "management" : "auto",
        attempts: Number(item.attempts),
        maxAttempts: Number(item.max_attempts),
      };
    });
  }

  async getOperationalSnapshot(): Promise<OperationalSnapshot> {
    const activeQueueStatuses = ["pending", "processing", "retry"];
    const openIncidentStatuses = ["open", "monitoring"];
    const [
      activeJobs,
      deadJobs,
      activeOutbox,
      deadOutbox,
      openIncidents,
      blackIncidents,
      oldestActiveJob,
      oldestActiveOutbox,
    ] = await Promise.all([
      this.database
        .from("ai_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", activeQueueStatuses),
      this.database
        .from("ai_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "dead"),
      this.database
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .in("status", activeQueueStatuses),
      this.database
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", "dead"),
      this.database
        .from("ai_incidents")
        .select("id", { count: "exact", head: true })
        .in("status", openIncidentStatuses),
      this.database
        .from("ai_incidents")
        .select("id", { count: "exact", head: true })
        .in("status", openIncidentStatuses)
        .eq("severity", "black"),
      this.database
        .from("ai_jobs")
        .select("created_at")
        .in("status", activeQueueStatuses)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      this.database
        .from("ai_outbox")
        .select("created_at")
        .in("status", activeQueueStatuses)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    function exactCount(
      result: { count: number | null; error: { message: string } | null },
      operation: string,
    ): number {
      if (result.error) throw new Error(`${operation}: ${result.error.message}`);
      if (result.count === null) throw new Error(`${operation}: count unavailable`);
      return result.count;
    }

    function oldestCreatedAt(
      result: { data: unknown; error: { message: string } | null },
      operation: string,
    ): string | null {
      if (result.error) throw new Error(`${operation}: ${result.error.message}`);
      if (result.data === null) return null;
      const value = row(result.data).created_at;
      if (typeof value !== "string" || !value) {
        throw new Error(`${operation}: invalid created_at`);
      }
      return value;
    }

    return {
      activeJobs: exactCount(activeJobs, "count active jobs"),
      deadJobs: exactCount(deadJobs, "count dead jobs"),
      activeOutbox: exactCount(activeOutbox, "count active outbox"),
      deadOutbox: exactCount(deadOutbox, "count dead outbox"),
      openIncidents: exactCount(openIncidents, "count open incidents"),
      blackIncidents: exactCount(blackIncidents, "count black incidents"),
      oldestActiveJobCreatedAt: oldestCreatedAt(
        oldestActiveJob,
        "load oldest active job",
      ),
      oldestActiveOutboxCreatedAt: oldestCreatedAt(
        oldestActiveOutbox,
        "load oldest active outbox",
      ),
    };
  }

  async getSourceMessageProviderTimestamp(messageId: string): Promise<string | null> {
    const { data, error } = await this.database
      .from("ai_messages")
      .select("provider_timestamp")
      .eq("id", messageId)
      .maybeSingle();
    if (error) throw new Error(`load source message timestamp: ${error.message}`);
    if (!data) return null;
    const messageRow = row(data);
    return typeof messageRow.provider_timestamp === "string"
      ? messageRow.provider_timestamp
      : null;
  }

  async markOutboxShadowed(itemId: string): Promise<void> {
    const { error } = await this.database
      .from("ai_outbox")
      .update({
        status: "shadowed",
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);
    if (error) throw new Error(`mark outbox shadowed: ${error.message}`);
  }

  async markOutboxSent(itemId: string, providerMessageId: string): Promise<void> {
    const { error } = await this.database.rpc("ai_mark_outbox_sent", {
      p_outbox_id: itemId,
      p_provider_message_id: providerMessageId,
    });
    if (error) throw new Error(`mark outbox sent: ${error.message}`);
  }

  async retryOutbox(
    item: OutboxItem,
    errorValue: unknown,
    retryable = true,
  ): Promise<"retry" | "dead"> {
    const status = !retryable || item.attempts >= item.maxAttempts ? "dead" : "retry";
    const { error } = await this.database
      .from("ai_outbox")
      .update({
        status,
        available_at: status === "retry" ? retryAt(item.attempts) : new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: errorText(errorValue),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    if (error) throw new Error(`retry outbox: ${error.message}`);
    return status;
  }

  async audit(
    eventType: string,
    targetType: string,
    targetId: string | null,
    details: JsonValue = {},
  ): Promise<void> {
    const { error } = await this.database.from("ai_audit_log").insert({
      actor_type: "system",
      actor_id: "hera_receptionist",
      event_type: eventType,
      target_type: targetType,
      target_id: targetId,
      details,
    });
    if (error) throw new Error(`write audit log: ${error.message}`);
  }
}
