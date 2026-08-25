import { createClient } from "@supabase/supabase-js";
import { createProductionRuntime, drainReceptionist } from "../src/worker.ts";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const LIVE_CONFIRMATION = "ENABLE_HERA_WHATSAPP_LIVE";
const TARGET_PHONE_ENDING = "2052";
const TARGET_TEXT_MARKER = "does hera offer curly haircuts at tanglin mall";

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertSafeEnvironment(): void {
  if (process.env.VERCEL_ENV !== "preview") throw new Error("verification_requires_vercel_preview");
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("verification_requires_authoritative_feature_branch");
  }
  if (process.env.WHATSAPP_SEND_MODE !== "shadow") throw new Error("verification_requires_shadow_mode");
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === LIVE_CONFIRMATION) {
    throw new Error("verification_refuses_live_confirmation");
  }
  if (!present(process.env.SUPABASE_URL) || !present(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("verification_database_configuration_missing");
  }
}

async function waitUntilAvailable(value: string | null): Promise<void> {
  if (!value) return;
  const availableAt = Date.parse(value);
  if (!Number.isFinite(availableAt)) return;
  const delay = availableAt - Date.now() + 750;
  if (delay > 0) await sleep(Math.min(delay, 60_000));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

assertSafeEnvironment();

const database = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { headers: { "X-Client-Info": "hera-ai-resumption-verifier/1.1" } },
});

