import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const LIVE_CONFIRMATION = "ENABLE_HERA_WHATSAPP_LIVE";
const TARGET_MESSAGE_ID = "6a62b484-f22e-46f1-b7a6-38358fdce44d";
const TARGET_PHONE_ENDING = "2052";
const TARGET_TEXT_MARKER = "does hera offer curly haircuts at tanglin mall";
const RECONCILIATION_OUTCOME = "false_handoff_reconciled";

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assertSafeEnvironment() {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("reconciliation_requires_vercel_preview");
  }
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("reconciliation_requires_authoritative_feature_branch");
  }
  if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
    throw new Error("reconciliation_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === LIVE_CONFIRMATION) {
    throw new Error("reconciliation_refuses_live_confirmation");
  }
  if (!present(process.env.SUPABASE_URL) || !present(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("reconciliation_database_configuration_missing");
  }
}

assertSafeEnvironment();

const database = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "X-Client-Info": "hera-false-handoff-reconciliation/1.0" },
    },
  },
);

const messageResult = await database
  .from("ai_messages")
  .select("id,conversation_id,contact_id,direction,text_body,delivery_status,provider_timestamp,created_at")
  .eq("id", TARGET_MESSAGE_ID)
  .single();
if (messageResult.error) throw messageResult.error;
const message = messageResult.data;
if (message.direction !== "inbound") throw new Error("target_message_not_inbound");
if (!String(message.text_body ?? "").toLowerCase().includes(TARGET_TEXT_MARKER)) {
  throw new Error("target_message_text_mismatch");
}

const contactResult = await database
  .from("ai_contacts")
  .select("id,wa_id,profile_name")
  .eq("id", message.contact_id)
  .single();
if (contactResult.error) throw contactResult.error;
if (!String(contactResult.data.wa_id ?? "").endsWith(TARGET_PHONE_ENDING)) {
  throw new Error("target_contact_mismatch");
}

const conversationResult = await database
  .from("ai_conversations")
  .select("id,operating_mode,human_takeover_until,current_risk,status,updated_at")
  .eq("id", message.conversation_id)
  .single();
if (conversationResult.error) throw conversationResult.error;
if (conversationResult.data.operating_mode !== "ai") {
  throw new Error("target_conversation_not_ai_active");
}

const tasksResult = await database
  .from("ai_handoff_tasks")
  .select("id,conversation_id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,summary,requested_action,collected_facts,missing_facts,resolution,dedupe_key,version,created_at,updated_at,resolved_at")
  .eq("conversation_id", message.conversation_id)
  .eq("task_type", "booking_action")
  .order("created_at", { ascending: true });
if (tasksResult.error) throw tasksResult.error;
const bookingTasks = tasksResult.data ?? [];
if (bookingTasks.length !== 2) {
  throw new Error(`unexpected_booking_task_count_${bookingTasks.length}`);
}

const originalTask = bookingTasks.find((task) => task.source_message_id !== TARGET_MESSAGE_ID);
const falseTask = bookingTasks.find((task) => task.source_message_id === TARGET_MESSAGE_ID);
if (!originalTask || !falseTask) throw new Error("required_booking_tasks_not_found");

const originalResolution = asRecord(originalTask.resolution);
if (
  originalTask.status !== "resolved" ||
  originalResolution.outcome !== "test_completed" ||
  !originalTask.owner_user_id ||
  !originalTask.resolved_at
) {
  throw new Error("original_resolved_booking_task_integrity_failed");
}
if (
  falseTask.scope !== "task_only" ||
  falseTask.assigned_role !== "receptionist" ||
  falseTask.assigned_outlet !== "Tanglin Mall" ||
  falseTask.owner_user_id !== null ||
  falseTask.dedupe_key !== `automatic-handoff:booking_action:${TARGET_MESSAGE_ID}`
) {
  throw new Error("false_task_identity_or_scope_mismatch");
}

const outboxResult = await database
  .from("ai_outbox")
  .select("id,status,target_type,provider_message_id,sent_at,body,created_at,updated_at")
  .eq("source_message_id", TARGET_MESSAGE_ID)
  .order("created_at", { ascending: true });
if (outboxResult.error) throw outboxResult.error;
const outbox = outboxResult.data ?? [];
if (outbox.length !== 1 || outbox[0].status !== "shadowed") {
  throw new Error("target_shadow_candidate_integrity_failed");
}
if (outbox.some((item) => item.status === "sent" || item.provider_message_id || item.sent_at)) {
  throw new Error("provider_send_evidence_detected");
}

const decisionsResult = await database
  .from("ai_decisions")
  .select("id,stage,created_at")
  .eq("source_message_id", TARGET_MESSAGE_ID)
  .order("created_at", { ascending: true });
if (decisionsResult.error) throw decisionsResult.error;
const decisionStages = new Set((decisionsResult.data ?? []).map((item) => item.stage));
if (
  !decisionStages.has("response") ||
  !decisionStages.has("verification") ||
  !decisionStages.has("policy")
) {
  throw new Error("target_decision_evidence_incomplete");
}

