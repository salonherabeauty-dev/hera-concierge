import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  getAiConfig,
  getD360Config,
  getDatabaseConfig,
  getOperationsConfig,
  getWhatsAppProviderConfig,
} from "../src/config.js";
import { SupabaseReceptionistRepository } from "../src/db/repository.js";
import { assessOperationalReadiness } from "../src/observability/readiness.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const KNOWN_CONTROLLED_COMPLAINT_MESSAGE_ID =
  "17c7a7bd-d89f-4c01-afc9-fc8d0556cfbb";

function fingerprint(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("stage0_runtime_probe_requires_authoritative_preview_branch");
  }

  const database = getDatabaseConfig();
  const operations = getOperationsConfig();
  const provider = getWhatsAppProviderConfig().provider;
  getAiConfig();
  if (provider === "360dialog") getD360Config();

  const repository = new SupabaseReceptionistRepository(
    database.url,
    database.serviceRoleKey,
  );
  const snapshot = await repository.getOperationalSnapshot();
  const readiness = assessOperationalReadiness(snapshot);

  const client = createClient(database.url, database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage0-runtime-probe" } },
  });

  const [incidentResult, taskResult, conversationResult, outboxResult, jobResult] =
    await Promise.all([
      client
        .from("ai_incidents")
        .select("id,source_message_id,category,severity,status,created_at,updated_at")
        .in("status", ["open", "monitoring"])
        .order("created_at", { ascending: true }),
      client
        .from("ai_handoff_tasks")
        .select("id", { count: "exact", head: true })
        .in("status", [
          "new",
          "assigned",
          "accepted",
          "waiting_client",
          "waiting_internal",
        ]),
      client
        .from("ai_conversations")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .eq("operating_mode", "management"),
      client
        .from("ai_outbox")
        .select("id,status,created_at,updated_at")
        .in("status", ["pending", "processing", "retry", "dead"])
        .order("created_at", { ascending: true })
        .limit(25),
      client
        .from("ai_jobs")
        .select("id,status,attempts,max_attempts,created_at,updated_at,last_error")
        .in("status", ["pending", "processing", "retry", "dead"])
        .order("created_at", { ascending: true })
        .limit(25),
    ]);

  for (const result of [
    incidentResult,
    taskResult,
    conversationResult,
    outboxResult,
    jobResult,
  ]) {
    if (result.error) throw result.error;
  }

  console.log(
    "HERA_STAGE0_RUNTIME_READINESS",
    JSON.stringify({
      branch: process.env.VERCEL_GIT_COMMIT_REF,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      provider,
      mode: operations.sendMode,
      liveConfirmationEnabled:
        process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE",
      readiness: readiness.level,
      cutoverEligible: readiness.cutoverEligible,
      reasons: readiness.reasons,
      queueAgeMs: {
        jobs: readiness.oldestJobAgeMs,
        outbox: readiness.oldestOutboxAgeMs,
      },
      counts: {
        activeJobs: snapshot.activeJobs,
        deadJobs: snapshot.deadJobs,
        activeOutbox: snapshot.activeOutbox,
        deadOutbox: snapshot.deadOutbox,
        openIncidents: snapshot.openIncidents,
        blackIncidents: snapshot.blackIncidents,
        openTasks: taskResult.count ?? null,
        managementConversations: conversationResult.count ?? null,
      },
      openIncidents: (incidentResult.data ?? []).map((incident) => ({
        incidentFingerprint: fingerprint(incident.id),
        sourceFingerprint: fingerprint(incident.source_message_id),
        category: incident.category,
        severity: incident.severity,
        status: incident.status,
        createdAt: incident.created_at,
        updatedAt: incident.updated_at,
        matchesKnownControlledComplaint:
          incident.source_message_id === KNOWN_CONTROLLED_COMPLAINT_MESSAGE_ID,
      })),
      activeOutbox: (outboxResult.data ?? []).map((item) => ({
        fingerprint: fingerprint(item.id),
        status: item.status,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
      activeJobs: (jobResult.data ?? []).map((job) => ({
        fingerprint: fingerprint(job.id),
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        hasError: Boolean(job.last_error),
      })),
      databaseMutationAttempted: false,
      whatsappProviderSendAttempted: false,
    }),
  );
}

await main();