async function loadTarget() {
  const contacts = await database
    .from("ai_contacts")
    .select("id,wa_id,profile_name")
    .like("wa_id", `%${TARGET_PHONE_ENDING}`)
    .order("last_seen_at", { ascending: false })
    .limit(5);
  if (contacts.error) throw contacts.error;
  if (!contacts.data?.length) throw new Error("target_contact_not_found");

  for (const contact of contacts.data) {
    const messages = await database
      .from("ai_messages")
      .select("id,conversation_id,contact_id,text_body,delivery_status,provider_timestamp,created_at")
      .eq("contact_id", contact.id)
      .eq("direction", "inbound")
      .ilike("text_body", `%${TARGET_TEXT_MARKER}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (messages.error) throw messages.error;
    if (messages.data?.[0]) return { contact, message: messages.data[0] };
  }
  throw new Error("target_ai_resumption_message_not_found");
}

async function loadJob(messageId: string) {
  const result = await database
    .from("ai_jobs")
    .select("id,status,attempts,max_attempts,available_at,completed_at,last_error,updated_at")
    .eq("source_message_id", messageId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new Error("target_ai_resumption_job_not_found");
  return result.data;
}

const target = await loadTarget();
let job = await loadJob(target.message.id);

for (let cycle = 0; cycle < 4 && job.status !== "completed"; cycle += 1) {
  if (job.status !== "pending" && job.status !== "retry") {
    throw new Error(`target_job_not_retryable_${job.status}`);
  }
  await waitUntilAvailable(job.available_at);
  const summary = await drainReceptionist(createProductionRuntime(process.env), 8);
  console.log(`HERA_AI_RESUMPTION_DRAIN ${JSON.stringify({
    cycle: cycle + 1,
    jobsClaimed: summary.jobsClaimed,
    jobsCompleted: summary.jobsCompleted,
    jobsRetried: summary.jobsRetried,
    outboxClaimed: summary.outboxClaimed,
    outboxSent: summary.outboxSent,
    outboxShadowed: summary.outboxShadowed,
  })}`);
  job = await loadJob(target.message.id);
}

const [conversationResult, decisionResult, outboxResult, taskResult] = await Promise.all([
  database
    .from("ai_conversations")
    .select("id,operating_mode,human_takeover_until,current_risk,updated_at")
    .eq("id", target.message.conversation_id)
    .single(),
  database
    .from("ai_decisions")
    .select("id,stage,risk,confidence,output,created_at")
    .eq("source_message_id", target.message.id)
    .order("created_at", { ascending: true }),
  database
    .from("ai_outbox")
    .select("id,status,target_type,send_authorization,provider_message_id,sent_at,body,created_at,updated_at")
    .eq("source_message_id", target.message.id)
    .order("created_at", { ascending: true }),
  database
    .from("ai_handoff_tasks")
    .select("id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,summary,requested_action,collected_facts,missing_facts,resolution,resolved_at,dedupe_key,version,created_at,updated_at")
    .eq("conversation_id", target.message.conversation_id)
    .order("created_at", { ascending: true }),
]);

if (conversationResult.error) throw conversationResult.error;
if (decisionResult.error) throw decisionResult.error;
if (outboxResult.error) throw outboxResult.error;
if (taskResult.error) throw taskResult.error;

const conversation = conversationResult.data;
const decisions = decisionResult.data ?? [];
const outbox = outboxResult.data ?? [];
const tasks = taskResult.data ?? [];
const bookingTasks = tasks.filter((task) => task.task_type === "booking_action");
const originalBooking = bookingTasks[0] ?? null;
const openTasks = tasks.filter((task) => !["resolved", "cancelled"].includes(task.status));
const stages = new Set(decisions.map((item) => item.stage));
const providerSendEvidence = outbox.filter(
  (item) => item.status === "sent" || item.provider_message_id || item.sent_at,
).length;
const shadowedClientCandidates = outbox.filter(
  (item) => item.target_type === "client" && item.status === "shadowed",
);

const decisionDiagnostics = decisions.map((item) => {
  const output = asRecord(item.output);
  const decision = asRecord(output.decision);
  const handoff = asRecord(output.handoff);
  const correctedHandoff = asRecord(output.correctedHandoff);
  return {
    stage: item.stage,
    risk: item.risk,
    intent: typeof decision.intent === "string" ? decision.intent : null,
    reply: typeof decision.reply === "string" ? decision.reply.slice(0, 500) : null,
    decisionHandoff: decision.handoff ?? null,
    policyHandoff: Object.keys(handoff).length ? handoff : null,
    verificationHandoffApproved:
      typeof output.handoffApproved === "boolean" ? output.handoffApproved : null,
    correctedHandoff: Object.keys(correctedHandoff).length ? correctedHandoff : null,
    finalReply: typeof output.finalReply === "string" ? output.finalReply.slice(0, 500) : null,
  };
});

const taskDiagnostics = tasks.map((task) => ({
  sourceIsTarget: task.source_message_id === target.message.id,
  taskType: task.task_type,
  scope: task.scope,
  priority: task.priority,
  status: task.status,
  assignedRole: task.assigned_role,
  assignedOutlet: task.assigned_outlet,
  ownerPresent: Boolean(task.owner_user_id),
  summary: task.summary,
  collectedFacts: task.collected_facts,
  missingFacts: task.missing_facts,
  outcome:
    task.resolution && typeof task.resolution === "object"
      ? (task.resolution as Record<string, unknown>).outcome ?? null
      : null,
  version: task.version,
  dedupeKey: task.dedupe_key,
}));

const report = {
  pass:
    job.status === "completed" &&
    conversation.operating_mode === "ai" &&
    stages.has("response") &&
    stages.has("verification") &&
    stages.has("policy") &&
    shadowedClientCandidates.length === 1 &&
    providerSendEvidence === 0 &&
    bookingTasks.length === 1 &&
    originalBooking?.status === "resolved" &&
    openTasks.length === 0,
  targetFound: true,
  contactEnding: target.contact.wa_id.slice(-4),
  messageRecorded: target.message.delivery_status === "received",
  job: {
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    completedAtPresent: Boolean(job.completed_at),
    lastErrorPresent: Boolean(job.last_error),
  },
  conversation: {
    mode: conversation.operating_mode,
    takeoverExpiryPresent: Boolean(conversation.human_takeover_until),
    risk: conversation.current_risk,
  },
  decisions: decisionDiagnostics,
  candidate: {
    count: outbox.length,
    shadowedClientCandidates: shadowedClientCandidates.length,
    providerSendEvidence,
    text:
      shadowedClientCandidates[0]?.body && typeof shadowedClientCandidates[0].body === "object"
        ? (shadowedClientCandidates[0].body as Record<string, unknown>).text ?? null
        : null,
  },
  tasks: taskDiagnostics,
  originalBooking: originalBooking
    ? {
        count: bookingTasks.length,
        status: originalBooking.status,
        version: originalBooking.version,
        ownerRetained: Boolean(originalBooking.owner_user_id),
        resolvedAtPresent: Boolean(originalBooking.resolved_at),
        outcome:
          originalBooking.resolution && typeof originalBooking.resolution === "object"
            ? (originalBooking.resolution as Record<string, unknown>).outcome ?? null
            : null,
      }
    : null,
  openTasks: openTasks.length,
  providerSends: 0,
};

console.log(`HERA_AI_RESUMPTION_DIAGNOSTIC ${JSON.stringify(report)}`);

if (!report.pass) throw new Error("ai_resumption_shadow_verification_failed");
