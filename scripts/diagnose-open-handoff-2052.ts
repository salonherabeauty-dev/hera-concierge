import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const PHONE_ENDING = "2052";
const RESOLUTION_NOTE =
  "Controlled staging complaint-handoff test completed. The complaint task was accepted under the named ownership of Neo Chin Chuan. The earlier pre-quality-gate AI candidate remained shadowed and was not sent to WhatsApp. No real complaint outcome, liability decision, refund, compensation, complimentary refinement or redo was offered. Human handling is complete.";
const HANDBACK_REASON =
  "The controlled staging complaint-handoff test is complete. The complaint task has been resolved under the named ownership of Neo Chin Chuan. The earlier pre-quality-gate AI candidate remained shadowed and was not sent to WhatsApp. Human handling is complete, and the conversation may return to AI for a fresh shadow-only complaint test under the new final-response quality gate.";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("repair_requires_preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("repair_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
  throw new Error("repair_requires_shadow_mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("repair_refuses_live_confirmation");
}

const supabase = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-complaint-handback-repair" } },
  },
);

const { data: contacts, error: contactError } = await supabase
  .from("ai_contacts")
  .select("id,wa_id,profile_name,last_seen_at")
  .like("wa_id", `%${PHONE_ENDING}`)
  .order("last_seen_at", { ascending: false })
  .limit(3);
if (contactError) throw contactError;
if (!contacts?.length) throw new Error("target_contact_not_found");
const contact = contacts[0];
if (String(contact.wa_id).slice(-4) !== PHONE_ENDING) {
  throw new Error("target_contact_phone_guard_failed");
}

const { data: conversations, error: conversationError } = await supabase
  .from("ai_conversations")
  .select("id,status,operating_mode,human_takeover_until,current_risk,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationError) throw conversationError;
const conversation =
  conversations?.find((item) => item.status === "active") ?? conversations?.[0];
if (!conversation) throw new Error("target_conversation_not_found");

const { data: taskRows, error: taskError } = await supabase
  .from("ai_handoff_tasks")
  .select(
    "id,conversation_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,version,summary,created_at,updated_at,accepted_at,resolved_at,resolution,dedupe_key",
  )
  .eq("conversation_id", conversation.id)
  .order("created_at", { ascending: true });
if (taskError) throw taskError;

const tasks = taskRows ?? [];
const complaintTasks = tasks.filter(
  (task) =>
    task.task_type === "complaint_review" &&
    task.scope === "full_takeover" &&
    task.assigned_role === "salon_manager" &&
    task.assigned_outlet === "Tanglin Mall",
);
if (complaintTasks.length !== 1) {
  throw new Error(`unexpected_complaint_task_count_${complaintTasks.length}`);
}
const complaintTask = complaintTasks[0];
if (!complaintTask.owner_user_id) {
  throw new Error("complaint_task_has_no_named_owner");
}

const { data: owner, error: ownerError } = await supabase
  .from("ai_staff_profiles")
  .select("user_id,display_name,role,status")
  .eq("user_id", complaintTask.owner_user_id)
  .single();
if (ownerError) throw ownerError;
if (
  owner.display_name !== "Neo Chin Chuan" ||
  owner.status !== "active" ||
  !["owner", "managing_director", "salon_manager"].includes(owner.role)
) {
  throw new Error("named_owner_guard_failed");
}

let transitionResult: unknown = null;
if (!["resolved", "cancelled"].includes(complaintTask.status)) {
  if (complaintTask.status !== "accepted" || complaintTask.version !== 2) {
    throw new Error(
      `unexpected_open_complaint_state_${complaintTask.status}_v${complaintTask.version}`,
    );
  }
  const { data, error } = await supabase.rpc("ai_cc_transition_task", {
    p_task_id: complaintTask.id,
    p_actor_user_id: complaintTask.owner_user_id,
    p_expected_version: complaintTask.version,
    p_to_status: "resolved",
    p_note: RESOLUTION_NOTE,
    p_resolution: {
      outcome: "controlled_staging_complaint_test_completed",
      summary: RESOLUTION_NOTE,
      realClientRemedyAuthorised: false,
      whatsappMessageSent: false,
      recordedFrom: "protected_preview_repair_after_operator_handback_attempt",
    },
  });
  if (error) throw error;
  transitionResult = data;
}

const { data: postTasks, error: postTaskError } = await supabase
  .from("ai_handoff_tasks")
  .select("id,task_type,scope,status,owner_user_id,version,resolved_at")
  .eq("conversation_id", conversation.id)
  .order("created_at", { ascending: true });
if (postTaskError) throw postTaskError;
const blockers = (postTasks ?? []).filter(
  (task) =>
    !["resolved", "cancelled"].includes(task.status) &&
    ["full_takeover", "emergency"].includes(task.scope),
);
if (blockers.length !== 0) {
  throw new Error(`blocking_human_work_remains_${blockers.length}`);
}

let handbackResult: unknown = null;
if (conversation.operating_mode !== "ai") {
  const { data, error } = await supabase.rpc("ai_cc_set_conversation_mode", {
    p_conversation_id: conversation.id,
    p_actor_user_id: complaintTask.owner_user_id,
    p_mode: "ai",
    p_reason: HANDBACK_REASON,
    p_takeover_until: null,
  });
  if (error) throw error;
  handbackResult = data;
}

const [{ data: finalTask, error: finalTaskError }, { data: finalConversation, error: finalConversationError }] =
  await Promise.all([
    supabase
      .from("ai_handoff_tasks")
      .select("id,status,version,resolved_at,resolution,owner_user_id")
      .eq("id", complaintTask.id)
      .single(),
    supabase
      .from("ai_conversations")
      .select("id,operating_mode,human_takeover_until,current_risk,updated_at")
      .eq("id", conversation.id)
      .single(),
  ]);
if (finalTaskError) throw finalTaskError;
if (finalConversationError) throw finalConversationError;
if (finalTask.status !== "resolved" || !finalTask.resolved_at) {
  throw new Error("complaint_task_resolution_verification_failed");
}
if (finalConversation.operating_mode !== "ai") {
  throw new Error("conversation_ai_handback_verification_failed");
}

console.log(
  "HERA_COMPLAINT_HANDBACK_REPAIR",
  JSON.stringify({
    pass: true,
    contact: {
      phoneEnding: String(contact.wa_id).slice(-4),
      profileName: contact.profile_name,
    },
    owner: {
      displayName: owner.display_name,
      role: owner.role,
    },
    task: {
      id: finalTask.id,
      status: finalTask.status,
      version: finalTask.version,
      resolvedAt: finalTask.resolved_at,
      ownerRecorded: Boolean(finalTask.owner_user_id),
      resolution: finalTask.resolution,
    },
    conversation: finalConversation,
    blockersRemaining: 0,
    transitionResult,
    handbackResult,
    whatsappSendAttempted: false,
    outboxMutationAttempted: false,
    productionTouched: false,
  }),
);
