import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "diag/open-handoff-2052";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("diagnostic_requires_preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("diagnostic_requires_isolated_branch");
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
    global: { headers: { "X-Client-Info": "hera-open-handoff-diagnostic" } },
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
  .select("id,status,operating_mode,human_takeover_until,current_risk,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationError) throw conversationError;
if (!conversations?.length) throw new Error("conversation_not_found");

const activeConversation =
  conversations.find((item) => item.status === "active") ?? conversations[0];

const { data: tasks, error: taskError } = await supabase
  .from("ai_handoff_tasks")
  .select(
    "id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,version,summary,requested_action,created_at,updated_at,accepted_at,resolved_at,dedupe_key",
  )
  .eq("conversation_id", activeConversation.id)
  .order("created_at", { ascending: true });
if (taskError) throw taskError;

const taskIds = (tasks ?? []).map((task) => task.id);
let events: unknown[] = [];
if (taskIds.length) {
  const { data: eventRows, error: eventError } = await supabase
    .from("ai_handoff_events")
    .select("task_id,event_type,from_status,to_status,actor_type,created_at,details")
    .in("task_id", taskIds)
    .order("created_at", { ascending: false })
    .limit(40);
  if (eventError) throw eventError;
  events = eventRows ?? [];
}

const safeTasks = (tasks ?? []).map((task) => ({
  id: task.id,
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
  acceptedAt: task.accepted_at,
  resolvedAt: task.resolved_at,
  dedupeKey: task.dedupe_key,
}));

const blocking = safeTasks.filter(
  (task) =>
    !["resolved", "cancelled"].includes(task.status) &&
    ["full_takeover", "emergency"].includes(task.scope),
);

console.log(
  "HERA_OPEN_HANDOFF_DIAGNOSTIC",
  JSON.stringify({
    contact: {
      phoneEnding: String(contact.wa_id).slice(-4),
      profileName: contact.profile_name,
      lastSeenAt: contact.last_seen_at,
    },
    conversation: activeConversation,
    blockingTaskCount: blocking.length,
    blockingTasks: blocking,
    allTasks: safeTasks,
    recentEvents: events,
    databaseMutationAttempted: false,
    whatsappSendAttempted: false,
  }),
);
