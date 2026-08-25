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
  return typeof value === "string" && value
    ? createHash("sha256").update(value).digest("hex").slice(0, 12)
    : null;
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
  ) return "acknowledgement_only";
  if (normalized.length <= 4) return "very_short";
  return "substantive";
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("stage0_residue_lines_requires_authoritative_preview_branch");
  }
  if (getOperationsConfig().sendMode !== "shadow") {
    throw new Error("stage0_residue_lines_requires_shadow_mode");
  }

  const database = getDatabaseConfig();
  const client = createClient(database.url, database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage0-residue-lines" } },
  });

  const [incidentResult, openTaskResult, managementResult] = await Promise.all([
    client
      .from("ai_incidents")
      .select("id,conversation_id,source_message_id,category,severity,status,resolution,created_at,updated_at")
      .in("status", ["open", "monitoring"])
      .order("created_at", { ascending: true }),
    client
      .from("ai_handoff_tasks")
      .select("id,conversation_id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,due_at,created_at,updated_at,resolved_at")
      .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"])
      .order("created_at", { ascending: true }),
    client
      .from("ai_conversations")
      .select("id,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
      .eq("status", "active")
      .eq("operating_mode", "management")
      .order("updated_at", { ascending: true }),
  ]);
  for (const result of [incidentResult, openTaskResult, managementResult]) {
    if (result.error) throw result.error;
  }

  const incidents = incidentResult.data ?? [];
  const openTasks = openTaskResult.data ?? [];
  const management = managementResult.data ?? [];
  const incidentConversationIds = [
    ...new Set(incidents.map((incident) => incident.conversation_id)),
  ];
  const allIncidentTasksResult = incidentConversationIds.length
    ? await client
        .from("ai_handoff_tasks")
        .select("id,conversation_id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,created_at,updated_at,resolved_at")
        .in("conversation_id", incidentConversationIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (allIncidentTasksResult.error) throw allIncidentTasksResult.error;
  const allIncidentTasks = allIncidentTasksResult.data ?? [];

  const sourceIds = [
    ...new Set(
      [...incidents, ...openTasks, ...allIncidentTasks]
        .map((item) => item.source_message_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  const messagesResult = sourceIds.length
    ? await client
        .from("ai_messages")
        .select("id,conversation_id,direction,kind,text_body,provider_timestamp,created_at")
        .in("id", sourceIds)
    : { data: [], error: null };
  if (messagesResult.error) throw messagesResult.error;
  const messageById = new Map(
    (messagesResult.data ?? []).map((message) => [message.id, message]),
  );

  const relevantConversationIds = [
    ...new Set([
      ...incidents.map((incident) => incident.conversation_id),
      ...openTasks.map((task) => task.conversation_id),
    ]),
  ];
  const conversationResult = relevantConversationIds.length
    ? await client
        .from("ai_conversations")
        .select("id,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
        .in("id", relevantConversationIds)
    : { data: [], error: null };
  if (conversationResult.error) throw conversationResult.error;
  const conversationById = new Map(
    (conversationResult.data ?? []).map((conversation) => [conversation.id, conversation]),
  );

  function sourceSummary(sourceMessageId: string | null) {
    const message = sourceMessageId ? messageById.get(sourceMessageId) : null;
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
      createdAt: message?.created_at ?? null,
    };
  }

  for (const incident of incidents) {
    const conversation = conversationById.get(incident.conversation_id);
    const relatedTasks = allIncidentTasks.filter(
      (task) => task.conversation_id === incident.conversation_id,
    );
    console.log(
      "HERA_STAGE0_INCIDENT",
      JSON.stringify({
        incidentFingerprint: fp(incident.id),
        conversationFingerprint: fp(incident.conversation_id),
        category: incident.category,
        severity: incident.severity,
        status: incident.status,
        hasResolution: Boolean(incident.resolution),
        createdAt: incident.created_at,
        updatedAt: incident.updated_at,
        conversationMode: conversation?.operating_mode ?? null,
        conversationRisk: conversation?.current_risk ?? null,
        humanTakeoverUntil: conversation?.human_takeover_until ?? null,
        relatedTasks: relatedTasks.map((task) => ({
          taskFingerprint: fp(task.id),
          sourceFingerprint: fp(task.source_message_id),
          type: task.task_type,
          scope: task.scope,
          priority: task.priority,
          status: task.status,
          assignedRole: task.assigned_role,
          ownerRecorded: Boolean(task.owner_user_id),
          resolvedAt: task.resolved_at,
        })),
        ...sourceSummary(incident.source_message_id),
      }),
    );
  }

  for (const task of openTasks) {
    const conversation = conversationById.get(task.conversation_id);
    console.log(
      "HERA_STAGE0_OPEN_TASK",
      JSON.stringify({
        taskFingerprint: fp(task.id),
        conversationFingerprint: fp(task.conversation_id),
        type: task.task_type,
        scope: task.scope,
        priority: task.priority,
        status: task.status,
        assignedRole: task.assigned_role,
        assignedOutlet: task.assigned_outlet,
        ownerRecorded: Boolean(task.owner_user_id),
        dueAt: task.due_at,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        conversationMode: conversation?.operating_mode ?? null,
        conversationRisk: conversation?.current_risk ?? null,
        humanTakeoverUntil: conversation?.human_takeover_until ?? null,
        ...sourceSummary(task.source_message_id),
      }),
    );
  }

  const openTaskConversationIds = new Set(openTasks.map((task) => task.conversation_id));
  const openIncidentConversationIds = new Set(
    incidents.map((incident) => incident.conversation_id),
  );
  const now = Date.now();
  console.log(
    "HERA_STAGE0_MANAGEMENT_SUMMARY",
    JSON.stringify({
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
      futureTakeover: management.filter((conversation) => {
        const until = Date.parse(conversation.human_takeover_until ?? "");
        return Number.isFinite(until) && until >= now;
      }).length,
      indefiniteTakeover: management.filter(
        (conversation) => conversation.human_takeover_until === null,
      ).length,
      databaseMutationAttempted: false,
      whatsappProviderSendAttempted: false,
    }),
  );
}

await main();
