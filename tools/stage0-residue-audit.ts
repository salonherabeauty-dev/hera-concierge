import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig, getOperationsConfig } from "../src/config.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const KNOWN_CONTROLLED_MESSAGE_IDS = new Set([
  "17c7a7bd-d89f-4c01-afc9-fc8d0556cfbb",
  "9cac9cbe-b819-431f-b8f6-16f79494832d",
  "46674ef8-b79c-436e-a692-d6c8bfde883c",
  "6a62b484-f22e-46f1-b7a6-38358fdce44d",
]);

function fp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function classifyText(value: unknown): string {
  if (typeof value !== "string") return "non_text";
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return "empty";
  if (/^hera(?: ai)? .*test/.test(normalized) || normalized.includes("staging test")) {
    return "controlled_test_marker";
  }
  if (
    [
      "ok",
      "okay",
      "k",
      "sure",
      "noted",
      "thanks",
      "thank you",
      "thankyou",
      "alright",
      "all right",
    ].includes(normalized)
  ) {
    return "acknowledgement_only";
  }
  if (normalized.length <= 4) return "very_short";
  return "substantive";
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("stage0_residue_audit_requires_authoritative_preview_branch");
  }
  if (getOperationsConfig().sendMode !== "shadow") {
    throw new Error("stage0_residue_audit_requires_shadow_mode");
  }

  const database = getDatabaseConfig();
  const client = createClient(database.url, database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage0-residue-audit" } },
  });

  const [jobsResult, incidentsResult, tasksResult, managementResult] =
    await Promise.all([
      client
        .from("ai_jobs")
        .select("id,source_message_id,status,attempts,max_attempts,available_at,locked_at,created_at,updated_at,last_error")
        .in("status", ["pending", "processing", "retry", "dead"])
        .order("created_at", { ascending: true })
        .limit(100),
      client
        .from("ai_incidents")
        .select("id,conversation_id,source_message_id,category,severity,status,evidence,resolution,created_at,updated_at")
        .in("status", ["open", "monitoring"])
        .order("created_at", { ascending: true })
        .limit(100),
      client
        .from("ai_handoff_tasks")
        .select("id,conversation_id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,due_at,created_at,updated_at,resolved_at")
        .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"])
        .order("created_at", { ascending: true })
        .limit(100),
      client
        .from("ai_conversations")
        .select("id,status,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
        .eq("status", "active")
        .eq("operating_mode", "management")
        .order("updated_at", { ascending: true })
        .limit(500),
    ]);

  for (const result of [jobsResult, incidentsResult, tasksResult, managementResult]) {
    if (result.error) throw result.error;
  }

  const jobs = jobsResult.data ?? [];
  const incidents = incidentsResult.data ?? [];
  const tasks = tasksResult.data ?? [];
  const management = managementResult.data ?? [];
  const sourceIds = [
    ...new Set(
      [...jobs, ...incidents, ...tasks]
        .map((item) => item.source_message_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];

  const messagesResult = sourceIds.length
    ? await client
        .from("ai_messages")
        .select("id,conversation_id,contact_id,direction,kind,text_body,provider_timestamp,created_at")
        .in("id", sourceIds)
    : { data: [], error: null };
  if (messagesResult.error) throw messagesResult.error;
  const messages = messagesResult.data ?? [];
  const messageById = new Map(messages.map((message) => [message.id, message]));

  const conversationIds = [
    ...new Set(
      [
        ...messages.map((message) => message.conversation_id),
        ...incidents.map((incident) => incident.conversation_id),
        ...tasks.map((task) => task.conversation_id),
      ].filter((value): value is string => typeof value === "string"),
    ),
  ];
  const conversationsResult = conversationIds.length
    ? await client
        .from("ai_conversations")
        .select("id,status,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
        .in("id", conversationIds)
    : { data: [], error: null };
  if (conversationsResult.error) throw conversationsResult.error;
  const conversationById = new Map(
    (conversationsResult.data ?? []).map((conversation) => [conversation.id, conversation]),
  );

  const contactIds = [
    ...new Set(
      messages
        .map((message) => message.contact_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  const contactsResult = contactIds.length
    ? await client.from("ai_contacts").select("id").in("id", contactIds)
    : { data: [], error: null };
  if (contactsResult.error) throw contactsResult.error;
  const contactFingerprints = new Map(
    (contactsResult.data ?? []).map((contact) => [contact.id, fp(contact.id)]),
  );

  const [decisionsResult, outboxResult, auditResult] = await Promise.all([
    sourceIds.length
      ? client
          .from("ai_decisions")
          .select("source_message_id,stage,created_at")
          .in("source_message_id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
    sourceIds.length
      ? client
          .from("ai_outbox")
          .select("source_message_id,status,provider_message_id,created_at")
          .in("source_message_id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
    sourceIds.length
      ? client
          .from("ai_audit_log")
          .select("event_type,target_type,target_id,details,created_at")
          .in("target_id", sourceIds)
          .order("created_at", { ascending: true })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of [decisionsResult, outboxResult, auditResult]) {
    if (result.error) throw result.error;
  }

  const decisionsBySource = new Map<string, string[]>();
  for (const decision of decisionsResult.data ?? []) {
    const stages = decisionsBySource.get(decision.source_message_id) ?? [];
    stages.push(decision.stage);
    decisionsBySource.set(decision.source_message_id, stages);
  }
  const outboxBySource = new Map<string, Array<{ status: string; providerId: boolean }>>();
  for (const item of outboxResult.data ?? []) {
    const values = outboxBySource.get(item.source_message_id) ?? [];
    values.push({ status: item.status, providerId: Boolean(item.provider_message_id) });
    outboxBySource.set(item.source_message_id, values);
  }
  const auditsBySource = new Map<string, string[]>();
  for (const audit of auditResult.data ?? []) {
    const values = auditsBySource.get(audit.target_id) ?? [];
    values.push(audit.event_type);
    auditsBySource.set(audit.target_id, values);
  }

  function sourceSummary(sourceMessageId: string | null) {
    const message = sourceMessageId ? messageById.get(sourceMessageId) : null;
    const conversation = message
      ? conversationById.get(message.conversation_id)
      : null;
    return {
      sourceFingerprint: fp(sourceMessageId),
      knownControlledMessage: sourceMessageId
        ? KNOWN_CONTROLLED_MESSAGE_IDS.has(sourceMessageId)
        : false,
      messageClass: classifyText(message?.text_body),
      textLength:
        typeof message?.text_body === "string" ? message.text_body.length : null,
      direction: message?.direction ?? null,
      kind: message?.kind ?? null,
      providerTimestamp: message?.provider_timestamp ?? null,
      messageCreatedAt: message?.created_at ?? null,
      contactFingerprint: message
        ? contactFingerprints.get(message.contact_id) ?? fp(message.contact_id)
        : null,
      conversationFingerprint: message
        ? fp(message.conversation_id)
        : null,
      conversationMode: conversation?.operating_mode ?? null,
      conversationRisk: conversation?.current_risk ?? null,
      humanTakeoverUntil: conversation?.human_takeover_until ?? null,
      decisionStages: sourceMessageId
        ? [...new Set(decisionsBySource.get(sourceMessageId) ?? [])]
        : [],
      outbox: sourceMessageId ? outboxBySource.get(sourceMessageId) ?? [] : [],
      auditEvents: sourceMessageId
        ? [...new Set(auditsBySource.get(sourceMessageId) ?? [])]
        : [],
    };
  }

  const now = Date.now();
  const openTaskConversationIds = new Set(tasks.map((task) => task.conversation_id));
  const openIncidentConversationIds = new Set(
    incidents.map((incident) => incident.conversation_id),
  );

  console.log(
    "HERA_STAGE0_RESIDUE_DETAIL",
    JSON.stringify({
      jobs: jobs.map((job) => ({
        jobFingerprint: fp(job.id),
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        availableAt: job.available_at,
        lockedAt: job.locked_at,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        errorClass:
          typeof job.last_error === "string" && /no object generated|schema/i.test(job.last_error)
            ? "structured_output_failure"
            : job.last_error
              ? "other_error"
              : null,
        ...sourceSummary(job.source_message_id),
      })),
      incidents: incidents.map((incident) => ({
        incidentFingerprint: fp(incident.id),
        conversationFingerprint: fp(incident.conversation_id),
        category: incident.category,
        severity: incident.severity,
        status: incident.status,
        evidenceKeys:
          incident.evidence && typeof incident.evidence === "object"
            ? Object.keys(incident.evidence).sort()
            : [],
        hasResolution: Boolean(incident.resolution),
        createdAt: incident.created_at,
        updatedAt: incident.updated_at,
        associatedOpenTaskCount: tasks.filter(
          (task) => task.conversation_id === incident.conversation_id,
        ).length,
        ...sourceSummary(incident.source_message_id),
      })),
      tasks: tasks.map((task) => ({
        taskFingerprint: fp(task.id),
        conversationFingerprint: fp(task.conversation_id),
        taskType: task.task_type,
        scope: task.scope,
        priority: task.priority,
        status: task.status,
        assignedRole: task.assigned_role,
        assignedOutlet: task.assigned_outlet,
        ownerRecorded: Boolean(task.owner_user_id),
        dueAt: task.due_at,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        resolvedAt: task.resolved_at,
        ...sourceSummary(task.source_message_id),
      })),
      managementSummary: {
        total: management.length,
        withOpenTask: management.filter((conversation) =>
          openTaskConversationIds.has(conversation.id),
        ).length,
        withOpenIncident: management.filter((conversation) =>
          openIncidentConversationIds.has(conversation.id),
        ).length,
        withoutOpenWork: management.filter(
          (conversation) =>
            !openTaskConversationIds.has(conversation.id) &&
            !openIncidentConversationIds.has(conversation.id),
        ).length,
        expiredTakeover: management.filter((conversation) => {
          const until = Date.parse(conversation.human_takeover_until ?? "");
          return Number.isFinite(until) && until < now;
        }).length,
        indefiniteTakeover: management.filter(
          (conversation) => conversation.human_takeover_until === null,
        ).length,
      },
      databaseMutationAttempted: false,
      whatsappProviderSendAttempted: false,
    }),
  );
}

await main();
