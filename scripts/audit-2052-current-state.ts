import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function preview(value: unknown, max = 260): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("audit_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("audit_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("audit_refuses_live_confirmation");
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-staging-queue-audit" } },
});

const { data: contacts, error: contactsError } = await supabase
  .from("ai_contacts")
  .select("id,wa_id,profile_name,last_seen_at")
  .like("wa_id", "%2052")
  .order("last_seen_at", { ascending: false })
  .limit(3);
if (contactsError) throw contactsError;
if (!contacts?.length) throw new Error("contact_ending_2052_not_found");
const contact = contacts[0];

const { data: conversations, error: conversationsError } = await supabase
  .from("ai_conversations")
  .select("id,status,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationsError) throw conversationsError;
if (!conversations?.length) throw new Error("conversation_not_found");
const conversation = conversations.find((item) => item.status === "active") ?? conversations[0];

const { data: messages, error: messagesError } = await supabase
  .from("ai_messages")
  .select("id,direction,kind,text_body,ai_generated,delivery_status,provider_timestamp,created_at")
  .eq("conversation_id", conversation.id)
  .order("created_at", { ascending: false })
  .limit(20);
if (messagesError) throw messagesError;
const messageIds = (messages ?? []).map((item) => item.id);

const [jobsResult, decisionsResult, outboxResult, tasksResult] = await Promise.all([
  messageIds.length
    ? supabase.from("ai_jobs").select("id,source_message_id,status,attempts,max_attempts,available_at,locked_at,completed_at,last_error,created_at,updated_at").in("source_message_id", messageIds).order("created_at")
    : Promise.resolve({ data: [], error: null }),
  messageIds.length
    ? supabase.from("ai_decisions").select("source_message_id,stage,model_id,prompt_version,policy_version,risk,confidence,created_at").in("source_message_id", messageIds).order("created_at")
    : Promise.resolve({ data: [], error: null }),
  messageIds.length
    ? supabase.from("ai_outbox").select("id,source_message_id,target_type,send_authorization,status,attempts,provider_message_id,last_error,created_at,updated_at").in("source_message_id", messageIds).order("created_at")
    : Promise.resolve({ data: [], error: null }),
  supabase.from("ai_handoff_tasks").select("id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,version,summary,created_at,updated_at,resolved_at").eq("conversation_id", conversation.id).order("created_at"),
]);
if (jobsResult.error) throw jobsResult.error;
if (decisionsResult.error) throw decisionsResult.error;
if (outboxResult.error) throw outboxResult.error;
if (tasksResult.error) throw tasksResult.error;

const jobsByMessage = new Map<string, unknown[]>();
for (const job of jobsResult.data ?? []) {
  const key = String(job.source_message_id);
  const list = jobsByMessage.get(key) ?? [];
  list.push({
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    availableAt: job.available_at,
    lockedAt: job.locked_at,
    completedAt: job.completed_at,
    lastError: preview(job.last_error, 500),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
  jobsByMessage.set(key, list);
}

const decisionsByMessage = new Map<string, unknown[]>();
for (const decision of decisionsResult.data ?? []) {
  const key = String(decision.source_message_id);
  const list = decisionsByMessage.get(key) ?? [];
  list.push({
    stage: decision.stage,
    modelId: decision.model_id,
    promptVersion: decision.prompt_version,
    policyVersion: decision.policy_version,
    risk: decision.risk,
    confidence: decision.confidence,
    createdAt: decision.created_at,
  });
  decisionsByMessage.set(key, list);
}

const outboxByMessage = new Map<string, unknown[]>();
for (const item of outboxResult.data ?? []) {
  const key = String(item.source_message_id);
  const list = outboxByMessage.get(key) ?? [];
  list.push({
    id: item.id,
    targetType: item.target_type,
    sendAuthorization: item.send_authorization,
    status: item.status,
    attempts: item.attempts,
    providerMessageIdRecorded: Boolean(item.provider_message_id),
    lastError: preview(item.last_error, 500),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  });
  outboxByMessage.set(key, list);
}

const evidence = (messages ?? []).map((message) => ({
  id: message.id,
  direction: message.direction,
  kind: message.kind,
  textPreview: preview(message.text_body),
  aiGenerated: message.ai_generated,
  deliveryStatus: message.delivery_status,
  providerTimestamp: message.provider_timestamp,
  createdAt: message.created_at,
  jobs: jobsByMessage.get(String(message.id)) ?? [],
  decisions: decisionsByMessage.get(String(message.id)) ?? [],
  outbox: outboxByMessage.get(String(message.id)) ?? [],
}));

const tasks = (tasksResult.data ?? []).map((task) => ({
  id: task.id,
  sourceMessageId: task.source_message_id,
  taskType: task.task_type,
  scope: task.scope,
  priority: task.priority,
  status: task.status,
  assignedRole: task.assigned_role,
  assignedOutlet: task.assigned_outlet,
  ownerRecorded: Boolean(task.owner_user_id),
  version: task.version,
  summary: task.summary,
  createdAt: task.created_at,
  updatedAt: task.updated_at,
  resolvedAt: task.resolved_at,
}));

console.log("HERA_2052_CURRENT_STATE", JSON.stringify({
  contact: {
    phoneEnding: String(contact.wa_id).slice(-4),
    profileName: contact.profile_name,
    lastSeenAt: contact.last_seen_at,
  },
  conversation,
  messages: evidence,
  tasks,
  openTasks: tasks.filter((task) => !["resolved", "cancelled"].includes(String(task.status))),
  activeOrDeadJobs: (jobsResult.data ?? []).filter((job) => ["pending", "processing", "retry", "dead"].includes(String(job.status))).map((job) => ({
    id: job.id,
    sourceMessageId: job.source_message_id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    availableAt: job.available_at,
    lockedAt: job.locked_at,
    lastError: preview(job.last_error, 500),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  })),
  databaseMutationAttempted: false,
  whatsappSendAttempted: false,
}));
