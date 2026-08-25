import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { JsonValue, RiskLevel } from "../types.js";
import type {
  CandidateReplyView,
  CommandCentreDashboard,
  ConversationDetail,
  ConversationMessageView,
  ConversationSummary,
  HandoffStatus,
  HandoffTaskSummary,
  IncidentView,
} from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function phoneEnding(value: unknown): string {
  return typeof value === "string" && value.length >= 4 ? value.slice(-4) : "—";
}

function preview(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 180)
    : "";
}

function risk(value: unknown): RiskLevel {
  return value === "amber" || value === "red" || value === "black"
    ? value
    : "green";
}

function qualityNumber(source: Record<string, unknown>, key: string): number {
  const value = Number(source[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export interface CommandCentreReadRepository {
  listTasks(input?: {
    status?: HandoffStatus | "open" | null;
    conversationId?: string | null;
    limit?: number;
  }): Promise<HandoffTaskSummary[]>;
  listConversations(input?: {
    mode?: "ai" | "management" | null;
    risk?: RiskLevel | null;
    search?: string | null;
    limit?: number;
  }): Promise<ConversationSummary[]>;
  getConversation(conversationId: string): Promise<ConversationDetail>;
  dashboard(mode: "shadow" | "live"): Promise<CommandCentreDashboard>;
}

/**
 * Read-only staging repository used while the full Command Centre handoff
 * migration is not yet installed. It exposes the existing WhatsApp records,
 * quality evidence and system health without inventing task data or permitting
 * operational mutations.
 */
export class PreviewCommandCentreRepository implements CommandCentreReadRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-command-centre-preview/1.0" } },
    });
  }

  async listTasks(): Promise<HandoffTaskSummary[]> {
    return [];
  }

  async listConversations(input: {
    mode?: "ai" | "management" | null;
    risk?: RiskLevel | null;
    search?: string | null;
    limit?: number;
  } = {}): Promise<ConversationSummary[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 80, 150));
    let query = this.database
      .from("ai_conversations")
      .select("id,contact_id,status,operating_mode,current_risk,human_takeover_until,last_message_at")
      .order("last_message_at", { ascending: false })
      .limit(limit);
    if (input.mode) query = query.eq("operating_mode", input.mode);
    if (input.risk) query = query.eq("current_risk", input.risk);

    const { data, error } = await query;
    if (error) throw new Error(`list preview conversations: ${error.message}`);
    const conversationRows = array(data).map((value) => object(value, "conversation"));
    if (conversationRows.length === 0) return [];

    const conversationIds = conversationRows.map((row) => string(row.id, "conversation id"));
    const contactIds = [
      ...new Set(conversationRows.map((row) => string(row.contact_id, "contact id"))),
    ];
    const [contactResult, messageResult] = await Promise.all([
      this.database
        .from("ai_contacts")
        .select("id,profile_name,wa_id,preferred_language")
        .in("id", contactIds),
      this.database
        .from("ai_messages")
        .select("conversation_id,direction,text_body,provider_timestamp,created_at")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(Math.min(2500, conversationIds.length * 20)),
    ]);
    if (contactResult.error) {
      throw new Error(`load preview conversation contacts: ${contactResult.error.message}`);
    }
    if (messageResult.error) {
      throw new Error(`load preview conversation messages: ${messageResult.error.message}`);
    }

    const contacts = new Map(
      array(contactResult.data).map((value) => {
        const row = object(value, "contact");
        return [string(row.id, "contact id"), row] as const;
      }),
    );
    const latestMessages = new Map<string, Record<string, unknown>>();
    for (const value of array(messageResult.data)) {
      const row = object(value, "message");
      const conversationId = string(row.conversation_id, "message conversation id");
      if (!latestMessages.has(conversationId)) latestMessages.set(conversationId, row);
    }

    const search = input.search?.trim().toLowerCase() ?? "";
    return conversationRows
      .map((row): ConversationSummary => {
        const id = string(row.id, "conversation id");
        const contact = contacts.get(string(row.contact_id, "contact id"));
        if (!contact) throw new Error("Conversation contact was not returned");
        const latest = latestMessages.get(id);
        return {
          id,
          contactId: string(row.contact_id, "contact id"),
          clientDisplayName:
            optionalString(contact.profile_name) ??
            `Client •••• ${phoneEnding(contact.wa_id)}`,
          phoneEnding: phoneEnding(contact.wa_id),
          preferredLanguage: optionalString(contact.preferred_language),
          status: string(row.status, "conversation status") as ConversationSummary["status"],
          operatingMode: row.operating_mode === "management" ? "management" : "ai",
          currentRisk: risk(row.current_risk),
          humanTakeoverUntil: optionalString(row.human_takeover_until),
          lastMessageAt:
            optionalString(latest?.provider_timestamp) ??
            optionalString(latest?.created_at) ??
            string(row.last_message_at, "last_message_at"),
          lastMessagePreview: latest ? preview(latest.text_body) : "",
          lastMessageDirection:
            latest?.direction === "inbound" || latest?.direction === "outbound"
              ? latest.direction
              : null,
          openTaskCount: 0,
          highestPriority: null,
        };
      })
      .filter((conversation) => {
        if (!search) return true;
        return (
          conversation.clientDisplayName.toLowerCase().includes(search) ||
          conversation.phoneEnding.includes(search) ||
          conversation.lastMessagePreview.toLowerCase().includes(search)
        );
      });
  }

  async getConversation(conversationId: string): Promise<ConversationDetail> {
    const { data: conversationData, error: conversationError } = await this.database
      .from("ai_conversations")
      .select("id,contact_id,status,operating_mode,current_risk,human_takeover_until,last_message_at")
      .eq("id", conversationId)
      .single();
    if (conversationError || !conversationData) throw new Error("Conversation not found");
    const conversationRow = object(conversationData, "conversation");
    const contactId = string(conversationRow.contact_id, "contact id");

    const [contactResult, messageResult, incidentResult, outboxResult] = await Promise.all([
      this.database
        .from("ai_contacts")
        .select("id,profile_name,wa_id,preferred_language")
        .eq("id", contactId)
        .single(),
      this.database
        .from("ai_messages")
        .select("id,direction,kind,text_body,media,ai_generated,delivery_status,provider_timestamp,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(300),
      this.database
        .from("ai_incidents")
        .select("id,category,severity,status,client_summary,created_at,updated_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(100),
      this.database
        .from("ai_outbox")
        .select("id,source_message_id,body,status,send_authorization,provider_message_id,created_at")
        .eq("conversation_id", conversationId)
        .eq("target_type", "client")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (contactResult.error || !contactResult.data) throw new Error("Conversation contact not found");
    if (messageResult.error) {
      throw new Error(`load preview conversation transcript: ${messageResult.error.message}`);
    }
    if (incidentResult.error) {
      throw new Error(`load preview conversation incidents: ${incidentResult.error.message}`);
    }
    if (outboxResult.error) {
      throw new Error(`load preview conversation candidates: ${outboxResult.error.message}`);
    }

    const contact = object(contactResult.data, "contact");
    const messages: ConversationMessageView[] = array(messageResult.data)
      .map((value) => {
        const row = object(value, "message");
        return {
          id: string(row.id, "message id"),
          direction: row.direction === "outbound" ? "outbound" : "inbound",
          kind: string(row.kind, "message kind"),
          text: typeof row.text_body === "string" ? row.text_body.slice(0, 12_000) : "",
          aiGenerated: row.ai_generated === true,
          deliveryStatus: string(row.delivery_status, "delivery status"),
          providerTimestamp: optionalString(row.provider_timestamp),
          createdAt: string(row.created_at, "message created_at"),
          media: row.media ? (row.media as JsonValue) : null,
        } satisfies ConversationMessageView;
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.providerTimestamp ?? left.createdAt);
        const rightTime = Date.parse(right.providerTimestamp ?? right.createdAt);
        return leftTime - rightTime || Date.parse(left.createdAt) - Date.parse(right.createdAt);
      });

    const latestMessage = messages.at(-1);
    const conversation: ConversationSummary = {
      id: conversationId,
      contactId,
      clientDisplayName:
        optionalString(contact.profile_name) ??
        `Client •••• ${phoneEnding(contact.wa_id)}`,
      phoneEnding: phoneEnding(contact.wa_id),
      preferredLanguage: optionalString(contact.preferred_language),
      status: string(conversationRow.status, "conversation status") as ConversationSummary["status"],
      operatingMode: conversationRow.operating_mode === "management" ? "management" : "ai",
      currentRisk: risk(conversationRow.current_risk),
      humanTakeoverUntil: optionalString(conversationRow.human_takeover_until),
      lastMessageAt:
        latestMessage?.providerTimestamp ??
        latestMessage?.createdAt ??
        string(conversationRow.last_message_at, "last_message_at"),
      lastMessagePreview: latestMessage ? preview(latestMessage.text) : "",
      lastMessageDirection: latestMessage?.direction ?? null,
      openTaskCount: 0,
      highestPriority: null,
    };

    const incidents: IncidentView[] = array(incidentResult.data).map((value) => {
      const row = object(value, "incident");
      return {
        id: string(row.id, "incident id"),
        category: string(row.category, "incident category"),
        severity: risk(row.severity) as IncidentView["severity"],
        status: string(row.status, "incident status"),
        clientSummary: string(row.client_summary, "client summary"),
        createdAt: string(row.created_at, "incident created_at"),
        updatedAt: string(row.updated_at, "incident updated_at"),
      };
    });

    const candidates: CandidateReplyView[] = array(outboxResult.data).map((value) => {
      const row = object(value, "outbox candidate");
      const body = row.body && typeof row.body === "object"
        ? object(row.body, "outbox body")
        : {};
      return {
        id: string(row.id, "outbox id"),
        sourceMessageId: optionalString(row.source_message_id),
        text: typeof body.text === "string" ? body.text : "",
        status: string(row.status, "outbox status"),
        authorization: string(row.send_authorization, "send authorization"),
        providerMessageId: optionalString(row.provider_message_id),
        createdAt: string(row.created_at, "outbox created_at"),
      };
    });

    return {
      conversation,
      messages,
      tasks: [],
      notes: [],
      incidents,
      candidates,
      decisions: [],
      jobs: [],
    };
  }

  async dashboard(mode: "shadow" | "live"): Promise<CommandCentreDashboard> {
    const [conversations, jobsActive, jobsDead, outboxActive, outboxDead, providerSends, incidents, qualityResult, auditResult] =
      await Promise.all([
        this.listConversations({ limit: 60 }),
        this.database.from("ai_jobs").select("id", { count: "exact", head: true }).in("status", ["pending", "processing", "retry"]),
        this.database.from("ai_jobs").select("id", { count: "exact", head: true }).eq("status", "dead"),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "processing", "retry"]),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).eq("status", "dead"),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).not("provider_message_id", "is", null),
        this.database.from("ai_incidents").select("id,severity,status").in("status", ["open", "monitoring"]),
        this.database.rpc("ai_shadow_quality_snapshot", {
          p_since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        }),
        this.database
          .from("ai_audit_log")
          .select("id,event_type,target_type,target_id,actor_id,details,created_at")
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

    const errors = [
      jobsActive.error,
      jobsDead.error,
      outboxActive.error,
      outboxDead.error,
      providerSends.error,
      incidents.error,
      qualityResult.error,
      auditResult.error,
    ].filter(Boolean);
    if (errors.length > 0) {
      throw new Error(`load preview command centre dashboard: ${errors[0]?.message}`);
    }

    const incidentRows = array(incidents.data).map((value) => object(value, "incident"));
    const quality = qualityResult.data && typeof qualityResult.data === "object"
      ? object(qualityResult.data, "quality snapshot")
      : {};
    const activeJobs = jobsActive.count ?? 0;
    const deadJobs = jobsDead.count ?? 0;
    const activeOutbox = outboxActive.count ?? 0;
    const deadOutbox = outboxDead.count ?? 0;
    const criticalIncidents = incidentRows.filter((row) => row.severity === "black").length;
    const readiness =
      deadJobs > 0 || deadOutbox > 0 || criticalIncidents > 0
        ? "critical"
        : activeJobs > 0 || activeOutbox > 0 || incidentRows.length > 0
          ? "attention"
          : "healthy";

    return {
      generatedAt: new Date().toISOString(),
      mode,
      readiness,
      counts: {
        needsAction: 0,
        overdueTasks: 0,
        humanHandling: conversations.filter((item) => item.operatingMode === "management").length,
        aiHandling: conversations.filter((item) => item.operatingMode === "ai").length,
        waitingClient: 0,
        waitingInternal: 0,
        openIncidents: incidentRows.length,
        criticalIncidents,
        activeJobs,
        deadJobs,
        activeOutbox,
        deadOutbox,
        providerSends: providerSends.count ?? 0,
      },
      quality: {
        eligibleCases: qualityNumber(quality, "eligibleCases"),
        humanReviewedCases: qualityNumber(quality, "humanReviewedCases"),
        launchMetricCases: qualityNumber(quality, "launchMetricCases"),
        passCases: qualityNumber(quality, "passCases"),
        failCases: qualityNumber(quality, "failCases"),
        needsReviewCases: qualityNumber(quality, "needsReviewCases"),
        passRate: qualityNumber(quality, "passRate"),
      },
      priorityTasks: [],
      recentConversations: conversations.slice(0, 12),
      recentAudit: array(auditResult.data).map((value) => {
        const row = object(value, "audit event");
        return {
          id: string(row.id, "audit id"),
          eventType: string(row.event_type, "event type"),
          targetType: string(row.target_type, "target type"),
          targetId: optionalString(row.target_id),
          actorId: optionalString(row.actor_id),
          createdAt: string(row.created_at, "audit created_at"),
          details: (row.details ?? {}) as JsonValue,
        };
      }),
    };
  }
}
