import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const EXPECTED_REPLY =
  "Yes. Hera’s Tanglin Mall atelier offers specialist curly haircuts for waves, curls and coils, with curl-defining and hydration care available where suitable. For the most accurate stylist match, share a current hair photo and the shape or concern you would like us to address.";
const TEXT_MARKER = "do you offer curly haircuts at tanglin mall";
const PHONE_ENDING = "2052";

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing_${name.toLowerCase()}`);
  }
  return value.trim();
}

function assertSafeEnvironment() {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("verification_requires_vercel_preview");
  }
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("verification_requires_authoritative_staging_branch");
  }
  if ((process.env.WHATSAPP_SEND_MODE ?? "shadow") !== "shadow") {
    throw new Error("verification_requires_shadow_mode");
  }
  if ((process.env.WHATSAPP_LIVE_CONFIRMATION ?? "").trim()) {
    throw new Error("verification_refuses_live_confirmation");
  }
}

function check(result, label) {
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

function bodyText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return typeof value.text === "string" ? value.text.trim() : "";
}

assertSafeEnvironment();

const database = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  global: { headers: { "X-Client-Info": "hera-curly-shadow-verifier/1.0" } },
});

const contacts = check(
  await database
    .from("ai_contacts")
    .select("id,wa_id")
    .like("wa_id", `%${PHONE_ENDING}`)
    .order("last_seen_at", { ascending: false })
    .limit(5),
  "load_contact",
);
if (!Array.isArray(contacts) || contacts.length === 0) {
  throw new Error("target_contact_not_found");
}
const contact = contacts[0];

const messages = check(
  await database
    .from("ai_messages")
    .select("id,conversation_id,text_body,provider_timestamp,created_at")
    .eq("contact_id", contact.id)
    .eq("direction", "inbound")
    .ilike("text_body", `%${TEXT_MARKER}%`)
    .order("created_at", { ascending: false })
    .limit(1),
  "load_message",
);
if (!Array.isArray(messages) || messages.length !== 1) {
  throw new Error("fresh_curly_message_not_found");
}
const message = messages[0];

const [conversation, jobs, decisions, outbox, tasks] = await Promise.all([
  database
    .from("ai_conversations")
    .select("operating_mode,current_risk,human_takeover_until,updated_at")
    .eq("id", message.conversation_id)
    .maybeSingle(),
  database
    .from("ai_jobs")
    .select("id,status,attempts,max_attempts,completed_at,created_at,updated_at")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  database
    .from("ai_decisions")
    .select("stage,prompt_version,policy_version,risk,confidence,output,created_at")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  database
    .from("ai_outbox")
    .select("id,status,target_type,body,send_authorization,provider_message_id,attempts,created_at,updated_at")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
  database
    .from("ai_handoff_tasks")
    .select("id,task_type,scope,priority,status,assigned_role,assigned_outlet,created_at")
    .eq("source_message_id", message.id)
    .order("created_at", { ascending: true }),
]);

const conversationRow = check(conversation, "load_conversation");
const jobRows = check(jobs, "load_jobs") ?? [];
const decisionRows = check(decisions, "load_decisions") ?? [];
const outboxRows = check(outbox, "load_outbox") ?? [];
const taskRows = check(tasks, "load_tasks") ?? [];

const candidateRows = outboxRows.filter((row) => row.target_type === "client");
const candidate = candidateRows.length === 1 ? candidateRows[0] : null;
const candidateText = candidate ? bodyText(candidate.body) : "";
const stages = [...new Set(decisionRows.map((row) => row.stage))].sort();
const providerSendEvidence = outboxRows.filter(
  (row) => typeof row.provider_message_id === "string" && row.provider_message_id.length > 0,
).length;

const pass =
  conversationRow?.operating_mode === "ai" &&
  jobRows.length === 1 &&
  jobRows[0]?.status === "completed" &&
  stages.length === 3 &&
  stages.includes("response") &&
  stages.includes("verification") &&
  stages.includes("policy") &&
  candidateRows.length === 1 &&
  candidate?.status === "shadowed" &&
  candidateText === EXPECTED_REPLY &&
  taskRows.length === 0 &&
  providerSendEvidence === 0 &&
  !/\bIrene\b|\b2\s*pm\b|live availability|reception/i.test(candidateText);

const proof = {
  pass,
  message: {
    id: message.id,
    text: message.text_body,
    providerTimestamp: message.provider_timestamp,
    createdAt: message.created_at,
    phoneEnding: String(contact.wa_id).slice(-4),
  },
  conversation: {
    operatingMode: conversationRow?.operating_mode ?? null,
    currentRisk: conversationRow?.current_risk ?? null,
    humanTakeoverUntil: conversationRow?.human_takeover_until ?? null,
  },
  jobs: jobRows.map((row) => ({
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    completedAt: row.completed_at,
  })),
  decisionStages: stages,
  candidate: candidate
    ? {
        status: candidate.status,
        targetType: candidate.target_type,
        authorization: candidate.send_authorization,
        text: candidateText,
      }
    : null,
  sourceTaskCount: taskRows.length,
  sourceTasks: taskRows.map((row) => ({
    taskType: row.task_type,
    scope: row.scope,
    priority: row.priority,
    status: row.status,
  })),
  providerSendEvidence,
  prohibitedCarryoverPresent: /\bIrene\b|\b2\s*pm\b|live availability|reception/i.test(candidateText),
};

console.log(`HERA_FRESH_CURLY_SERVICE_PROOF ${JSON.stringify(proof)}`);

if (!pass) {
  throw new Error("fresh_curly_service_quality_gate_failed");
}
