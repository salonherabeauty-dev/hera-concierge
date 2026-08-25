import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const PRICING_TEXT = "How much is your curly haircut";
const COMPLAINT_FRAGMENT = "uneven and disconnected";

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

function preview(value: unknown, max = 500): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("audit_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("audit_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("audit_refuses_live_confirmation");
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-staging-queue-audit" } },
});

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
  .select("id,status,operating_mode,current_risk,human_takeover_until,last_message_at,updated_at")
  .eq("contact_id", contact.id)
  .order("updated_at", { ascending: false })
  .limit(5);
if (conversationError) throw conversationError;
if (!conversations?.length) throw new Error("conversation_not_found");
const conversation = conversations.find((item) => item.status === "active") ?? conversations[0];

const { data: messages, error: messageError } = await supabase
  .from("ai_messages")
  .select("id,direction,kind,text_body,ai_generated,delivery_status,provider_timestamp,created_at")
  .eq("conversation_id", conversation.id)
  .order("created_at", { ascending: false })
  .limit(40);
if (messageError) throw messageError;
const pricingMessage = (messages ?? []).find((item) => item.text_body === PRICING_TEXT);
const complaintMessage = (messages ?? []).find((item) => String(item.text_body).includes(COMPLAINT_FRAGMENT));
if (!pricingMessage) throw new Error("pricing_message_not_found");
if (!complaintMessage) throw new Error("fresh_complaint_message_not_found");

const [pricingJobs, pricingDecisions, pricingOutbox, complaintJobs, tasks, incidents, activeJobs] = await Promise.all([
  supabase.from("ai_jobs").select("id,status,attempts,max_attempts,available_at,locked_at,completed_at,last_error,created_at,updated_at").eq("source_message_id", pricingMessage.id).order("created_at"),
  supabase.from("ai_decisions").select("stage,model_id,prompt_version,policy_version,risk,confidence,output,created_at").eq("source_message_id", pricingMessage.id).order("created_at"),
  supabase.from("ai_outbox").select("id,target_type,send_authorization,status,attempts,body,provider_message_id,last_error,created_at,updated_at").eq("source_message_id", pricingMessage.id).order("created_at"),
  supabase.from("ai_jobs").select("id,status,attempts,max_attempts,available_at,locked_at,completed_at,last_error,created_at,updated_at").eq("source_message_id", complaintMessage.id).order("created_at"),
  supabase.from("ai_handoff_tasks").select("id,source_message_id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,version,summary,created_at,updated_at,resolved_at").eq("conversation_id", conversation.id).order("created_at"),
  supabase.from("ai_incidents").select("id,source_message_id,category,severity,status,created_at,updated_at").eq("conversation_id", conversation.id).order("created_at"),
  supabase.from("ai_jobs").select("id,source_message_id,status,attempts,max_attempts,available_at,locked_at,last_error,created_at,updated_at").in("status", ["pending", "processing", "retry", "dead"]).order("created_at").limit(100),
]);
for (const result of [pricingJobs, pricingDecisions, pricingOutbox, complaintJobs, tasks, incidents, activeJobs]) {
  if (result.error) throw result.error;
}

const policyDecision = (pricingDecisions.data ?? []).find((item) => item.stage === "policy");
const policyOutput = object(policyDecision?.output);
const finalVerification = object(policyOutput.finalVerification);
const finalQuality = object(policyOutput.finalQuality);
const handoff = object(policyOutput.handoff);

console.log("HERA_CURRENT_CONVERSATION", JSON.stringify({
  phoneEnding: String(contact.wa_id).slice(-4),
  profileName: contact.profile_name,
  operatingMode: conversation.operating_mode,
  currentRisk: conversation.current_risk,
  humanTakeoverUntil: conversation.human_takeover_until,
  lastMessageAt: conversation.last_message_at,
  updatedAt: conversation.updated_at,
  latestMessage: (messages ?? [])[0] ? {
    direction: (messages ?? [])[0].direction,
    text: preview((messages ?? [])[0].text_body),
    providerTimestamp: (messages ?? [])[0].provider_timestamp,
  } : null,
}));

console.log("HERA_PRICING_EVIDENCE", JSON.stringify({
  messageId: pricingMessage.id,
  text: pricingMessage.text_body,
  createdAt: pricingMessage.created_at,
  jobs: (pricingJobs.data ?? []).map((job) => ({
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    completedAt: job.completed_at,
    lastError: preview(job.last_error),
  })),
  stages: (pricingDecisions.data ?? []).map((decision) => ({
    stage: decision.stage,
    modelId: decision.model_id,
    promptVersion: decision.prompt_version,
    policyVersion: decision.policy_version,
    risk: decision.risk,
    confidence: decision.confidence,
  })),
  finalReply: preview(policyOutput.finalReply, 1400),
  deliveryEligible: policyOutput.deliveryEligible === true,
  finalVerifier: {
    modelId: finalVerification.modelId ?? policyDecision?.model_id ?? null,
    approved: finalVerification.approved === true,
    scores: finalVerification.scores ?? null,
    issues: finalVerification.issues ?? [],
    summary: finalVerification.summary ?? null,
  },
  deterministicQuality: {
    passed: finalQuality.passed === true,
    issues: finalQuality.issues ?? [],
  },
  handoff: {
    createTask: handoff.createTask === true,
    taskType: handoff.taskType ?? null,
    scope: handoff.scope ?? null,
  },
  outbox: (pricingOutbox.data ?? []).map((item) => ({
    id: item.id,
    targetType: item.target_type,
    sendAuthorization: item.send_authorization,
    status: item.status,
    body: preview(object(item.body).text, 1400),
    attempts: item.attempts,
    providerMessageIdRecorded: Boolean(item.provider_message_id),
    lastError: preview(item.last_error),
  })),
}));

console.log("HERA_FRESH_COMPLAINT_EVIDENCE", JSON.stringify({
  messageId: complaintMessage.id,
  text: preview(complaintMessage.text_body, 900),
  createdAt: complaintMessage.created_at,
  jobs: (complaintJobs.data ?? []).map((job) => ({
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    completedAt: job.completed_at,
    lastError: preview(job.last_error),
  })),
}));

const taskEvidence = (tasks.data ?? []).map((task) => ({
  id: task.id,
  sourceMessageId: task.source_message_id,
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
  resolvedAt: task.resolved_at,
}));
console.log("HERA_TASK_AND_INCIDENT_STATE", JSON.stringify({
  openTasks: taskEvidence.filter((task) => !["resolved", "cancelled"].includes(String(task.status))),
  allTasks: taskEvidence,
  incidents: incidents.data ?? [],
}));

console.log("HERA_GLOBAL_ACTIVE_JOB_STATE", JSON.stringify({
  activeOrDeadJobs: (activeJobs.data ?? []).map((job) => ({
    id: job.id,
    sourceMessageId: job.source_message_id,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    availableAt: job.available_at,
    lockedAt: job.locked_at,
    lastError: preview(job.last_error),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  })),
  databaseMutationAttempted: false,
  whatsappSendAttempted: false,
}));
