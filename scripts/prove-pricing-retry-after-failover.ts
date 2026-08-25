import { createClient } from "@supabase/supabase-js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../src/worker.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const TARGET_JOB_ID = "0b3984ae-4d5a-4aeb-af65-3199fa49b7ac";
const TARGET_MESSAGE_ID = "3a64e356-310e-4126-88aa-ec356fd6a8d5";
const SUPERSEDED_COMPLAINT_ID = "9cac9cbe-b819-431f-b8f6-16f79494832d";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeText(value: unknown, max = 1200): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .replace(/(?:sk|pk|eyJ)[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("proof_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("proof_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") throw new Error("proof_requires_shadow_mode");
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("proof_refuses_live_confirmation");
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-structured-failover-proof" } },
});

const { data: before, error: beforeError } = await supabase
  .from("ai_jobs")
  .select("*")
  .eq("id", TARGET_JOB_ID)
  .single();
if (beforeError) throw beforeError;
assert(before, "target_job_not_found");

let drainSummary: unknown = null;
if (["pending", "retry", "processing"].includes(String(before.status))) {
  drainSummary = await drainReceptionistForJobs(
    createProductionRuntime(),
    [TARGET_JOB_ID],
    1,
  );
}

const [jobResult, decisionsResult, outboxResult, tasksResult, staleDecisionResult, staleOutboxResult, staleTaskResult] =
  await Promise.all([
    supabase.from("ai_jobs").select("*").eq("id", TARGET_JOB_ID).single(),
    supabase
      .from("ai_decisions")
      .select("id,stage,model_id,prompt_version,policy_version,risk,confidence,output,latency_ms,created_at")
      .eq("source_message_id", TARGET_MESSAGE_ID)
      .order("created_at", { ascending: true }),
    supabase
      .from("ai_outbox")
      .select("id,status,target_type,send_authorization,provider_message_id,last_error,created_at,updated_at")
      .eq("source_message_id", TARGET_MESSAGE_ID)
      .order("created_at", { ascending: true }),
    supabase
      .from("ai_handoff_tasks")
      .select("id,task_type,scope,priority,status,assigned_role,summary,created_at")
      .eq("source_message_id", TARGET_MESSAGE_ID),
    supabase.from("ai_decisions").select("id").eq("source_message_id", SUPERSEDED_COMPLAINT_ID),
    supabase.from("ai_outbox").select("id,provider_message_id").eq("source_message_id", SUPERSEDED_COMPLAINT_ID),
    supabase.from("ai_handoff_tasks").select("id,task_type,status").eq("source_message_id", SUPERSEDED_COMPLAINT_ID),
  ]);
for (const result of [
  jobResult,
  decisionsResult,
  outboxResult,
  tasksResult,
  staleDecisionResult,
  staleOutboxResult,
  staleTaskResult,
]) {
  if (result.error) throw result.error;
}

const job = jobResult.data;
const decisions = decisionsResult.data ?? [];
const outbox = outboxResult.data ?? [];
const tasks = tasksResult.data ?? [];
const stages = new Set(decisions.map((decision) => decision.stage));
const clientCandidates = outbox.filter((item) => item.target_type === "client");
const providerSendCount = outbox.filter((item) => item.provider_message_id).length;
const policyDecision = decisions.find((decision) => decision.stage === "policy");
const policyOutput = record(policyDecision?.output);
const finalVerification = record(policyOutput?.finalVerification);
const finalQuality = record(policyOutput?.finalQuality);

assert(job?.status === "completed", `target_job_not_completed:${job?.status}`);
assert(stages.has("response"), "response_stage_missing");
assert(stages.has("verification"), "first_verifier_stage_missing");
assert(stages.has("policy"), "final_quality_stage_missing");
assert(clientCandidates.length === 1, `expected_one_client_candidate:${clientCandidates.length}`);
assert(clientCandidates[0]?.status === "shadowed", `candidate_not_shadowed:${clientCandidates[0]?.status}`);
assert(providerSendCount === 0, "provider_send_detected");
assert(tasks.length === 0, `unexpected_handoff_for_pricing:${tasks.length}`);
assert(policyOutput?.deliveryEligible === true, "pricing_final_response_not_delivery_eligible");
assert(finalVerification?.approved === true, "final_verifier_not_approved");
assert(finalQuality?.passed === true, "deterministic_final_quality_not_passed");
assert((staleDecisionResult.data ?? []).length === 0, "stale_complaint_decision_created");
assert((staleOutboxResult.data ?? []).length === 0, "stale_complaint_candidate_created");
assert((staleTaskResult.data ?? []).length === 0, "stale_complaint_task_created");

console.log(
  "HERA_STRUCTURED_FAILOVER_RECOVERY_PROOF",
  JSON.stringify({
    pass: true,
    target: {
      jobId: TARGET_JOB_ID,
      messageId: TARGET_MESSAGE_ID,
      statusBefore: before.status,
      attemptsBefore: before.attempts,
      statusAfter: job.status,
      attemptsAfter: job.attempts,
      completedAt: job.completed_at,
      lastError: safeText(job.last_error),
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
    finalReply: safeText(policyOutput?.finalReply),
    finalVerifier: {
      modelId: finalVerification?.modelId ?? null,
      approved: finalVerification?.approved ?? null,
      scores: finalVerification?.scores ?? null,
      issues: finalVerification?.issues ?? null,
    },
    deterministicQuality: finalQuality,
    candidate: clientCandidates.map((candidate) => ({
      status: candidate.status,
      authorization: candidate.send_authorization,
      providerMessageIdRecorded: Boolean(candidate.provider_message_id),
      lastError: safeText(candidate.last_error),
    })),
    pricingHandoffTasks: tasks.length,
    supersededComplaint: {
      decisions: (staleDecisionResult.data ?? []).length,
      candidates: (staleOutboxResult.data ?? []).length,
      tasks: (staleTaskResult.data ?? []).length,
    },
    whatsappProviderSends: providerSendCount,
    productionTouched: false,
  }),
);
