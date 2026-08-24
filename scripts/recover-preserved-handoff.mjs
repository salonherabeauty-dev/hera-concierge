import { createClient } from "@supabase/supabase-js";

const TARGET_JOB_ID = "5aa7fbfe-0306-4445-a81e-ef194dfdf3b5";
const RECOVERY_LOCK = "vercel:one-time-automatic-handoff-recovery";
const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const LIVE_CONFIRMATION = "ENABLE_HERA_WHATSAPP_LIVE";

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function text(value, label, maximum = 4000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}_missing`);
  }
  return value.trim().slice(0, maximum);
}

function stringOrNull(value, maximum = 200) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label}_invalid`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function assertPreviewShadow() {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("recovery_requires_vercel_preview");
  }
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("recovery_requires_authoritative_feature_branch");
  }
  if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
    throw new Error("recovery_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === LIVE_CONFIRMATION) {
    throw new Error("recovery_refuses_live_confirmation");
  }
  if (!present(process.env.SUPABASE_URL) || !present(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("recovery_database_configuration_missing");
  }
}

function classify(error) {
  const value = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`.toLowerCase();
  if (value.includes("pgrst202") || value.includes("could not find the function")) {
    return "automatic_handoff_rpc_not_available";
  }
  if (value.includes("schema cache")) return "schema_cache_not_ready";
  if (value.includes("foreign key") || value.includes("23503")) return "foreign_key_rejected";
  if (value.includes("timeout")) return "timeout";
  return "recovery_database_error";
}

assertPreviewShadow();

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "X-Client-Info": "hera-handoff-recovery/1.0" },
    },
  },
);

let locked = false;
let sourceMessageId = null;

try {
  const initialJob = await client
    .from("ai_jobs")
    .select("id,status,attempts,max_attempts,available_at,source_message_id,locked_by")
    .eq("id", TARGET_JOB_ID)
    .maybeSingle();

  if (initialJob.error) throw initialJob.error;
  if (!initialJob.data) throw new Error("target_job_not_found");
  sourceMessageId = text(initialJob.data.source_message_id, "source_message_id", 100);

  if (initialJob.data.status === "completed") {
    console.log(
      `HERA_HANDOFF_RECOVERY ${JSON.stringify({
        outcome: "already_completed",
        jobStatus: "completed",
        providerSends: 0,
      })}`,
    );
    process.exit(0);
  }

  if (!new Set(["pending", "retry"]).has(initialJob.data.status)) {
    throw new Error(`target_job_not_claimable_${initialJob.data.status}`);
  }

  const sourceResult = await client
    .from("ai_messages")
    .select("id,conversation_id,contact_id,text_body,provider_timestamp,created_at")
    .eq("id", sourceMessageId)
    .single();
  if (sourceResult.error) throw sourceResult.error;
  const source = sourceResult.data;
  const sourceText = text(source.text_body, "source_message_text", 12000);
  const normalized = sourceText.toLowerCase();
  const requiredMarkers = ["irene", "tanglin", "root colour", "28 august", "2 pm"];
  if (!requiredMarkers.every((marker) => normalized.includes(marker))) {
    throw new Error("target_message_does_not_match_controlled_booking_test");
  }

  const chronology = await client
    .from("ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", source.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", source.created_at);
  if (chronology.error) throw chronology.error;
  if ((chronology.count ?? 0) > 0) {
    throw new Error("target_message_has_newer_inbound_message");
  }

  const conversationResult = await client
    .from("ai_conversations")
    .select("id,operating_mode")
    .eq("id", source.conversation_id)
    .single();
  if (conversationResult.error) throw conversationResult.error;
  if (conversationResult.data.operating_mode !== "ai") {
    throw new Error("target_conversation_is_not_ai_active");
  }

  const contactResult = await client
    .from("ai_contacts")
    .select("id,wa_id")
    .eq("id", source.contact_id)
    .single();
  if (contactResult.error) throw contactResult.error;
  const waId = text(contactResult.data.wa_id, "contact_wa_id", 32);

  const decisionResult = await client
    .from("ai_decisions")
    .select("output,created_at")
    .eq("source_message_id", sourceMessageId)
    .eq("stage", "policy")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (decisionResult.error) throw decisionResult.error;
  if (!decisionResult.data) throw new Error("policy_decision_not_found");

  const output = object(decisionResult.data.output, "policy_output");
  const handoff = object(output.handoff, "policy_handoff");
  if (handoff.createTask !== true) throw new Error("policy_handoff_not_required");

  const taskType = text(handoff.taskType, "handoff_task_type", 80);
  const scope = text(handoff.scope, "handoff_scope", 40);
  const priority = text(handoff.priority, "handoff_priority", 40);
  const summary = text(handoff.summary, "handoff_summary", 1000);
  const requestedAction = text(
    handoff.requestedAction,
    "handoff_requested_action",
    1200,
  );
  const dedupeKey = text(handoff.dedupeKey, "handoff_dedupe_key", 220);
  const assignedRole = stringOrNull(handoff.assignedRole, 80);
  const assignedOutlet = stringOrNull(handoff.assignedOutlet, 80);
  const collectedFacts = object(handoff.collectedFacts, "handoff_collected_facts");
  const missingFacts = stringArray(handoff.missingFacts, "handoff_missing_facts");
  const clientVisibleStatus = stringOrNull(handoff.clientVisibleStatus, 500);
  const finalReply = text(output.finalReply, "final_reply", 4000);

  if (taskType !== "booking_action") throw new Error("unexpected_handoff_task_type");
  if (scope !== "task_only") throw new Error("unexpected_handoff_scope");
  if (assignedRole !== "receptionist") throw new Error("unexpected_handoff_role");
  if (assignedOutlet !== "Tanglin Mall") throw new Error("unexpected_handoff_outlet");
  if (missingFacts.length !== 0) throw new Error("controlled_booking_still_has_missing_facts");
  if (/\b(?:booked|confirmed|reserved|secured)\b/i.test(finalReply)) {
    throw new Error("final_reply_contains_unauthorised_booking_completion");
  }
  if (!/check live availability/i.test(finalReply)) {
    throw new Error("final_reply_missing_live_availability_boundary");
  }

  const lockResult = await client
    .from("ai_jobs")
    .update({
      status: "processing",
      locked_at: new Date().toISOString(),
      locked_by: RECOVERY_LOCK,
      updated_at: new Date().toISOString(),
    })
    .eq("id", TARGET_JOB_ID)
    .in("status", ["pending", "retry"])
    .select("id,status,locked_by")
    .maybeSingle();
  if (lockResult.error) throw lockResult.error;
  if (!lockResult.data || lockResult.data.locked_by !== RECOVERY_LOCK) {
    throw new Error("target_job_lock_not_acquired");
  }
  locked = true;

  const rpcResult = await client.rpc("ai_upsert_automatic_handoff", {
    p_conversation_id: source.conversation_id,
    p_source_message_id: sourceMessageId,
    p_task_type: taskType,
    p_scope: scope,
    p_priority: priority,
    p_assigned_role: assignedRole,
    p_assigned_outlet: assignedOutlet,
    p_summary: summary,
    p_requested_action: requestedAction,
    p_collected_facts: collectedFacts,
    p_missing_facts: missingFacts,
    p_client_visible_status: clientVisibleStatus,
    p_due_at: null,
    p_dedupe_key: dedupeKey,
  });
  if (rpcResult.error) throw rpcResult.error;
  const taskResult = object(rpcResult.data, "automatic_handoff_rpc_result");
  const taskId = text(taskResult.taskId, "automatic_handoff_task_id", 100);

  const outboxDedupeKey = `client-reply:${sourceMessageId}`;
  const outboxInsert = await client.from("ai_outbox").upsert(
    {
      conversation_id: source.conversation_id,
      source_message_id: sourceMessageId,
      to_wa_id: waId,
      target_type: "client",
      message_type: "text",
      body: { text: finalReply },
      dedupe_key: outboxDedupeKey,
      send_authorization: "auto",
    },
    { onConflict: "dedupe_key", ignoreDuplicates: true },
  );
  if (outboxInsert.error) throw outboxInsert.error;

  const shadowResult = await client
    .from("ai_outbox")
    .update({
      status: "shadowed",
      locked_at: null,
      locked_by: null,
      provider_message_id: null,
      sent_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("dedupe_key", outboxDedupeKey)
    .neq("status", "sent")
    .select("id,status,provider_message_id,sent_at")
    .single();
  if (shadowResult.error) throw shadowResult.error;
  if (shadowResult.data.status !== "shadowed") {
    throw new Error("outbox_was_not_shadowed");
  }
  if (shadowResult.data.provider_message_id || shadowResult.data.sent_at) {
    throw new Error("provider_send_evidence_detected");
  }

  const completeResult = await client
    .from("ai_jobs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", TARGET_JOB_ID)
    .eq("status", "processing")
    .eq("locked_by", RECOVERY_LOCK)
    .select("id,status,completed_at")
    .single();
  if (completeResult.error) throw completeResult.error;
  locked = false;

  const [taskVerify, outboxVerify, conversationVerify] = await Promise.all([
    client
      .from("ai_handoff_tasks")
      .select(
        "id,task_type,scope,priority,status,assigned_role,assigned_outlet,missing_facts,due_at,version",
      )
      .eq("id", taskId)
      .single(),
    client
      .from("ai_outbox")
      .select("id,status,provider_message_id,sent_at")
      .eq("dedupe_key", outboxDedupeKey)
      .single(),
    client
      .from("ai_conversations")
      .select("operating_mode")
      .eq("id", source.conversation_id)
      .single(),
  ]);
  if (taskVerify.error) throw taskVerify.error;
  if (outboxVerify.error) throw outboxVerify.error;
  if (conversationVerify.error) throw conversationVerify.error;

  if (taskVerify.data.task_type !== "booking_action") {
    throw new Error("verified_task_type_mismatch");
  }
  if (taskVerify.data.scope !== "task_only") {
    throw new Error("verified_task_scope_mismatch");
  }
  if (taskVerify.data.assigned_role !== "receptionist") {
    throw new Error("verified_task_role_mismatch");
  }
  if (taskVerify.data.assigned_outlet !== "Tanglin Mall") {
    throw new Error("verified_task_outlet_mismatch");
  }
  if (outboxVerify.data.status !== "shadowed") {
    throw new Error("verified_outbox_status_mismatch");
  }
  if (outboxVerify.data.provider_message_id || outboxVerify.data.sent_at) {
    throw new Error("verified_provider_send_evidence_detected");
  }
  if (conversationVerify.data.operating_mode !== "ai") {
    throw new Error("task_only_handoff_incorrectly_paused_conversation");
  }

  console.log(
    `HERA_HANDOFF_RECOVERY ${JSON.stringify({
      outcome: "completed",
      jobStatus: completeResult.data.status,
      task: {
        type: taskVerify.data.task_type,
        scope: taskVerify.data.scope,
        priority: taskVerify.data.priority,
        status: taskVerify.data.status,
        assignedRole: taskVerify.data.assigned_role,
        assignedOutlet: taskVerify.data.assigned_outlet,
        missingFacts: Array.isArray(taskVerify.data.missing_facts)
          ? taskVerify.data.missing_facts.length
          : null,
        dueAtPresent: Boolean(taskVerify.data.due_at),
        version: taskVerify.data.version,
      },
      outbox: {
        status: outboxVerify.data.status,
        providerMessageIdPresent: Boolean(outboxVerify.data.provider_message_id),
        sentAtPresent: Boolean(outboxVerify.data.sent_at),
      },
      conversationMode: conversationVerify.data.operating_mode,
      providerSends: 0,
    })}`,
  );
} catch (error) {
  if (locked) {
    await client
      .from("ai_jobs")
      .update({
        status: "retry",
        available_at: new Date(Date.now() + 60_000).toISOString(),
        locked_at: null,
        locked_by: null,
        last_error: "one_time_automatic_handoff_recovery_failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", TARGET_JOB_ID)
      .eq("locked_by", RECOVERY_LOCK);
  }
  console.log(
    `HERA_HANDOFF_RECOVERY ${JSON.stringify({
      outcome: "failed_safely",
      classification: classify(error),
      providerSends: 0,
    })}`,
  );
  throw error;
}