let reconciledTask = falseTask;
const existingResolution = asRecord(falseTask.resolution);
if (
  falseTask.status !== "cancelled" ||
  existingResolution.outcome !== RECONCILIATION_OUTCOME
) {
  if (!new Set(["new", "assigned"]).has(falseTask.status)) {
    throw new Error(`false_task_not_safely_reconcilable_${falseTask.status}`);
  }

  const now = new Date().toISOString();
  const resolution = {
    outcome: RECONCILIATION_OUTCOME,
    reason:
      "The post-handback service-information question incorrectly inherited the earlier resolved booking context. The false task was cancelled after deterministic latest-turn isolation was implemented and verified.",
    evidencePreserved: true,
    sourceMessageId: TARGET_MESSAGE_ID,
    originalResolvedTaskId: originalTask.id,
    providerSends: 0,
    reconciledAt: now,
  };

  const updateResult = await database
    .from("ai_handoff_tasks")
    .update({
      status: "cancelled",
      resolved_at: now,
      resolution,
      version: falseTask.version + 1,
      updated_at: now,
    })
    .eq("id", falseTask.id)
    .eq("version", falseTask.version)
    .eq("status", falseTask.status)
    .select("id,status,version,resolution,resolved_at,updated_at")
    .single();
  if (updateResult.error) throw updateResult.error;
  reconciledTask = { ...falseTask, ...updateResult.data };

  const eventResult = await database.from("ai_handoff_events").insert({
    task_id: falseTask.id,
    actor_type: "system",
    actor_user_id: null,
    event_type: "false_handoff_reconciled",
    from_status: falseTask.status,
    to_status: "cancelled",
    details: {
      reason: "stale_resolved_booking_context_leaked_into_new_informational_turn",
      sourceMessageId: TARGET_MESSAGE_ID,
      originalResolvedTaskId: originalTask.id,
      evidencePreserved: true,
      providerSends: 0,
      version: falseTask.version + 1,
    },
  });
  if (eventResult.error) throw eventResult.error;

  const auditResult = await database.from("ai_audit_log").insert({
    actor_type: "system",
    actor_id: "hera_staging_reconciliation",
    event_type: "false_automatic_handoff_reconciled",
    target_type: "handoff_task",
    target_id: falseTask.id,
    details: {
      conversationId: message.conversation_id,
      sourceMessageId: TARGET_MESSAGE_ID,
      originalResolvedTaskId: originalTask.id,
      priorStatus: falseTask.status,
      finalStatus: "cancelled",
      evidencePreserved: true,
      providerSends: 0,
    },
  });
  if (auditResult.error) throw auditResult.error;
}

const [finalTasksResult, finalConversationResult, finalOutboxResult, finalEventResult] =
  await Promise.all([
    database
      .from("ai_handoff_tasks")
      .select("id,source_message_id,status,version,owner_user_id,resolution,resolved_at")
      .eq("conversation_id", message.conversation_id)
      .eq("task_type", "booking_action")
      .order("created_at", { ascending: true }),
    database
      .from("ai_conversations")
      .select("operating_mode,human_takeover_until,current_risk")
      .eq("id", message.conversation_id)
      .single(),
    database
      .from("ai_outbox")
      .select("id,status,provider_message_id,sent_at")
      .eq("source_message_id", TARGET_MESSAGE_ID),
    database
      .from("ai_handoff_events")
      .select("id,event_type,from_status,to_status,created_at")
      .eq("task_id", falseTask.id)
      .eq("event_type", "false_handoff_reconciled")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
if (finalTasksResult.error) throw finalTasksResult.error;
if (finalConversationResult.error) throw finalConversationResult.error;
if (finalOutboxResult.error) throw finalOutboxResult.error;
if (finalEventResult.error) throw finalEventResult.error;

const finalTasks = finalTasksResult.data ?? [];
const finalOriginal = finalTasks.find((task) => task.id === originalTask.id);
const finalFalse = finalTasks.find((task) => task.id === falseTask.id);
const finalOutbox = finalOutboxResult.data ?? [];
const providerSendEvidence = finalOutbox.filter(
  (item) => item.status === "sent" || item.provider_message_id || item.sent_at,
).length;
const openBookingTasks = finalTasks.filter(
  (task) => task.status !== "resolved" && task.status !== "cancelled",
).length;

const report = {
  pass:
    finalTasks.length === 2 &&
    finalOriginal?.status === "resolved" &&
    asRecord(finalOriginal?.resolution).outcome === "test_completed" &&
    Boolean(finalOriginal?.owner_user_id) &&
    finalFalse?.status === "cancelled" &&
    asRecord(finalFalse?.resolution).outcome === RECONCILIATION_OUTCOME &&
    Boolean(finalFalse?.resolved_at) &&
    openBookingTasks === 0 &&
    finalConversationResult.data.operating_mode === "ai" &&
    finalOutbox.length === 1 &&
    finalOutbox[0].status === "shadowed" &&
    providerSendEvidence === 0 &&
    (finalEventResult.data ?? []).length === 1,
  outcome: asRecord(finalFalse?.resolution).outcome ?? null,
  originalTask: {
    status: finalOriginal?.status ?? null,
    ownerRetained: Boolean(finalOriginal?.owner_user_id),
    outcome: asRecord(finalOriginal?.resolution).outcome ?? null,
  },
  falseTask: {
    status: finalFalse?.status ?? null,
    version: finalFalse?.version ?? null,
    resolvedAtPresent: Boolean(finalFalse?.resolved_at),
    outcome: asRecord(finalFalse?.resolution).outcome ?? null,
  },
  bookingTaskCount: finalTasks.length,
  openBookingTasks,
  conversationMode: finalConversationResult.data.operating_mode,
  shadowCandidatePreserved: finalOutbox.length === 1 && finalOutbox[0].status === "shadowed",
  decisionEvidencePreserved: [...decisionStages].sort(),
  providerSendEvidence,
  providerSends: 0,
};

console.log(`HERA_FALSE_HANDOFF_RECONCILIATION ${JSON.stringify(report)}`);
if (!report.pass) throw new Error("false_handoff_reconciliation_verification_failed");
