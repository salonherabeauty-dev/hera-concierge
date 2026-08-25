import { createClient } from "@supabase/supabase-js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../src/worker.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const TARGET_TEXT = "How much is your curly haircut";
const SUPERSEDED_COMPLAINT_FRAGMENT = "uneven and disconnected";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeText(value: unknown, max = 700): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .replace(/(?:sk|pk|eyJ)[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("proof_requires_preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("proof_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
  throw new Error("proof_requires_shadow_mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("proof_refuses_live_confirmation");
}

const supabase = createClient(
  required("SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-fresh-priority-proof" } },
  },
);

const { data: contacts, error: contactError } = await supabase
  .from("ai_contacts")
  .select("id,wa_id,profile_name,last_seen_at")
  .like("wa_id", "%2052")
  .order("last_seen_at", { ascending: false })
  .limit(3);
if (contactError) throw contactError;
assert(contacts?.length, "contact_ending_2052_not_found");
const contact = contacts[0];

const { data: conversations, error: conversationError } = await supabase
  .from("ai_conversations")
  .select("id,status,operating_mode,current_risk,human_takeover_until,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationError) throw conversationError;
assert(conversations?.length, "conversation_not_found");
const conversation =
  conversations.find((item) => item.status === "active") ?? conversations[0];

const { data: messages, error: messageError } = await supabase
  .from("ai_messages")
  .select("id,text_body,provider_timestamp,created_at")
  .eq("conversation_id", conversation.id)
  .eq("direction", "inbound")
  .order("created_at", { ascending: false })
  .limit(30);
if (messageError) throw messageError;
assert(messages?.length, "inbound_messages_not_found");
const targetMessage = messages.find(
  (message) => String(message.text_body).trim() === TARGET_TEXT,
);
assert(targetMessage, "pricing_target_message_not_found");
const complaintMessage = messages.find((message) =>
  String(message.text_body).includes(SUPERSEDED_COMPLAINT_FRAGMENT),
);
assert(complaintMessage, "superseded_complaint_message_not_found");

const { data: targetJobBefore, error: jobBeforeError } = await supabase
  .from("ai_jobs")
  .select("*")
  .eq("source_message_id", targetMessage.id)
  .single();
if (jobBeforeError) throw jobBeforeError;
assert(targetJobBefore, "pricing_target_job_not_found");

const beforeStatus = String(targetJobBefore.status);
let drainSummary: unknown = null;
if (["pending", "retry", "processing"].includes(beforeStatus)) {
  drainSummary = await drainReceptionistForJobs(
    createProductionRuntime(),
    [String(targetJobBefore.id)],
    1,
  );
}

const [jobAfterResult, decisionsResult, outboxResult, tasksResult, complaintDecisionResult, complaintOutboxResult, complaintTaskResult] =
  await Promise.all([
    supabase
      .from("ai_jobs")
      .select("*")
      .eq("id", targetJobBefore.id)
      .single(),
    supabase
      .from("ai_decisions")
      .select("id,stage,model_id,prompt_version,policy_version,risk,confidence,output,created_at,latency_ms")
      .eq("source_message_id", targetMessage.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("ai_outbox")
      .select("id,status,target_type,send_authorization,provider_message_id,last_error,created_at,updated_at")
      .eq("source_message_id", targetMessage.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("ai_handoff_tasks")
      .select("id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,version,summary,created_at")
      .eq("source_message_id", targetMessage.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("ai_decisions")
      .select("id")
      .eq("source_message_id", complaintMessage.id),
    supabase
      .from("ai_outbox")
      .select("id,provider_message_id")
      .eq("source_message_id", complaintMessage.id),
    supabase
      .from("ai_handoff_tasks")
      .select("id,task_type,status")
      .eq("source_message_id", complaintMessage.id),
  ]);
for (const result of [
  jobAfterResult,
  decisionsResult,
  outboxResult,
  tasksResult,
  complaintDecisionResult,
  complaintOutboxResult,
  complaintTaskResult,
]) {
  if (result.error) throw result.error;
}

const jobAfter = jobAfterResult.data;
const decisions = decisionsResult.data ?? [];
const outbox = outboxResult.data ?? [];
const tasks = tasksResult.data ?? [];
const stages = new Set(decisions.map((decision) => decision.stage));
const clientCandidates = outbox.filter((item) => item.target_type === "client");
const providerSendCount = outbox.filter((item) => item.provider_message_id).length;

assert(jobAfter?.status === "completed", `pricing_job_not_completed:${jobAfter?.status}`);
assert(stages.has("response"), "pricing_response_decision_missing");
assert(stages.has("verification"), "pricing_first_verification_missing");
assert(stages.has("policy"), "pricing_final_policy_decision_missing");
assert(clientCandidates.length === 1, `expected_one_pricing_candidate:${clientCandidates.length}`);
assert(clientCandidates[0]?.status === "shadowed", `pricing_candidate_not_shadowed:${clientCandidates[0]?.status}`);
assert(providerSendCount === 0, "pricing_provider_send_detected");
assert(tasks.length === 0, `unexpected_pricing_handoff_task:${tasks.length}`);
assert((complaintDecisionResult.data ?? []).length === 0, "superseded_complaint_decision_created");
assert((complaintOutboxResult.data ?? []).length === 0, "superseded_complaint_candidate_created");
assert((complaintTaskResult.data ?? []).length === 0, "superseded_complaint_task_created");

const policyDecision = decisions.find((decision) => decision.stage === "policy");
const policyOutput =
  policyDecision?.output &&
  typeof policyDecision.output === "object" &&
  !Array.isArray(policyDecision.output)
    ? (policyDecision.output as Record<string, unknown>)
    : null;

console.log(
  "HERA_FRESH_PRIORITY_RECOVERY_PROOF",
  JSON.stringify({
    pass: true,
    contact: {
      phoneEnding: String(contact.wa_id).slice(-4),
      profileName: contact.profile_name,
    },
    conversation: {
      id: conversation.id,
      operatingModeBefore: conversation.operating_mode,
      riskBefore: conversation.current_risk,
    },
    target: {
      messageId: targetMessage.id,
      text: TARGET_TEXT,
      jobId: targetJobBefore.id,
      statusBefore: beforeStatus,
      statusAfter: jobAfter.status,
      attemptsAfter: jobAfter.attempts,
      completedAt: jobAfter.completed_at,
      lastError: safeText(jobAfter.last_error),
    },
    drainSummary,
    decisions: decisions.map((decision) => ({
      stage: decision.stage,
      modelId: decision.model_id,
      promptVersion: decision.prompt_version,
      policyVersion: decision.policy_version,
      risk: decision.risk,
      confidence: decision.confidence,
      latencyMs: decision.latency_ms,
    })),
    finalQuality: policyOutput
      ? {
          deliveryEligible: policyOutput.deliveryEligible ?? null,
          finalReply: safeText(policyOutput.finalReply, 1200),
          finalQuality: policyOutput.finalQuality ?? null,
          finalVerification: policyOutput.finalVerification ?? null,
        }
      : null,
    candidate: clientCandidates.map((item) => ({
      status: item.status,
      authorization: item.send_authorization,
      providerMessageIdRecorded: Boolean(item.provider_message_id),
      lastError: safeText(item.last_error),
    })),
    handoffTaskCount: tasks.length,
    supersededComplaint: {
      messageId: complaintMessage.id,
      decisions: (complaintDecisionResult.data ?? []).length,
      candidates: (complaintOutboxResult.data ?? []).length,
      tasks: (complaintTaskResult.data ?? []).length,
    },
    whatsappProviderSends: providerSendCount,
    productionTouched: false,
  }),
);
