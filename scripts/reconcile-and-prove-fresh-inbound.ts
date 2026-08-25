import { createClient } from "@supabase/supabase-js";
import { SupabaseReceptionistRepository } from "../src/db/repository.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../src/worker.js";
import type { InboundMessage, JsonValue } from "../src/types.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const STAGING_PROJECT = "zjnbheohgwfzkmbnjqjr";
const COMPLAINT_TEXT =
  "Hi, I had a curly haircut at Tanglin Mall yesterday and I’m unhappy because the layers look uneven and disconnected. I would like the salon manager to review the result. Could you please explain what will happen next?";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function preview(value: unknown, max = 900): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

function allPerfectScores(value: unknown): boolean {
  const scores = object(value);
  const expected = [
    "empathy",
    "specificity",
    "ownership",
    "nextStep",
    "factuality",
    "safety",
    "tone",
    "clientEffort",
  ];
  return expected.every((key) => scores[key] === 2);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("repair_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("repair_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
  throw new Error("repair_requires_shadow_mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("repair_refuses_live_confirmation");
}

const url = required("SUPABASE_URL");
if (!url.includes(STAGING_PROJECT)) throw new Error("repair_refuses_non_staging_database");
const serviceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-staging-reconciliation-proof" } },
});
const repository = new SupabaseReceptionistRepository(url, serviceRoleKey);

async function audit(
  eventType: string,
  targetType: string,
  targetId: string | null,
  details: JsonValue,
): Promise<void> {
  const { error } = await supabase.from("ai_audit_log").insert({
    actor_type: "system",
    actor_id: "hera_staging_reconciliation",
    event_type: eventType,
    target_type: targetType,
    target_id: targetId,
    details,
  });
  if (error) throw error;
}

const { data: ownerProfiles, error: ownerError } = await supabase
  .from("ai_staff_profiles")
  .select("user_id,display_name,role,status")
  .eq("display_name", "Neo Chin Chuan")
  .eq("status", "active")
  .limit(3);
if (ownerError) throw ownerError;
const owner = ownerProfiles?.find((item) => item.role === "owner") ?? ownerProfiles?.[0];
if (!owner?.user_id) throw new Error("named_owner_profile_not_found");

async function setConversationAi(
  conversationId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc("ai_cc_set_conversation_mode", {
    p_conversation_id: conversationId,
    p_actor_user_id: owner.user_id,
    p_mode: "ai",
    p_reason: reason,
    p_takeover_until: null,
  });
  if (error) throw error;
}

async function cancelTask(task: Record<string, unknown>, reason: string): Promise<void> {
  const { error } = await supabase.rpc("ai_cc_transition_task", {
    p_task_id: task.id,
    p_actor_user_id: owner.user_id,
    p_expected_version: task.version,
    p_to_status: "cancelled",
    p_note: reason,
    p_resolution: {
      outcome: "staging_pre_hardening_residue_reconciled",
      summary: reason,
      recordedFrom: "audited_staging_reconciliation",
      whatsappMessageSent: false,
    },
  });
  if (error) throw error;
}

async function reconcileNeoConversation(): Promise<Record<string, unknown>> {
  const { data: contacts, error: contactError } = await supabase
    .from("ai_contacts")
    .select("id,wa_id,profile_name")
    .like("wa_id", "%2052")
    .order("last_seen_at", { ascending: false })
    .limit(3);
  if (contactError) throw contactError;
  if (!contacts?.length) throw new Error("neo_contact_not_found");
  const contact = contacts[0];

  const { data: conversations, error: conversationError } = await supabase
    .from("ai_conversations")
    .select("id,status,operating_mode,current_risk,human_takeover_until")
    .eq("contact_id", contact.id)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (conversationError) throw conversationError;
  const conversation = conversations?.find((item) => item.status === "active") ?? conversations?.[0];
  if (!conversation) throw new Error("neo_conversation_not_found");

  const { data: openTasks, error: taskError } = await supabase
    .from("ai_handoff_tasks")
    .select("id,task_type,scope,status,version")
    .eq("conversation_id", conversation.id)
    .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"]);
  if (taskError) throw taskError;
  if ((openTasks ?? []).length > 0) {
    throw new Error("neo_conversation_still_has_open_human_tasks");
  }

  const { data: incidents, error: incidentError } = await supabase
    .from("ai_incidents")
    .select("id,source_message_id,category,severity,status,resolution")
    .eq("conversation_id", conversation.id)
    .in("status", ["open", "monitoring"]);
  if (incidentError) throw incidentError;
  const now = new Date().toISOString();
  for (const incident of incidents ?? []) {
    const { error } = await supabase
      .from("ai_incidents")
      .update({
        status: "resolved",
        resolution: {
          ...(object(incident.resolution) as JsonValue),
          outcome: "controlled_staging_test_closed",
          summary:
            "Controlled staging complaint incident closed after the named human-action task was resolved. No real remedy, liability decision, refund, compensation or redo was authorised.",
          recordedFrom: "audited_staging_reconciliation",
          whatsappMessageSent: false,
        },
        updated_at: now,
      })
      .eq("id", incident.id)
      .in("status", ["open", "monitoring"]);
    if (error) throw error;
    await audit("controlled_staging_incident_resolved", "incident", incident.id, {
      conversationId: conversation.id,
      sourceMessageId: incident.source_message_id,
      category: incident.category,
      severity: incident.severity,
      whatsappMessageSent: false,
    });
  }

  if (conversation.operating_mode === "management") {
    await setConversationAi(
      conversation.id,
      "Controlled staging human handling is complete; all human-action tasks are terminal and the test incident has been resolved.",
    );
  }

  return {
    conversationId: conversation.id,
    incidentsResolved: (incidents ?? []).length,
    openTaskCount: 0,
    returnedToAi: conversation.operating_mode === "management",
  };
}

