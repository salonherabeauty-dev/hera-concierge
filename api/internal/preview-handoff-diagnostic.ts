import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig, getOperationsConfig } from "../../src/config.js";
import { logOperationalEvent } from "../../src/observability/log.js";

const TARGET_JOB_ID = "5aa7fbfe-0306-4445-a81e-ef194dfdf3b5";

function safeClassification(input: unknown): string {
  const value =
    input && typeof input === "object"
      ? `${"code" in input ? String(input.code ?? "") : ""} ${
          "message" in input ? String(input.message ?? "") : ""
        }`
      : String(input ?? "");
  const normalized = value.toLowerCase();
  if (normalized.includes("pgrst202") || normalized.includes("could not find the function")) {
    return "automatic_handoff_rpc_missing";
  }
  if (
    normalized.includes("pgrst205") ||
    normalized.includes("could not find the table") ||
    normalized.includes("relation") && normalized.includes("does not exist")
  ) {
    return "command_centre_table_missing";
  }
  if (normalized.includes("foreign key") || normalized.includes("23503")) {
    return "rpc_present_fk_probe_rejected";
  }
  if (normalized.includes("schema cache")) return "schema_cache_not_ready";
  if (!normalized.trim()) return "none";
  return "other_database_error";
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const operations = getOperationsConfig();
  const previewOnly =
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === "feat/hera-ai-receptionist-foundation" &&
    operations.sendMode === "shadow" &&
    !process.env.WHATSAPP_LIVE_CONFIRMATION;

  if (!previewOnly) {
    return response.status(404).json({ error: "Not found" });
  }

  const database = getDatabaseConfig();
  const client = createClient(database.url, database.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const capabilityNames = [
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_PAT",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "DATABASE_URL",
    "SUPABASE_DB_URL",
    "SUPABASE_DB_PASSWORD",
  ] as const;
  const environmentCapabilities = Object.fromEntries(
    capabilityNames.map((name) => [name, Boolean(process.env[name])]),
  );

  const [taskTable, staffTable, job, taskCount, outboxCount, decisionCount, rpcProbe] =
    await Promise.all([
      client.from("ai_handoff_tasks").select("id", { count: "exact", head: true }),
      client.from("ai_staff_profiles").select("user_id", { count: "exact", head: true }),
      client
        .from("ai_jobs")
        .select("id,status,attempts,max_attempts,available_at,last_error,source_message_id,updated_at")
        .eq("id", TARGET_JOB_ID)
        .maybeSingle(),
      client
        .from("ai_handoff_tasks")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", TARGET_JOB_ID),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", TARGET_JOB_ID),
      client
        .from("ai_decisions")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", TARGET_JOB_ID),
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

  const sourceMessageId =
    job.data && typeof job.data.source_message_id === "string"
      ? job.data.source_message_id
      : null;

  const [realTaskCount, realOutboxCount, realDecisionCount] = sourceMessageId
    ? await Promise.all([
        client
          .from("ai_handoff_tasks")
          .select("id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
        client
          .from("ai_outbox")
          .select("id,status,provider_message_id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
        client
          .from("ai_decisions")
          .select("id", { count: "exact", head: true })
          .eq("source_message_id", sourceMessageId),
      ])
    : [taskCount, outboxCount, decisionCount];

  const diagnostic = {
    deployment: {
      environment: process.env.VERCEL_ENV ?? null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
      sendMode: operations.sendMode,
    },
    environmentCapabilities,
    schema: {
      handoffTable: taskTable.error ? safeClassification(taskTable.error) : "available",
      staffTable: staffTable.error ? safeClassification(staffTable.error) : "available",
      automaticHandoffRpc: rpcProbe.error
        ? safeClassification(rpcProbe.error)
        : "unexpected_probe_success",
    },
    job: job.error
      ? { found: false, classification: safeClassification(job.error) }
      : job.data
        ? {
            found: true,
            status: job.data.status,
            attempts: job.data.attempts,
            maxAttempts: job.data.max_attempts,
            availableAt: job.data.available_at,
            updatedAt: job.data.updated_at,
            lastError: safeClassification(job.data.last_error),
            sourceMessageIdPresent: Boolean(sourceMessageId),
          }
        : { found: false, classification: "not_found" },
    records: {
      handoffTasks: realTaskCount.error ? null : realTaskCount.count ?? 0,
      outboxItems: realOutboxCount.error ? null : realOutboxCount.count ?? 0,
      decisions: realDecisionCount.error ? null : realDecisionCount.count ?? 0,
    },
  };

  logOperationalEvent("info", "preview_handoff_diagnostic", diagnostic);
  return response.status(200).json({ ok: true, diagnostic });
}
