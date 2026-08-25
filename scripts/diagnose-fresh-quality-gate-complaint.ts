import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const TARGET_FRAGMENT = "uneven and disconnected";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function safeText(value: unknown, max = 900): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .replace(/(?:sk|pk|eyJ)[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("diagnostic_requires_preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("diagnostic_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
  throw new Error("diagnostic_requires_shadow_mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("diagnostic_refuses_live_confirmation");
}

const supabase = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-fresh-complaint-diagnostic" } },
  },
);

const { data: contacts, error: contactError } = await supabase
  .from("ai_contacts")
  .select("id,wa_id,profile_name,last_seen_at")
  .like("wa_id", "%2052")
  .order("last_seen_at", { ascending: false })
  .limit(3);
if (contactError) throw contactError;
if (!contacts?.length) throw new Error("contact_ending_2052_not_found");

const contact = contacts[0];
const { data: conversations, error: conversationError } = await supabase
  .from("ai_conversations")
  .select("id,status,operating_mode,current_risk,human_takeover_until,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationError) throw conversationError;
if (!conversations?.length) throw new Error("conversation_not_found");
const conversation =
  conversations.find((item) => item.status === "active") ?? conversations[0];

const { data: messages, error: messageError } = await supabase
  .from("ai_messages")
  .select("id,conversation_id,direction,text_body,provider_timestamp,created_at")
  .eq("conversation_id", conversation.id)
  .eq("direction", "inbound")
  .ilike("text_body", `%${TARGET_FRAGMENT}%`)
  .order("created_at", { ascending: false })
  .limit(5);
if (messageError) throw messageError;
if (!messages?.length) throw new Error("fresh_quality_gate_message_not_found");
const message = messages[0];

const [jobResult, decisionResult, outboxResult, taskResult] = await Promise.all([
  supabase
    .from("ai_jobs")
    .select("*")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  supabase
    .from("ai_decisions")
    .select("id,stage,model_id,prompt_version,policy_version,risk,confidence,created_at,latency_ms")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  supabase
    .from("ai_outbox")
    .select("*")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  supabase
    .from("ai_handoff_tasks")
    .select("id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,version,summary,client_visible_status,created_at,updated_at")
    .eq("conversation_id", conversation.id)
    .gte("created_at", new Date(Date.parse(message.created_at) - 120_000).toISOString())
    .order("created_at", { ascending: true }),
]);
if (jobResult.error) throw jobResult.error;
if (decisionResult.error) throw decisionResult.error;
if (outboxResult.error) throw outboxResult.error;
if (taskResult.error) throw taskResult.error;

const jobs = (jobResult.data ?? []).map((job: Record<string, unknown>) => ({
  id: job.id,
  status: job.status,
  attempts: job.attempts,
  maxAttempts: job.max_attempts,
  availableAt: job.available_at,
  lockedAt: job.locked_at,
  completedAt: job.completed_at,
  lastError: safeText(job.last_error),
  lastErrorCode: job.last_error_code ?? null,
  createdAt: job.created_at,
  updatedAt: job.updated_at,
}));

console.log(
  "HERA_FRESH_COMPLAINT_DIAGNOSTIC",
  JSON.stringify({
    contact: {
      phoneEnding: String(contact.wa_id).slice(-4),
      profileName: contact.profile_name,
    },
    conversation,
    message: {
      id: message.id,
      createdAt: message.created_at,
      providerTimestamp: message.provider_timestamp,
      textMatched: String(message.text_body).includes(TARGET_FRAGMENT),
    },
    jobs,
    decisions: decisionResult.data ?? [],
    outbox: (outboxResult.data ?? []).map((item: Record<string, unknown>) => ({
      id: item.id,
      status: item.status,
      targetType: item.target_type,
      authorization: item.authorization ?? item.send_authorization ?? null,
      providerMessageIdRecorded: Boolean(item.provider_message_id),
      attempts: item.attempts,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    tasks: (taskResult.data ?? []).map((task) => ({
      ...task,
      ownerRecorded: Boolean(task.owner_user_id),
      owner_user_id: undefined,
    })),
    databaseMutationAttempted: false,
    whatsappSendAttempted: false,
  }),
);
