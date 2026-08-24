import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";
import type { JsonValue, RiskLevel } from "../types.js";
import type {
  CandidateReplyView,
  CommandCentreDashboard,
  CommandCentreNoteView,
  ConversationDetail,
  ConversationMessageView,
  ConversationSummary,
  CreateHandoffTaskInput,
  HandoffPriority,
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

function number(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}`);
  return parsed;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function phoneEnding(waId: unknown): string {
  return typeof waId === "string" && waId.length >= 4 ? waId.slice(-4) : "—";
}

function preview(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 180);
}

function risk(value: unknown): RiskLevel {
  if (value === "amber" || value === "red" || value === "black") return value;
  return "green";
}

function priorityRank(value: HandoffPriority): number {
  return { normal: 0, high: 1, urgent: 2, emergency: 3 }[value];
}

function isOpenTaskStatus(value: HandoffStatus): boolean {
  return value !== "resolved" && value !== "cancelled";
}

interface TaskListInput {
  status?: HandoffStatus | "open" | null;
  conversationId?: string | null;
  limit?: number;
}

export class SupabaseCommandCentreRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-command-centre/1.0" } },
    });
  }

  async listTasks(input: TaskListInput = {}): Promise<HandoffTaskSummary[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    let query = this.database
      .from("ai_handoff_tasks")
      .select(
        "id,conversation_id,source_message_id,incident_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,summary,requested_action,collected_facts,missing_facts,client_visible_status,due_at,accepted_at,resolved_at,version,created_at,updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (input.status === "open") {
      query = query.in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"]);
    } else if (input.status) {
      query = query.eq("status", input.status);
    }
    if (input.conversationId) query = query.eq("conversation_id", input.conversationId);

    const { data, error } = await query;
    if (error) throw new Error(`list command centre tasks: ${error.message}`);
    const taskRows = array(data).map((value) => object(value, "handoff task"));
    if (taskRows.length === 0) return [];

    const conversationIds = [...new Set(taskRows.map((row) => string(row.conversation_id, "conversation_id")))];
    const ownerIds = [
      ...new Set(
        taskRows
          .map((row) => optionalString(row.owner_user_id))
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    const [conversationResult, ownerResult, messageResult] = await Promise.all([
      this.database
        .from("ai_conversations")
        .select("id,contact_id,operating_mode,current_risk,last_message_at")
        .in("id", conversationIds),
      ownerIds.length
        ? this.database
            .from("ai_staff_profiles")
            .select("user_id,display_name")
            .in("user_id", ownerIds)
        : Promise.resolve({ data: [], error: null }),
      this.database
        .from("ai_messages")
        .select("id,conversation_id,direction,text_body,created_at,provider_timestamp")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(Math.min(2000, conversationIds.length * 20)),
    ]);
    if (conversationResult.error) throw new Error(`load task conversations: ${conversationResult.error.message}`);
    if (ownerResult.error) throw new Error(`load task owners: ${ownerResult.error.message}`);
    if (messageResult.error) throw new Error(`load task messages: ${messageResult.error.message}`);

    const conversationRows = array(conversationResult.data).map((value) => object(value, "conversation"));
    const contactIds = [...new Set(conversationRows.map((row) => string(row.contact_id, "contact_id")))];
    const contactResult = await this.database
      .from("ai_contacts")
      .select("id,profile_name,wa_id")
      .in("id", contactIds);
    if (contactResult.error) throw new Error(`load task contacts: ${contactResult.error.message}`);

    const conversations = new Map(conversationRows.map((row) => [string(row.id, "conversation id"), row]));
    const contacts = new Map(
      array(contactResult.data).map((value) => {
        const row = object(value, "contact");
        return [string(row.id, "contact id"), row] as const;
      }),
    );
    const owners = new Map(
      array(ownerResult.data).map((value) => {
        const row = object(value, "owner");
        return [string(row.user_id, "owner id"), string(row.display_name, "owner display name")] as const;
      }),
    );
    const latestMessages = new Map<string, Record<string, unknown>>();
    for (const value of array(messageResult.data)) {
      const row = object(value, "message");
      const conversationId = string(row.conversation_id, "message conversation id");
      if (!latestMessages.has(conversationId)) latestMessages.set(conversationId, row);
    }

    const now = Date.now();
    return taskRows
      .map((row): HandoffTaskSummary => {
        const conversationId = string(row.conversation_id, "conversation_id");
        const conversation = conversations.get(conversationId);
        if (!conversation) throw new Error("Task conversation was not returned");
        const contact = contacts.get(string(conversation.contact_id, "contact_id"));
        if (!contact) throw new Error("Task contact was not returned");
        const latest = latestMessages.get(conversationId);
        const dueAt = optionalString(row.due_at);
        const status = string(row.status, "task status") as HandoffStatus;
        return {
          id: string(row.id, "task id"),
          conversationId,
          sourceMessageId: optionalString(row.source_message_id),
          incidentId: optionalString(row.incident_id),
          taskType: string(row.task_type, "task type") as HandoffTaskSummary["taskType"],
          scope: string(row.scope, "task scope") as HandoffTaskSummary["scope"],
          priority: string(row.priority, "task priority") as HandoffPriority,
          status,
          assignedRole: optionalString(row.assigned_role) as HandoffTaskSummary["assignedRole"],
          assignedOutlet: optionalString(row.assigned_outlet),
          ownerUserId: optionalString(row.owner_user_id),
          ownerDisplayName: optionalString(row.owner_user_id)
            ? owners.get(string(row.owner_user_id, "owner id")) ?? null
            : null,
          summary: string(row.summary, "task summary"),
          requestedAction: string(row.requested_action, "requested action"),
          collectedFacts: (row.collected_facts ?? {}) as JsonValue,
          missingFacts: (row.missing_facts ?? []) as JsonValue,
          clientVisibleStatus: optionalString(row.client_visible_status),
          dueAt,
          acceptedAt: optionalString(row.accepted_at),
          resolvedAt: optionalString(row.resolved_at),
          version: number(row.version, "task version"),
          createdAt: string(row.created_at, "task created_at"),
          updatedAt: string(row.updated_at, "task updated_at"),
          clientDisplayName: optionalString(contact.profile_name) ?? `Client •••• ${phoneEnding(contact.wa_id)}`,
          phoneEnding: phoneEnding(contact.wa_id),
          conversationRisk: risk(conversation.current_risk),
          conversationMode: conversation.operating_mode === "management" ? "management" : "ai",
          lastMessagePreview: latest ? preview(latest.text_body) : "",
          lastMessageAt:
            optionalString(latest?.provider_timestamp) ??
            optionalString(latest?.created_at) ??
            string(conversation.last_message_at, "last_message_at"),
          overdue: Boolean(dueAt && Date.parse(dueAt) < now && isOpenTaskStatus(status)),
        };
      })
      .sort((left, right) => {
        const overdueDifference = Number(right.overdue) - Number(left.overdue);
        if (overdueDifference !== 0) return overdueDifference;
        const priorityDifference = priorityRank(right.priority) - priorityRank(left.priority);
        if (priorityDifference !== 0) return priorityDifference;
        const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
        const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
        return leftDue - rightDue;
      });
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
    if (error) throw new Error(`list conversations: ${error.message}`);
    const conversationRows = array(data).map((value) => object(value, "conversation"));
    if (conversationRows.length === 0) return [];

    const conversationIds = conversationRows.map((row) => string(row.id, "conversation id"));
    const contactIds = [...new Set(conversationRows.map((row) => string(row.contact_id, "contact id")))];
    const [contactResult, messageResult, taskResult] = await Promise.all([
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
      this.database
        .from("ai_handoff_tasks")
        .select("conversation_id,status,priority")
        .in("conversation_id", conversationIds)
        .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"]),
    ]);
    if (contactResult.error) throw new Error(`load conversation contacts: ${contactResult.error.message}`);
    if (messageResult.error) throw new Error(`load conversation messages: ${messageResult.error.message}`);
    if (taskResult.error) throw new Error(`load conversation tasks: ${taskResult.error.message}`);

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
    const taskCounts = new Map<string, { count: number; highest: HandoffPriority | null }>();
    for (const value of array(taskResult.data)) {
      const row = object(value, "task");
      const conversationId = string(row.conversation_id, "task conversation id");
      const current = taskCounts.get(conversationId) ?? { count: 0, highest: null };
      const nextPriority = string(row.priority, "task priority") as HandoffPriority;
      current.count += 1;
      if (!current.highest || priorityRank(nextPriority) > priorityRank(current.highest)) {
        current.highest = nextPriority;
      }
      taskCounts.set(conversationId, current);
    }

    const search = input.search?.trim().toLowerCase() ?? "";
    return conversationRows
      .map((row): ConversationSummary => {
        const id = string(row.id, "conversation id");
        const contact = contacts.get(string(row.contact_id, "contact id"));
        if (!contact) throw new Error("Conversation contact was not returned");
        const latest = latestMessages.get(id);
        const tasks = taskCounts.get(id) ?? { count: 0, highest: null };
        return {
          id,
          contactId: string(row.contact_id, "contact id"),
          clientDisplayName: optionalString(contact.profile_name) ?? `Client •••• ${phoneEnding(contact.wa_id)}`,
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
          openTaskCount: tasks.count,
          highestPriority: tasks.highest,
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

    const [contactResult, messageResult, taskList, noteResult, incidentResult, outboxResult] = await Promise.all([
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
      this.listTasks({ conversationId, limit: 100 }),
      this.database
        .from("ai_command_centre_notes")
        .select("id,body,author_user_id,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(100),
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
    if (messageResult.error) throw new Error(`load conversation transcript: ${messageResult.error.message}`);
    if (noteResult.error) throw new Error(`load conversation notes: ${noteResult.error.message}`);
    if (incidentResult.error) throw new Error(`load conversation incidents: ${incidentResult.error.message}`);
    if (outboxResult.error) throw new Error(`load conversation candidates: ${outboxResult.error.message}`);

    const contact = object(contactResult.data, "contact");
    const noteRows = array(noteResult.data).map((value) => object(value, "note"));
    const authorIds = [
      ...new Set(noteRows.map((row) => string(row.author_user_id, "note author id"))),
    ];
    const authorResult = authorIds.length
      ? await this.database
          .from("ai_staff_profiles")
          .select("user_id,display_name")
          .in("user_id", authorIds)
      : { data: [], error: null };
    if (authorResult.error) throw new Error(`load note authors: ${authorResult.error.message}`);
    const authors = new Map(
      array(authorResult.data).map((value) => {
        const row = object(value, "note author");
        return [string(row.user_id, "author id"), string(row.display_name, "author name")] as const;
      }),
    );

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
    const tasks = taskList;
    const openTasks = tasks.filter((task) => isOpenTaskStatus(task.status));
    const highestPriority = openTasks.reduce<HandoffPriority | null>((highest, task) => {
      if (!highest || priorityRank(task.priority) > priorityRank(highest)) return task.priority;
      return highest;
    }, null);

    const conversation: ConversationSummary = {
      id: conversationId,
      contactId,
      clientDisplayName: optionalString(contact.profile_name) ?? `Client •••• ${phoneEnding(contact.wa_id)}`,
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
      openTaskCount: openTasks.length,
      highestPriority,
    };

    const notes: CommandCentreNoteView[] = noteRows.map((row) => ({
      id: string(row.id, "note id"),
      body: string(row.body, "note body"),
      authorDisplayName:
        authors.get(string(row.author_user_id, "note author id")) ?? "Hera staff",
      createdAt: string(row.created_at, "note created_at"),
    }));

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
      const body = row.body && typeof row.body === "object" ? object(row.body, "outbox body") : {};
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

    return { conversation, messages, tasks, notes, incidents, candidates };
  }

  async dashboard(mode: "shadow" | "live"): Promise<CommandCentreDashboard> {
    const [tasks, conversations, jobsActive, jobsDead, outboxActive, outboxDead, providerSends, incidents, qualityResult, auditResult] =
      await Promise.all([
        this.listTasks({ status: "open", limit: 100 }),
        this.listConversations({ limit: 60 }),
        this.database.from("ai_jobs").select("id", { count: "exact", head: true }).in("status", ["pending", "processing", "retry"]),
        this.database.from("ai_jobs").select("id", { count: "exact", head: true }).eq("status", "dead"),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "processing", "retry"]),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).eq("status", "dead"),
        this.database.from("ai_outbox").select("id", { count: "exact", head: true }).not("provider_message_id", "is", null),
        this.database.from("ai_incidents").select("id,severity,status").in("status", ["open", "monitoring"]),
        this.database.rpc("ai_shadow_quality_snapshot", { p_since: new Date(Date.now() - 7 * 86_400_000).toISOString() }),
        this.database
          .from("ai_audit_log")
          .select("id,event_type,target_type,target_id,actor_id,details,created_at")
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

    const errors = [jobsActive.error, jobsDead.error, outboxActive.error, outboxDead.error, providerSends.error, incidents.error, qualityResult.error, auditResult.error].filter(Boolean);
    if (errors.length > 0) throw new Error(`load command centre dashboard: ${errors[0]?.message}`);

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
        : activeJobs > 0 || activeOutbox > 0 || incidentRows.length > 0 || tasks.some((task) => task.overdue)
          ? "attention"
          : "healthy";

    return {
      generatedAt: new Date().toISOString(),
      mode,
      readiness,
      counts: {
        needsAction: tasks.filter((task) => task.status === "new" || task.status === "assigned").length,
        overdueTasks: tasks.filter((task) => task.overdue).length,
        humanHandling: conversations.filter((conversation) => conversation.operatingMode === "management").length,
        aiHandling: conversations.filter((conversation) => conversation.operatingMode === "ai").length,
        waitingClient: tasks.filter((task) => task.status === "waiting_client").length,
        waitingInternal: tasks.filter((task) => task.status === "waiting_internal").length,
        openIncidents: incidentRows.length,
        criticalIncidents,
        activeJobs,
        deadJobs,
        activeOutbox,
        deadOutbox,
        providerSends: providerSends.count ?? 0,
      },
      quality: {
        eligibleCases: Number(quality.eligibleCases ?? 0),
        humanReviewedCases: Number(quality.humanReviewedCases ?? 0),
        launchMetricCases: Number(quality.launchMetricCases ?? 0),
        passCases: Number(quality.passCases ?? 0),
        failCases: Number(quality.failCases ?? 0),
        needsReviewCases: Number(quality.needsReviewCases ?? 0),
        passRate: Number(quality.passRate ?? 0),
      },
      priorityTasks: tasks.slice(0, 12),
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

  async createTask(input: CreateHandoffTaskInput, actorUserId: string): Promise<JsonValue> {
    let dueAt = input.dueAt ?? null;
    if (!dueAt) {
      const { data } = await this.database
        .from("ai_handoff_sla_policies")
        .select("target_minutes")
        .eq("task_type", input.taskType)
        .eq("priority", input.priority)
        .eq("active", true)
        .maybeSingle();
      const targetMinutes = data && typeof data.target_minutes === "number" ? data.target_minutes : 30;
      dueAt = new Date(Date.now() + targetMinutes * 60_000).toISOString();
    }
    const { data, error } = await this.database.rpc("ai_cc_create_task", {
      p_conversation_id: input.conversationId,
      p_source_message_id: input.sourceMessageId ?? null,
      p_incident_id: input.incidentId ?? null,
      p_task_type: input.taskType,
      p_scope: input.scope,
      p_priority: input.priority,
      p_assigned_role: input.assignedRole ?? null,
      p_assigned_outlet: input.assignedOutlet ?? null,
      p_summary: input.summary,
      p_requested_action: input.requestedAction,
      p_collected_facts: input.collectedFacts ?? {},
      p_missing_facts: input.missingFacts ?? [],
      p_client_visible_status: input.clientVisibleStatus ?? null,
      p_due_at: dueAt,
      p_dedupe_key: input.dedupeKey,
      p_actor_user_id: actorUserId,
    });
    if (error) throw new Error(`create handoff task: ${error.message}`);
    return data as JsonValue;
  }

  async acceptTask(taskId: string, actorUserId: string, expectedVersion: number): Promise<JsonValue> {
    const { data, error } = await this.database.rpc("ai_cc_accept_task", {
      p_task_id: taskId,
      p_actor_user_id: actorUserId,
      p_expected_version: expectedVersion,
    });
    if (error) throw new Error(`accept handoff task: ${error.message}`);
    return data as JsonValue;
  }

  async assignTask(input: {
    taskId: string;
    actorUserId: string;
    ownerUserId: string;
    expectedVersion: number;
  }): Promise<JsonValue> {
    const { data, error } = await this.database.rpc("ai_cc_assign_task", {
      p_task_id: input.taskId,
      p_actor_user_id: input.actorUserId,
      p_owner_user_id: input.ownerUserId,
      p_expected_version: input.expectedVersion,
    });
    if (error) throw new Error(`assign handoff task: ${error.message}`);
    return data as JsonValue;
  }

  async transitionTask(input: {
    taskId: string;
    actorUserId: string;
    expectedVersion: number;
    toStatus: HandoffStatus;
    note?: string | null;
    resolution?: JsonValue;
  }): Promise<JsonValue> {
    const { data, error } = await this.database.rpc("ai_cc_transition_task", {
      p_task_id: input.taskId,
      p_actor_user_id: input.actorUserId,
      p_expected_version: input.expectedVersion,
      p_to_status: input.toStatus,
      p_note: input.note ?? null,
      p_resolution: input.resolution ?? {},
    });
    if (error) throw new Error(`transition handoff task: ${error.message}`);
    return data as JsonValue;
  }

  async setConversationMode(input: {
    conversationId: string;
    actorUserId: string;
    mode: "ai" | "management";
    reason: string;
    takeoverUntil?: string | null;
  }): Promise<JsonValue> {
    const { data, error } = await this.database.rpc("ai_cc_set_conversation_mode", {
      p_conversation_id: input.conversationId,
      p_actor_user_id: input.actorUserId,
      p_mode: input.mode,
      p_reason: input.reason,
      p_takeover_until: input.mode === "management" ? input.takeoverUntil ?? null : null,
    });
    if (error) throw new Error(`set conversation mode: ${error.message}`);
    return data as JsonValue;
  }

  async addNote(input: {
    conversationId: string;
    taskId?: string | null;
    actorUserId: string;
    body: string;
  }): Promise<JsonValue> {
    const { data, error } = await this.database.rpc("ai_cc_add_note", {
      p_conversation_id: input.conversationId,
      p_task_id: input.taskId ?? null,
      p_actor_user_id: input.actorUserId,
      p_body: input.body,
    });
    if (error) throw new Error(`add command centre note: ${error.message}`);
    return data as JsonValue;
  }
}