async function reconcilePreHardeningBacklog(): Promise<Record<string, unknown>> {
  const { data: jobs, error: jobError } = await supabase
    .from("ai_jobs")
    .select("id,source_message_id,status,attempts,max_attempts,created_at")
    .in("status", ["retry", "dead"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (jobError) throw jobError;
  const sourceIds = [...new Set((jobs ?? []).map((job) => job.source_message_id))];
  if (!sourceIds.length) return { reconciled: [], reprocessed: [], summary: null };

  const { data: messages, error: messageError } = await supabase
    .from("ai_messages")
    .select("id,conversation_id,text_body,created_at")
    .in("id", sourceIds);
  if (messageError) throw messageError;
  const messageById = new Map((messages ?? []).map((message) => [message.id, message]));
  const exactAckJobs = (jobs ?? []).filter((job) => {
    const text = messageById.get(job.source_message_id)?.text_body;
    return text === "OK" || text === "Ok";
  });

  const completedWithoutReply: string[] = [];
  const reprocessIds: string[] = [];
  for (const job of exactAckJobs) {
    const message = messageById.get(job.source_message_id);
    if (!message) continue;
    const { data: conversations, error: conversationError } = await supabase
      .from("ai_conversations")
      .select("id,operating_mode,state")
      .eq("id", message.conversation_id)
      .limit(1);
    if (conversationError) throw conversationError;
    const conversation = conversations?.[0];
    if (!conversation) continue;

    const { data: tasks, error: taskError } = await supabase
      .from("ai_handoff_tasks")
      .select("id,task_type,scope,status,version")
      .eq("source_message_id", message.id)
      .in("status", ["new", "assigned", "accepted", "waiting_client", "waiting_internal"]);
    if (taskError) throw taskError;

    if (conversation.operating_mode === "management") {
      for (const task of tasks ?? []) {
        if (task.task_type === "system_failure") {
          await cancelTask(
            task,
            "Cancelled pre-hardening staging system-failure residue for an acknowledgement-only message; no client reply was sent.",
          );
        }
      }
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("ai_jobs")
        .update({
          status: "completed",
          completed_at: now,
          locked_at: null,
          locked_by: null,
          last_error: "reconciled_pre_hardening_acknowledgement_during_human_handling",
          updated_at: now,
        })
        .eq("id", job.id)
        .in("status", ["retry", "dead"]);
      if (error) throw error;
      await audit("pre_hardening_acknowledgement_job_reconciled", "job", job.id, {
        sourceMessageId: message.id,
        conversationId: conversation.id,
        originalStatus: job.status,
        conversationMode: conversation.operating_mode,
        whatsappMessageSent: false,
      });
      completedWithoutReply.push(job.id);
      continue;
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from("ai_jobs")
      .update({
        status: "retry",
        attempts: 0,
        available_at: now,
        locked_at: null,
        locked_by: null,
        completed_at: null,
        last_error: "reprocessing_after_structured_fallback_hardening",
        updated_at: now,
      })
      .eq("id", job.id)
      .in("status", ["retry", "dead"]);
    if (error) throw error;
    await audit("pre_hardening_job_requeued", "job", job.id, {
      sourceMessageId: message.id,
      conversationId: conversation.id,
      originalStatus: job.status,
      whatsappMode: "shadow",
    });
    reprocessIds.push(job.id);
  }

  let summary: unknown = null;
  if (reprocessIds.length > 0) {
    summary = await drainReceptionistForJobs(
      createProductionRuntime(),
      reprocessIds,
      reprocessIds.length,
    );
    const { data: after, error } = await supabase
      .from("ai_jobs")
      .select("id,status,attempts,last_error,completed_at")
      .in("id", reprocessIds);
    if (error) throw error;
    if ((after ?? []).some((job) => job.status !== "completed")) {
      console.log("HERA_BACKLOG_REPROCESS_INCOMPLETE", JSON.stringify(after));
      throw new Error("pre_hardening_backlog_did_not_complete_under_hardened_runtime");
    }
  }

  return {
    reconciled: completedWithoutReply,
    reprocessed: reprocessIds,
    summary,
  };
}

function inbound(
  waId: string,
  profileName: string,
  providerMessageId: string,
  text: string,
): InboundMessage {
  return {
    providerMessageId,
    fromWaId: waId,
    profileName,
    phoneNumberId: "staging-proof",
    businessAccountId: "staging-proof",
    kind: "text",
    text,
    providerTimestamp: new Date().toISOString(),
    raw: {
      controlledStagingProof: true,
      providerMessageId,
    },
  };
}

async function runSyntheticPriorityProof(): Promise<Record<string, unknown>> {
  const suffix = Date.now().toString().slice(-6);
  const oldWaId = `6597${suffix}`;
  const freshWaId = `6598${suffix}`;
  const oldProviderId = `hera-staging-old-${suffix}`;
  const freshProviderId = `hera-staging-fresh-${suffix}`;
  let oldContactId: string | null = null;
  let freshContactId: string | null = null;

  try {
    const oldResult = await repository.ingestInbound(
      inbound(oldWaId, "Hera QA Old Backlog", oldProviderId, "OK"),
    );
    const freshResult = await repository.ingestInbound(
      inbound(
        freshWaId,
        "Hera QA Fresh Complaint",
        freshProviderId,
        COMPLAINT_TEXT,
      ),
    );
    oldContactId = oldResult.contactId;
    freshContactId = freshResult.contactId;
    if (!oldResult.jobId || !freshResult.jobId) {
      throw new Error("synthetic_proof_jobs_not_created");
    }

    const now = new Date().toISOString();
    const { error: oldRetryError } = await supabase
      .from("ai_jobs")
      .update({
        status: "retry",
        attempts: 1,
        available_at: now,
        locked_at: null,
        locked_by: null,
        last_error: "synthetic_unrelated_older_retry",
        updated_at: now,
      })
      .eq("id", oldResult.jobId);
    if (oldRetryError) throw oldRetryError;

    let drainSummary: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      drainSummary = await drainReceptionistForJobs(
        createProductionRuntime(),
        [freshResult.jobId],
        1,
      );
      const { data: freshJobs, error: freshJobError } = await supabase
        .from("ai_jobs")
        .select("id,status,attempts,available_at,last_error,completed_at")
        .eq("id", freshResult.jobId)
        .limit(1);
      if (freshJobError) throw freshJobError;
      const freshJob = freshJobs?.[0];
      if (freshJob?.status === "completed") break;
      if (freshJob?.status !== "retry") {
        throw new Error(`synthetic_fresh_job_${freshJob?.status ?? "missing"}`);
      }
      const { error: retryNowError } = await supabase
        .from("ai_jobs")
        .update({ available_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", freshResult.jobId)
        .eq("status", "retry");
      if (retryNowError) throw retryNowError;
    }

    const [freshJobs, oldJobs, decisions, tasks, outbox, conversation] = await Promise.all([
      supabase.from("ai_jobs").select("id,status,attempts,last_error,completed_at").eq("id", freshResult.jobId),
      supabase.from("ai_jobs").select("id,status,attempts,last_error,completed_at").eq("id", oldResult.jobId),
      supabase.from("ai_decisions").select("stage,model_id,prompt_version,policy_version,risk,confidence,output,created_at").eq("source_message_id", freshResult.messageId).order("created_at"),
      supabase.from("ai_handoff_tasks").select("id,task_type,scope,priority,status,assigned_role,assigned_outlet,version,client_visible_status").eq("source_message_id", freshResult.messageId),
      supabase.from("ai_outbox").select("id,target_type,send_authorization,status,body,provider_message_id,last_error").eq("source_message_id", freshResult.messageId),
      supabase.from("ai_conversations").select("id,operating_mode,current_risk,human_takeover_until").eq("id", freshResult.conversationId),
    ]);
    for (const result of [freshJobs, oldJobs, decisions, tasks, outbox, conversation]) {
      if (result.error) throw result.error;
    }

    const freshJob = freshJobs.data?.[0];
    const oldJob = oldJobs.data?.[0];
    const stages = (decisions.data ?? []).map((item) => item.stage);
    const policyDecision = (decisions.data ?? []).find((item) => item.stage === "policy");
    const policyOutput = object(policyDecision?.output);
    const finalVerification = object(policyOutput.finalVerification);
    const finalQuality = object(policyOutput.finalQuality);
    const finalReply = preview(policyOutput.finalReply, 1800);
    const task = tasks.data?.[0];
    const clientOutbox = (outbox.data ?? []).find((item) => item.target_type === "client");
    const freshConversation = conversation.data?.[0];

    const pass =
      freshJob?.status === "completed" &&
      oldJob?.status === "retry" &&
      stages.includes("response") &&
      stages.includes("verification") &&
      stages.includes("policy") &&
      task?.task_type === "complaint_review" &&
      task?.scope === "full_takeover" &&
      task?.assigned_role === "salon_manager" &&
      freshConversation?.operating_mode === "management" &&
      policyOutput.deliveryEligible === true &&
      finalQuality.passed === true &&
      finalVerification.approved === true &&
      allPerfectScores(finalVerification.scores) &&
      clientOutbox?.status === "shadowed" &&
      !clientOutbox?.provider_message_id &&
      Boolean(finalReply?.toLowerCase().includes("curly haircut")) &&
      Boolean(finalReply?.toLowerCase().includes("tanglin mall")) &&
      Boolean(finalReply?.toLowerCase().includes("salon manager"));

    const proof = {
      pass,
      drainSummary,
      freshJob,
      unrelatedOlderRetryJob: oldJob,
      decisionStages: stages,
      models: (decisions.data ?? []).map((item) => ({
        stage: item.stage,
        modelId: item.model_id,
        promptVersion: item.prompt_version,
        policyVersion: item.policy_version,
      })),
      finalReply,
      finalQuality: {
        passed: finalQuality.passed === true,
        issues: finalQuality.issues ?? [],
      },
      finalVerifier: {
        approved: finalVerification.approved === true,
        modelId: finalVerification.modelId ?? policyDecision?.model_id ?? null,
        scores: finalVerification.scores ?? null,
        issues: finalVerification.issues ?? [],
        summary: finalVerification.summary ?? null,
      },
      task: task
        ? {
            taskType: task.task_type,
            scope: task.scope,
            priority: task.priority,
            status: task.status,
            assignedRole: task.assigned_role,
            assignedOutlet: task.assigned_outlet,
            version: task.version,
          }
        : null,
      conversation: freshConversation,
      clientOutbox: clientOutbox
        ? {
            status: clientOutbox.status,
            sendAuthorization: clientOutbox.send_authorization,
            providerMessageIdRecorded: Boolean(clientOutbox.provider_message_id),
            lastError: clientOutbox.last_error,
          }
        : null,
      whatsappSendAttempted: false,
      productionTouched: false,
    };
    console.log("HERA_FRESH_INBOUND_PRIORITY_PROOF", JSON.stringify(proof));
    if (!pass) throw new Error("fresh_inbound_priority_proof_failed");
    return proof;
  } finally {
    const ids = [oldContactId, freshContactId].filter(
      (value): value is string => typeof value === "string",
    );
    if (ids.length > 0) {
      const { error } = await supabase.from("ai_contacts").delete().in("id", ids);
      if (error) throw error;
    }
  }
}

const neoReconciliation = await reconcileNeoConversation();
const backlogReconciliation = await reconcilePreHardeningBacklog();
const priorityProof = await runSyntheticPriorityProof();

const { data: remainingJobs, error: remainingJobError } = await supabase
  .from("ai_jobs")
  .select("id,source_message_id,status,attempts,last_error")
  .in("status", ["pending", "processing", "retry", "dead"])
  .order("created_at")
  .limit(100);
if (remainingJobError) throw remainingJobError;

console.log("HERA_STAGING_RECONCILIATION_COMPLETE", JSON.stringify({
  neoReconciliation,
  backlogReconciliation,
  priorityProofPass: priorityProof.pass === true,
  remainingActiveOrDeadJobs: remainingJobs ?? [],
  whatsappSendAttempted: false,
  productionTouched: false,
}));
