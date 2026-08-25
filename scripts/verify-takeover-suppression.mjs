import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const LIVE_CONFIRMATION = "ENABLE_HERA_WHATSAPP_LIVE";
const TARGET_TEXT_MARKER = "please let me know whether 2 pm is available";
const TARGET_PHONE_ENDING = "2052";

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeCount(result) {
  if (result.error) throw result.error;
  return result.count ?? 0;
}

function targetEnvironment() {
  return (
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === EXPECTED_BRANCH &&
    process.env.WHATSAPP_SEND_MODE === "shadow" &&
    process.env.WHATSAPP_LIVE_CONFIRMATION !== LIVE_CONFIRMATION
  );
}

if (!targetEnvironment()) {
  console.log(
    `HERA_TAKEOVER_SUPPRESSION_REPORT ${JSON.stringify({
      skipped: true,
      reason: "not_authoritative_shadow_preview",
    })}`,
  );
  process.exit(0);
}

if (!present(process.env.SUPABASE_URL) || !present(process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.log(
    `HERA_TAKEOVER_SUPPRESSION_REPORT ${JSON.stringify({
      skipped: true,
      reason: "database_configuration_unavailable",
    })}`,
  );
  process.exit(0);
}

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
      headers: { "X-Client-Info": "hera-takeover-suppression-verifier/1.0" },
    },
  },
);

try {
  const messages = await client
    .from("ai_messages")
    .select(
      "id,conversation_id,contact_id,text_body,provider_timestamp,created_at,direction,ai_generated,delivery_status",
    )
    .eq("direction", "inbound")
    .ilike("text_body", `%${TARGET_TEXT_MARKER}%`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (messages.error) throw messages.error;

  let target = null;
  let targetContact = null;
  for (const message of messages.data ?? []) {
    const contact = await client
      .from("ai_contacts")
      .select("id,wa_id")
      .eq("id", message.contact_id)
      .single();
    if (contact.error) throw contact.error;
    if (String(contact.data.wa_id).endsWith(TARGET_PHONE_ENDING)) {
      target = message;
      targetContact = contact.data;
      break;
    }
  }

  if (!target || !targetContact) {
    console.log(
      `HERA_TAKEOVER_SUPPRESSION_REPORT ${JSON.stringify({
        pass: false,
        targetFound: false,
        contactEnding: TARGET_PHONE_ENDING,
        providerSends: 0,
      })}`,
    );
    process.exit(0);
  }

  const [conversation, jobs, decisions, outbox, audits, humanEcho, task] = await Promise.all([
    client
      .from("ai_conversations")
      .select("operating_mode,human_takeover_until,state,updated_at")
      .eq("id", target.conversation_id)
      .single(),
    client
      .from("ai_jobs")
      .select("id,status", { count: "exact" })
      .eq("source_message_id", target.id),
    client
      .from("ai_decisions")
      .select("id,stage", { count: "exact" })
      .eq("source_message_id", target.id),
    client
      .from("ai_outbox")
      .select("id,status,provider_message_id,sent_at", { count: "exact" })
      .eq("source_message_id", target.id),
    client
      .from("ai_audit_log")
      .select("event_type,details,created_at")
      .eq("target_type", "message")
      .eq("target_id", target.id)
      .order("created_at", { ascending: false })
      .limit(10),
    client
      .from("ai_messages")
      .select("id,created_at,provider_timestamp")
      .eq("conversation_id", target.conversation_id)
      .eq("direction", "outbound")
      .eq("ai_generated", false)
      .lt("created_at", target.created_at)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("ai_handoff_tasks")
      .select("task_type,scope,priority,status,assigned_role,assigned_outlet,owner_user_id,due_at")
      .eq("conversation_id", target.conversation_id)
      .eq("task_type", "booking_action")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (conversation.error) throw conversation.error;
  if (jobs.error) throw jobs.error;
  if (decisions.error) throw decisions.error;
  if (outbox.error) throw outbox.error;
  if (audits.error) throw audits.error;
  if (humanEcho.error) throw humanEcho.error;
  if (task.error) throw task.error;

  const audit = (audits.data ?? []).find(
    (entry) =>
      entry.event_type === "message_recorded_human_takeover" ||
      entry?.details?.suppressedByHumanTakeover === true,
  );
  const targetAt = new Date(target.provider_timestamp ?? target.created_at).getTime();
  const takeoverUntil = conversation.data.human_takeover_until
    ? new Date(conversation.data.human_takeover_until).getTime()
    : null;
  const takeoverActiveAtReceipt =
    conversation.data.operating_mode === "management" &&
    (takeoverUntil === null || takeoverUntil > targetAt);
  const providerSendEvidence = (outbox.data ?? []).filter(
    (item) => item.provider_message_id || item.sent_at || item.status === "sent",
  ).length;
  const humanEchoBeforeTarget = Boolean(humanEcho.data);
  const humanEchoGapSeconds = humanEcho.data
    ? Math.max(
        0,
        Math.round(
          (new Date(target.created_at).getTime() -
            new Date(humanEcho.data.created_at).getTime()) /
            1000,
        ),
      )
    : null;
  const jobsCount = safeCount(jobs);
  const decisionsCount = safeCount(decisions);
  const outboxCount = safeCount(outbox);
  const suppressedByHumanTakeover =
    audit?.details?.suppressedByHumanTakeover === true ||
    audit?.event_type === "message_recorded_human_takeover";

  const pass =
    target.direction === "inbound" &&
    humanEchoBeforeTarget &&
    takeoverActiveAtReceipt &&
    suppressedByHumanTakeover &&
    jobsCount === 0 &&
    decisionsCount === 0 &&
    outboxCount === 0 &&
    providerSendEvidence === 0;

  console.log(
    `HERA_TAKEOVER_SUPPRESSION_REPORT ${JSON.stringify({
      pass,
      targetFound: true,
      contactEnding: TARGET_PHONE_ENDING,
      messageRecorded: true,
      deliveryStatus: target.delivery_status,
      humanEchoBeforeTarget,
      humanEchoGapSeconds,
      conversationMode: conversation.data.operating_mode,
      takeoverExpiryPresent: Boolean(conversation.data.human_takeover_until),
      takeoverActiveAtReceipt,
      auditEvent: audit?.event_type ?? null,
      suppressedByHumanTakeover,
      jobsForClientMessage: jobsCount,
      decisionsForClientMessage: decisionsCount,
      outboxForClientMessage: outboxCount,
      providerSendEvidence,
      bookingTask: task.data
        ? {
            type: task.data.task_type,
            scope: task.data.scope,
            priority: task.data.priority,
            status: task.data.status,
            assignedRole: task.data.assigned_role,
            assignedOutlet: task.data.assigned_outlet,
            ownerAssigned: Boolean(task.data.owner_user_id),
            dueAtPresent: Boolean(task.data.due_at),
          }
        : null,
      providerSends: 0,
    })}`,
  );
} catch (error) {
  console.log(
    `HERA_TAKEOVER_SUPPRESSION_REPORT ${JSON.stringify({
      pass: false,
      targetFound: null,
      classification: "read_only_verification_failed",
      errorName: error instanceof Error ? error.name : "Error",
      providerSends: 0,
    })}`,
  );
}
