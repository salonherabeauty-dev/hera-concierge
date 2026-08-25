import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const PHONE_ENDING = "2052";
const TEXT_MARKERS = [
  "layers look uneven",
  "salon manager to review it",
];

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
  if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
    throw new Error("verification_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
    throw new Error("verification_refuses_live_confirmation");
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function bodyText(value) {
  const body = asObject(value);
  return typeof body.text === "string" ? body.text : "";
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasAllStages(rows) {
  const stages = new Set(rows.map((row) => row.stage));
  return ["response", "verification", "policy"].every((stage) => stages.has(stage));
}

async function run() {
  assertSafeEnvironment();

  const database = createClient(
    required("SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-controlled-complaint-verifier/1.0" } },
    },
  );

  const contactsResult = await database
    .from("ai_contacts")
    .select("id,wa_id,profile_name,last_seen_at")
    .like("wa_id", `%${PHONE_ENDING}`)
    .order("last_seen_at", { ascending: false })
    .limit(5);
  if (contactsResult.error) throw new Error(`contacts:${contactsResult.error.message}`);
  const contacts = contactsResult.data ?? [];
  if (contacts.length === 0) throw new Error("test_contact_not_found");

  const contactIds = contacts.map((contact) => contact.id);
  const messagesResult = await database
    .from("ai_messages")
    .select(
      "id,conversation_id,contact_id,provider_message_id,direction,kind,text_body,provider_timestamp,created_at",
    )
    .in("contact_id", contactIds)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(60);
  if (messagesResult.error) throw new Error(`messages:${messagesResult.error.message}`);

  const message = (messagesResult.data ?? []).find((row) => {
    const text = lower(row.text_body);
    return TEXT_MARKERS.every((marker) => text.includes(marker));
  });
  if (!message) throw new Error("controlled_complaint_message_not_found");

  const contact = contacts.find((row) => row.id === message.contact_id);
  if (!contact) throw new Error("message_contact_not_found");

  const [conversationResult, jobsResult, decisionsResult, tasksResult, outboxResult, incidentsResult] =
    await Promise.all([
      database
        .from("ai_conversations")
        .select("id,operating_mode,current_risk,human_takeover_until,state,updated_at")
        .eq("id", message.conversation_id)
        .single(),
      database
        .from("ai_jobs")
        .select("id,status,attempts,max_attempts,completed_at,last_error,created_at")
        .eq("source_message_id", message.id)
        .order("created_at", { ascending: true }),
      database
        .from("ai_decisions")
        .select("stage,risk,confidence,prompt_version,policy_version,output,created_at")
        .eq("source_message_id", message.id)
        .order("created_at", { ascending: true }),
      database
        .from("ai_handoff_tasks")
        .select(
          "id,task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,summary,requested_action,collected_facts,missing_facts,client_visible_status,due_at,version,created_at",
        )
        .eq("source_message_id", message.id)
        .order("created_at", { ascending: true }),
      database
        .from("ai_outbox")
        .select(
          "id,status,target_type,send_authorization,body,provider_message_id,created_at",
        )
        .eq("source_message_id", message.id)
        .order("created_at", { ascending: true }),
      database
        .from("ai_incidents")
        .select("id,category,severity,status,client_summary,evidence,created_at")
        .eq("source_message_id", message.id)
        .order("created_at", { ascending: true }),
    ]);

  for (const [label, result] of [
    ["conversation", conversationResult],
    ["jobs", jobsResult],
    ["decisions", decisionsResult],
    ["tasks", tasksResult],
    ["outbox", outboxResult],
    ["incidents", incidentsResult],
  ]) {
    if (result.error) throw new Error(`${label}:${result.error.message}`);
  }

  const conversation = conversationResult.data;
  const jobs = jobsResult.data ?? [];
  const decisions = decisionsResult.data ?? [];
  const tasks = tasksResult.data ?? [];
  const outbox = outboxResult.data ?? [];
  const incidents = incidentsResult.data ?? [];
  const task = tasks[0] ?? null;
  const candidate = outbox.find((row) => row.target_type === "client") ?? null;
  const candidateText = candidate ? bodyText(candidate.body) : "";
  const normalizedCandidate = lower(candidateText);

  const prohibitedLiabilityOrPromise =
    /\b(?:our fault|we caused|we damaged|stylist damaged|refund is approved|refund has been approved|you will receive a refund|compensation is approved|free redo|complimentary redo|guaranteed redo|we promise a refund)\b/i;
  const staleBookingCarryover =
    /\b(?:irene|2\s*pm|root colour|root color|28 august|friday 28)\b/i;

  const providerSendEvidence = outbox.filter(
    (row) => typeof row.provider_message_id === "string" && row.provider_message_id.length > 0,
  ).length;

  const pass = Boolean(
    conversation &&
      conversation.operating_mode === "management" &&
      conversation.human_takeover_until === null &&
      jobs.length === 1 &&
      jobs[0].status === "completed" &&
      jobs[0].attempts === 1 &&
      hasAllStages(decisions) &&
      tasks.length === 1 &&
      task?.task_type === "complaint_review" &&
      task?.scope === "full_takeover" &&
      task?.assigned_role === "salon_manager" &&
      ["assigned", "accepted"].includes(task?.status) &&
      typeof task?.due_at === "string" &&
      outbox.length === 1 &&
      candidate?.status === "shadowed" &&
      candidate?.target_type === "client" &&
      candidate?.send_authorization === "auto" &&
      providerSendEvidence === 0 &&
      candidateText.length > 0 &&
      /management team|manager|direct review/i.test(candidateText) &&
      !prohibitedLiabilityOrPromise.test(candidateText) &&
      !staleBookingCarryover.test(candidateText),
  );

  const policyDecision = decisions.find((row) => row.stage === "policy");
  const policyOutput = asObject(policyDecision?.output);
  const policy = asObject(policyOutput.policy);
  const handoff = asObject(policyOutput.handoff);

  console.log(
    "HERA_CONTROLLED_COMPLAINT_PROOF",
    JSON.stringify({
      pass,
      message: {
        id: message.id,
        text: message.text_body,
        providerTimestamp: message.provider_timestamp,
        createdAt: message.created_at,
        phoneEnding: String(contact.wa_id).slice(-4),
      },
      conversation: {
        operatingMode: conversation?.operating_mode ?? null,
        currentRisk: conversation?.current_risk ?? null,
        humanTakeoverUntil: conversation?.human_takeover_until ?? null,
      },
      jobs: jobs.map((row) => ({
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        completedAt: row.completed_at,
        lastErrorPresent: Boolean(row.last_error),
      })),
      decisionStages: decisions.map((row) => row.stage),
      policy: {
        risk: policy.risk ?? policyDecision?.risk ?? null,
        canAutoSend: policy.canAutoSend ?? null,
        requiresIncident: policy.requiresIncident ?? null,
        requiresManagementNotification: policy.requiresManagementNotification ?? null,
      },
      handoff: {
        createTask: handoff.createTask ?? null,
        taskType: handoff.taskType ?? null,
        scope: handoff.scope ?? null,
        priority: handoff.priority ?? null,
        assignedRole: handoff.assignedRole ?? null,
        assignedOutlet: handoff.assignedOutlet ?? null,
        reason: handoff.reason ?? null,
      },
      task: task
        ? {
            id: task.id,
            taskType: task.task_type,
            scope: task.scope,
            priority: task.priority,
            status: task.status,
            assignedRole: task.assigned_role,
            assignedOutlet: task.assigned_outlet,
            ownerAssigned: Boolean(task.owner_user_id),
            summary: task.summary,
            requestedAction: task.requested_action,
            collectedFacts: task.collected_facts,
            missingFacts: task.missing_facts,
            clientVisibleStatus: task.client_visible_status,
            dueAt: task.due_at,
            version: task.version,
          }
        : null,
      candidate: candidate
        ? {
            status: candidate.status,
            targetType: candidate.target_type,
            authorization: candidate.send_authorization,
            text: candidateText,
            providerMessageIdPresent: Boolean(candidate.provider_message_id),
          }
        : null,
      incidents: incidents.map((row) => ({
        category: row.category,
        severity: row.severity,
        status: row.status,
      })),
      sourceTaskCount: tasks.length,
      sourceOutboxCount: outbox.length,
      providerSendEvidence,
      prohibitedLiabilityOrPromisePresent: prohibitedLiabilityOrPromise.test(candidateText),
      staleBookingCarryoverPresent: staleBookingCarryover.test(candidateText),
    }),
  );

  if (!pass) process.exitCode = 1;
}

await run();
