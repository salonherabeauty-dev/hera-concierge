import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = process.env.SUPABASE_PROJECT_ID || "zjnbheohgwfzkmbnjqjr";
const TARGET_JOB_ID = "5aa7fbfe-0306-4445-a81e-ef194dfdf3b5";
const migrations = [
  "supabase/migrations/20260824000005_create_command_centre_foundation.sql",
  "supabase/migrations/20260824000006_add_automatic_handoff_engine.sql",
  "supabase/migrations/20260824000007_activate_full_handoff_takeover.sql",
];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function classify(error) {
  const text = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`.toLowerCase();
  if (!text.trim()) return "none";
  if (text.includes("pgrst202") || text.includes("could not find the function")) {
    return "automatic_handoff_rpc_missing";
  }
  if (
    text.includes("pgrst205") ||
    text.includes("could not find the table") ||
    (text.includes("relation") && text.includes("does not exist"))
  ) {
    return "command_centre_table_missing";
  }
  if (text.includes("23503") || text.includes("foreign key")) {
    return "rpc_present_fk_probe_rejected";
  }
  if (text.includes("schema cache")) return "schema_cache_not_ready";
  return "other_database_error";
}

async function managementQuery(token, query, readOnly = true) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, parameters: [], read_only: readOnly }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`management_query_http_${response.status}:${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const capabilities = {
  supabaseUrl: present(process.env.SUPABASE_URL),
  serviceRoleKey: present(process.env.SUPABASE_SERVICE_ROLE_KEY),
  managementToken: present(process.env.SUPABASE_ACCESS_TOKEN),
  databaseUrl: present(process.env.DATABASE_URL),
  postgresUrlNonPooling: present(process.env.POSTGRES_URL_NON_POOLING),
  supabaseDbUrl: present(process.env.SUPABASE_DB_URL),
};
console.log(`HERA_DIAGNOSTIC_CAPABILITIES ${JSON.stringify(capabilities)}`);

if (capabilities.managementToken) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const stateSql = `
    select
      to_regclass('public.ai_staff_profiles') is not null as staff_table,
      to_regclass('public.ai_handoff_tasks') is not null as handoff_table,
      to_regclass('public.ai_handoff_events') is not null as events_table,
      to_regclass('public.ai_handoff_sla_policies') is not null as sla_table,
      to_regprocedure('public.ai_upsert_automatic_handoff(uuid,uuid,text,text,text,text,text,text,text,jsonb,jsonb,text,timestamptz,text)') is not null as handoff_rpc,
      exists (
        select 1 from pg_trigger
        where tgname = 'ai_handoff_task_activate_takeover'
          and not tgisinternal
      ) as takeover_trigger;
  `;
  let state = await managementQuery(token, stateSql, true);
  const row = Array.isArray(state) ? state[0] : state?.result?.[0] ?? state?.[0] ?? state;
  console.log(`HERA_SCHEMA_BEFORE ${JSON.stringify(row ?? {})}`);

  const required = [
    !row?.staff_table || !row?.handoff_table || !row?.events_table || !row?.sla_table,
    !row?.handoff_rpc,
    !row?.takeover_trigger,
  ];

  for (let index = 0; index < migrations.length; index += 1) {
    if (!required[index]) continue;
    const sql = await readFile(migrations[index], "utf8");
    await managementQuery(token, sql, false);
    console.log(`HERA_MIGRATION_APPLIED ${migrations[index]}`);
  }

  state = await managementQuery(token, stateSql, true);
  const after = Array.isArray(state) ? state[0] : state?.result?.[0] ?? state?.[0] ?? state;
  console.log(`HERA_SCHEMA_AFTER ${JSON.stringify(after ?? {})}`);
}

if (capabilities.supabaseUrl && capabilities.serviceRoleKey) {
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );

  const [taskTable, staffTable, job, rpcProbe] = await Promise.all([
    client.from("ai_handoff_tasks").select("id", { count: "exact", head: true }),
    client.from("ai_staff_profiles").select("user_id", { count: "exact", head: true }),
    client
      .from("ai_jobs")
      .select("id,status,attempts,max_attempts,available_at,last_error,source_message_id,updated_at")
      .eq("id", TARGET_JOB_ID)
      .maybeSingle(),
    client.rpc("ai_upsert_automatic_handoff", {
      p_conversation_id: "00000000-0000-0000-0000-000000000001",
      p_source_message_id: "00000000-0000-0000-0000-000000000002",
      p_task_type: "booking_action",
      p_scope: "task_only",
      p_priority: "normal",
      p_assigned_role: "receptionist",
      p_assigned_outlet: "Tanglin Mall",
      p_summary: "Diagnostic probe",
      p_requested_action: "Diagnostic probe",
      p_collected_facts: {},
      p_missing_facts: [],
      p_client_visible_status: null,
      p_due_at: null,
      p_dedupe_key: "diagnostic-probe-never-persist",
    }),
  ]);

  const sourceMessageId = job.data?.source_message_id ?? null;
  const [handoffCount, outboxCount, decisionCount] = sourceMessageId
    ? await Promise.all([
        client
          .from("ai_handoff_tasks")
          .select("id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
        client
          .from("ai_outbox")
          .select("id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
        client
          .from("ai_decisions")
          .select("id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
      ])
    : [{ count: null, error: null }, { count: null, error: null }, { count: null, error: null }];

  const report = {
    schema: {
      handoffTable: taskTable.error ? classify(taskTable.error) : "available",
      staffTable: staffTable.error ? classify(staffTable.error) : "available",
      automaticHandoffRpc: rpcProbe.error ? classify(rpcProbe.error) : "unexpected_probe_success",
    },
    job: job.error
      ? { found: false, classification: classify(job.error) }
      : job.data
        ? {
            found: true,
            status: job.data.status,
            attempts: job.data.attempts,
            maxAttempts: job.data.max_attempts,
            availableAt: job.data.available_at,
            updatedAt: job.data.updated_at,
            lastError: classify(job.data.last_error),
            sourceMessageIdPresent: Boolean(sourceMessageId),
          }
        : { found: false, classification: "not_found" },
    records: {
      handoffTasks: handoffCount.error ? null : handoffCount.count,
      outboxItems: outboxCount.error ? null : outboxCount.count,
      decisions: decisionCount.error ? null : decisionCount.count,
    },
  };
  console.log(`HERA_STAGING_REPORT ${JSON.stringify(report)}`);
}

if (!capabilities.supabaseUrl || !capabilities.serviceRoleKey) {
  console.log("HERA_STAGING_REPORT unavailable_no_supabase_runtime_secrets");
}
