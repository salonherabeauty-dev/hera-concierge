import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig, getOperationsConfig } from "../src/config.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const RECONCILIATION_CUTOFF = "2026-08-25T12:00:00.000Z";
const CONTROLLED_COMPLAINT_SOURCE = "17c7a7bd-d89f-4c01-afc9-fc8d0556cfbb";
const ACK_JOB_TARGETS = [
  {
    jobId: "44a98681-08fe-4bd4-81a0-5e5b38194ff8",
    sourceMessageId: "9f81820f-b816-4c0a-af93-9390b8974e2d",
  },
  {
    jobId: "3642d9a2-43fe-4d2e-933a-d0dcc981cb38",
    sourceMessageId: "0ce9ea30-d616-41df-a02e-2db688a73b72",
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    : "";
}

function isAcknowledgementOnly(value: unknown): boolean {
  return [
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
  ].includes(normalize(value));
}

function requireNoError(
  result: { error: { message: string } | null },
  operation: string,
): void {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("stage0_reconciliation_requires_authoritative_preview_branch");
  }

  const operations = getOperationsConfig();
  if (operations.sendMode !== "shadow") {
    throw new Error("stage0_reconciliation_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
    throw new Error("stage0_reconciliation_refuses_live_confirmation");
  }

  const database = getDatabaseConfig();
  const client = createClient(database.url, database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage0-reconciliation" } },
  });

  const ownerResult = await client
    .from("ai_staff_profiles")
    .select("user_id")
    .eq("role", "owner")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  requireNoError(ownerResult, "load active owner");
  if (!ownerResult.data?.user_id) throw new Error("active_owner_not_found");
  const actorUserId = ownerResult.data.user_id;
  const nowIso = new Date().toISOString();

  const reconciledJobs: string[] = [];
  const cancelledSystemFailureTasks: string[] = [];
  const returnedConversations: string[] = [];
  const createdIncidentTasks: string[] = [];
  const closedIncidents: string[] = [];

  for (const target of ACK_JOB_TARGETS) {
    const [jobResult, messageResult, sentOutboxResult] = await Promise.all([
      client
        .from("ai_jobs")
        .select("id,source_message_id,status,attempts,max_attempts,created_at,last_error")
        .eq("id", target.jobId)
        .maybeSingle(),
      client
        .from("ai_messages")
        .select("id,conversation_id,direction,kind,text_body,created_at")
        .eq("id", target.sourceMessageId)
        .maybeSingle(),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", target.sourceMessageId)
        .not("provider_message_id", "is", null),
    ]);
    requireNoError(jobResult, "load reconciliation job");
    requireNoError(messageResult, "load reconciliation message");
    requireNoError(sentOutboxResult, "check reconciliation provider sends");

    if (!jobResult.data || !messageResult.data) {
      throw new Error("stage0_reconciliation_target_missing");
    }
    if (jobResult.data.source_message_id !== target.sourceMessageId) {
      throw new Error("stage0_reconciliation_source_mismatch");
    }
    if (
      messageResult.data.direction !== "inbound" ||
      messageResult.data.kind !== "text" ||
      !isAcknowledgementOnly(messageResult.data.text_body)
    ) {
      throw new Error("stage0_reconciliation_message_not_acknowledgement_only");
    }
    if ((sentOutboxResult.count ?? 0) !== 0) {
      throw new Error("stage0_reconciliation_refuses_provider_sent_message");
    }

    if (["dead", "retry", "pending", "processing"].includes(jobResult.data.status)) {
      const jobUpdate = await client
        .from("ai_jobs")
        .update({
          status: "completed",
          completed_at: nowIso,
          locked_at: null,
          locked_by: null,
          last_error: "stage0_reconciled_acknowledgement_only",
          updated_at: nowIso,
        })
        .eq("id", target.jobId)
        .eq("source_message_id", target.sourceMessageId)
        .in("status", ["dead", "retry", "pending", "processing"])
        .select("id")
        .maybeSingle();
      requireNoError(jobUpdate, "complete acknowledgement-only residue job");
      if (jobUpdate.data) {
        reconciledJobs.push(target.jobId);
        const audit = await client.from("ai_audit_log").insert({
          actor_type: "management",
          actor_id: actorUserId,
          event_type: "stage0_acknowledgement_job_reconciled",
          target_type: "job",
          target_id: target.jobId,
          details: {
            sourceMessageId: target.sourceMessageId,
            previousStatus: jobResult.data.status,
            previousAttempts: jobResult.data.attempts,
            reason: "pre_baseline_acknowledgement_only_structured_output_residue",
            clientReplySent: false,
          },
        });
        requireNoError(audit, "audit acknowledgement job reconciliation");
      }
    }
  }

  const openSystemFailuresResult = await client
    .from("ai_handoff_tasks")
    .select("id,conversation_id,source_message_id,status,version,created_at")
    .eq("task_type", "system_failure")
    .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"])
    .lt("created_at", RECONCILIATION_CUTOFF)
    .order("created_at", { ascending: true });
  requireNoError(openSystemFailuresResult, "load pre-baseline system failures");

  for (const task of openSystemFailuresResult.data ?? []) {
    if (!task.source_message_id) continue;
    const [messageResult, sentOutboxResult] = await Promise.all([
      client
        .from("ai_messages")
        .select("id,direction,kind,text_body")
        .eq("id", task.source_message_id)
        .maybeSingle(),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", task.source_message_id)
        .not("provider_message_id", "is", null),
    ]);
    requireNoError(messageResult, "load system failure source");
    requireNoError(sentOutboxResult, "check system failure provider sends");
    if (
      !messageResult.data ||
      messageResult.data.direction !== "inbound" ||
      messageResult.data.kind !== "text" ||
      !isAcknowledgementOnly(messageResult.data.text_body) ||
      (sentOutboxResult.count ?? 0) !== 0
    ) {
      continue;
    }

    const transition = await client.rpc("ai_cc_transition_task", {
      p_task_id: task.id,
      p_actor_user_id: actorUserId,
      p_expected_version: task.version,
      p_to_status: "cancelled",
      p_note:
        "Stage 0 reconciliation: acknowledgement-only pre-baseline system failure was safely closed without sending a client reply.",
      p_resolution: {
        outcome: "pre_baseline_system_failure_reconciled",
        sourceMessageClass: "acknowledgement_only",
        clientReplySent: false,
        providerSendAttempted: false,
      },
    });
    requireNoError(transition, "cancel acknowledgement-only system failure");
    cancelledSystemFailureTasks.push(task.id);

    const blockersResult = await client
      .from("ai_handoff_tasks")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", task.conversation_id)
      .in("scope", ["full_takeover", "emergency"])
      .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"]);
    requireNoError(blockersResult, "check remaining conversation blockers");
    if ((blockersResult.count ?? 0) === 0) {
      const conversationResult = await client
        .from("ai_conversations")
        .select("operating_mode,human_takeover_until")
        .eq("id", task.conversation_id)
        .maybeSingle();
      requireNoError(conversationResult, "load system failure conversation");
      const takeoverUntil = Date.parse(
        conversationResult.data?.human_takeover_until ?? "",
      );
      const activeTimedTakeover =
        Number.isFinite(takeoverUntil) && takeoverUntil > Date.now();
      if (
        conversationResult.data?.operating_mode === "management" &&
        !activeTimedTakeover
      ) {
        const modeResult = await client.rpc("ai_cc_set_conversation_mode", {
          p_conversation_id: task.conversation_id,
          p_actor_user_id: actorUserId,
          p_mode: "ai",
          p_reason:
            "Stage 0 reconciliation completed the pre-baseline system-failure takeover; no full-takeover or emergency task remains open.",
          p_takeover_until: null,
        });
        requireNoError(modeResult, "return reconciled system failure conversation to AI");
        returnedConversations.push(task.conversation_id);
      }
    }
  }

  const incidentsResult = await client
    .from("ai_incidents")
    .select("id,conversation_id,source_message_id,category,severity,status,created_at")
    .in("status", ["open", "monitoring"])
    .lt("created_at", RECONCILIATION_CUTOFF)
    .order("created_at", { ascending: true });
  requireNoError(incidentsResult, "load pre-baseline incidents");

  for (const incident of incidentsResult.data ?? []) {
    if (!incident.source_message_id) {
      throw new Error("stage0_incident_without_source_requires_manual_review");
    }

    let disposition: string;
    let linkedTaskId: string | null = null;

    if (incident.source_message_id === CONTROLLED_COMPLAINT_SOURCE) {
      const complaintTaskResult = await client
        .from("ai_handoff_tasks")
        .select("id,status,resolved_at")
        .eq("conversation_id", incident.conversation_id)
        .eq("source_message_id", incident.source_message_id)
        .eq("task_type", "complaint_review")
        .in("status", ["resolved", "cancelled"])
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      requireNoError(complaintTaskResult, "verify controlled complaint task");
      if (!complaintTaskResult.data) {
        throw new Error("controlled_complaint_task_not_terminal");
      }
      linkedTaskId = complaintTaskResult.data.id;
      disposition = "controlled_staging_complaint_completed";
    } else if (incident.category === "appointment_change") {
      const existingTaskResult = await client
        .from("ai_handoff_tasks")
        .select("id,status")
        .eq("conversation_id", incident.conversation_id)
        .eq("task_type", "appointment_change")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      requireNoError(existingTaskResult, "find appointment-change ownership");

      if (existingTaskResult.data) {
        linkedTaskId = existingTaskResult.data.id;
      } else {
        const createResult = await client.rpc("ai_cc_create_task", {
          p_conversation_id: incident.conversation_id,
          p_source_message_id: incident.source_message_id,
          p_incident_id: incident.id,
          p_task_type: "appointment_change",
          p_scope: "task_only",
          p_priority: incident.severity === "red" ? "urgent" : "high",
          p_assigned_role: "receptionist",
          p_assigned_outlet: null,
          p_summary:
            "Pre-baseline appointment-change request requires receptionist verification.",
          p_requested_action:
            "Review the original WhatsApp conversation and current Timely record, complete the required appointment action through Hera's authorised staff workflow, and record the verified outcome.",
          p_collected_facts: {
            source: "stage0_pre_baseline_incident_reconciliation",
          },
          p_missing_facts: [],
          p_client_visible_status: null,
          p_due_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          p_dedupe_key: `stage0-incident-task:${incident.id}`,
          p_actor_user_id: actorUserId,
        });
        requireNoError(createResult, "create appointment-change ownership task");
        const resultValue = createResult.data as { taskId?: string } | null;
        if (!resultValue?.taskId) throw new Error("appointment_change_task_not_created");
        linkedTaskId = resultValue.taskId;
        createdIncidentTasks.push(linkedTaskId);
      }
      disposition = "transferred_to_receptionist_task";
    } else if (incident.category === "media_followup") {
      const existingTaskResult = await client
        .from("ai_handoff_tasks")
        .select("id,status")
        .eq("conversation_id", incident.conversation_id)
        .eq("source_message_id", incident.source_message_id)
        .eq("task_type", "technical_review")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      requireNoError(existingTaskResult, "find media-review ownership");

      if (existingTaskResult.data) {
        linkedTaskId = existingTaskResult.data.id;
      } else {
        const createResult = await client.rpc("ai_cc_create_task", {
          p_conversation_id: incident.conversation_id,
          p_source_message_id: incident.source_message_id,
          p_incident_id: incident.id,
          p_task_type: "technical_review",
          p_scope: "task_only",
          p_priority: "high",
          p_assigned_role: "technical_lead",
          p_assigned_outlet: null,
          p_summary:
            "Pre-baseline media follow-up requires authorised human review.",
          p_requested_action:
            "Review the original attachment and conversation context, determine whether client follow-up is required, and record the verified outcome without relying on unverified AI assumptions.",
          p_collected_facts: {
            source: "stage0_pre_baseline_incident_reconciliation",
            mediaPresent: true,
          },
          p_missing_facts: [],
          p_client_visible_status: null,
          p_due_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          p_dedupe_key: `stage0-incident-task:${incident.id}`,
          p_actor_user_id: actorUserId,
        });
        requireNoError(createResult, "create media-review ownership task");
        const resultValue = createResult.data as { taskId?: string } | null;
        if (!resultValue?.taskId) throw new Error("media_review_task_not_created");
        linkedTaskId = resultValue.taskId;
        createdIncidentTasks.push(linkedTaskId);
      }
      disposition = "transferred_to_technical_review_task";
    } else {
      throw new Error(`unclassified_pre_baseline_incident:${incident.category}`);
    }

    const incidentUpdate = await client
      .from("ai_incidents")
      .update({
        status: "closed",
        resolution: {
          disposition,
          linkedTaskId,
          stage: "stage0_baseline_reconciliation",
          clientReplySent: false,
          providerSendAttempted: false,
          reconciledAt: nowIso,
          reconciledBy: actorUserId,
        },
        updated_at: nowIso,
      })
      .eq("id", incident.id)
      .in("status", ["open", "monitoring"])
      .select("id")
      .maybeSingle();
    requireNoError(incidentUpdate, "close transferred pre-baseline incident");
    if (incidentUpdate.data) {
      closedIncidents.push(incident.id);
      const audit = await client.from("ai_audit_log").insert({
        actor_type: "management",
        actor_id: actorUserId,
        event_type: "stage0_incident_reconciled",
        target_type: "incident",
        target_id: incident.id,
        details: {
          conversationId: incident.conversation_id,
          sourceMessageId: incident.source_message_id,
          category: incident.category,
          disposition,
          linkedTaskId,
          clientReplySent: false,
        },
      });
      requireNoError(audit, "audit incident reconciliation");
    }
  }

  const [activeJobs, deadJobs, activeOutbox, deadOutbox, openIncidents] =
    await Promise.all([
      client
        .from("ai_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending", "processing", "retry"]),
      client
        .from("ai_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "dead"),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending", "processing", "retry"]),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", "dead"),
      client
        .from("ai_incidents")
        .select("id", { count: "exact", head: true })
        .in("status", ["open", "monitoring"]),
    ]);
  for (const result of [
    activeJobs,
    deadJobs,
    activeOutbox,
    deadOutbox,
    openIncidents,
  ]) requireNoError(result, "verify Stage 0 reconciliation state");

  console.log(
    "HERA_STAGE0_RECONCILIATION",
    JSON.stringify({
      reconciledJobs: reconciledJobs.length,
      cancelledSystemFailureTasks: cancelledSystemFailureTasks.length,
      returnedConversations: returnedConversations.length,
      createdIncidentTasks: createdIncidentTasks.length,
      closedIncidents: closedIncidents.length,
      countsAfter: {
        activeJobs: activeJobs.count ?? null,
        deadJobs: deadJobs.count ?? null,
        activeOutbox: activeOutbox.count ?? null,
        deadOutbox: deadOutbox.count ?? null,
        openIncidents: openIncidents.count ?? null,
      },
      databaseMutationScope:
        "staging_pre_baseline_residue_only_with_exact_guards_and_audit",
      whatsappProviderSendAttempted: false,
      productionTouched: false,
    }),
  );
}

await main();
