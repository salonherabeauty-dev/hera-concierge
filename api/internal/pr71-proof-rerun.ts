import { createHash, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../../src/config.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../../src/worker.js";

const EXPECTED_TOKEN_HASH =
  "b8e9dff064651c1863a0c68282db5063696e046a705971ef2b82c50cd87ae66a";
const EXPIRES_AT = Date.parse("2026-08-30T02:30:00.000Z");
const EXPECTED_BRANCH = "diagnostic/pr71-rerun-proof";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function validToken(value: string): boolean {
  const actual = Buffer.from(
    createHash("sha256").update(value).digest("hex"),
    "utf8",
  );
  const expected = Buffer.from(EXPECTED_TOKEN_HASH, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function secureHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureHeaders(response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (
    process.env.VERCEL_ENV !== "preview" ||
    process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH ||
    process.env.WHATSAPP_SEND_MODE !== "shadow" ||
    process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE"
  ) {
    return response.status(403).json({ error: "Preview boundary failed" });
  }
  if (Date.now() >= EXPIRES_AT) {
    return response.status(410).json({ error: "Diagnostic expired" });
  }

  const token = first(request.query.token);
  const jobId = first(request.query.job);
  const sourceMessageId = first(request.query.source);
  if (!validToken(token) || !UUID.test(jobId) || !UUID.test(sourceMessageId)) {
    return response.status(403).json({ error: "Invalid diagnostic request" });
  }

  const databaseConfig = getDatabaseConfig();
  const database = createClient(
    databaseConfig.url,
    databaseConfig.serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );

  const { data: job, error: jobError } = await database
    .from("ai_jobs")
    .select("id,source_message_id,status,attempts,max_attempts,payload")
    .eq("id", jobId)
    .eq("source_message_id", sourceMessageId)
    .maybeSingle();
  if (jobError || !job) {
    return response.status(404).json({ error: "Target job not found" });
  }

  const { data: message, error: messageError } = await database
    .from("ai_messages")
    .select("id,conversation_id,direction,kind,provider_timestamp,created_at")
    .eq("id", sourceMessageId)
    .maybeSingle();
  if (
    messageError ||
    !message ||
    message.direction !== "inbound" ||
    ["reaction", "system"].includes(String(message.kind))
  ) {
    return response.status(409).json({ error: "Target is not reply-worthy" });
  }

  const { data: latestInbound, error: latestError } = await database
    .from("ai_messages")
    .select("id")
    .eq("conversation_id", message.conversation_id)
    .eq("direction", "inbound")
    .order("provider_timestamp", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError || latestInbound?.id !== sourceMessageId) {
    return response.status(409).json({ error: "Target is not latest inbound" });
  }

  const sourceAt = Date.parse(
    String(message.provider_timestamp ?? message.created_at ?? ""),
  );
  if (!Number.isFinite(sourceAt) || Date.now() - sourceAt >= 24 * 60 * 60 * 1000) {
    return response.status(409).json({ error: "Reply window closed" });
  }

  const { data: existingCandidate } = await database
    .from("ai_outbox")
    .select("id,status,provider_message_id")
    .eq("source_message_id", sourceMessageId)
    .eq("target_type", "client")
    .in("status", ["pending", "processing", "shadowed"])
    .is("provider_message_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingCandidate) {
    return response.status(200).json({
      ok: true,
      state: "candidate_already_exists",
      jobId,
      sourceMessageId,
      candidateId: existingCandidate.id,
      candidateStatus: existingCandidate.status,
      providerMessageId: null,
    });
  }

  const { data: priorRun } = await database
    .from("ai_audit_log")
    .select("id")
    .eq("event_type", "pr71_shadow_proof_rerun_requested")
    .eq("target_type", "job")
    .eq("target_id", jobId)
    .limit(1)
    .maybeSingle();
  if (priorRun) {
    return response.status(409).json({ error: "Diagnostic already requested" });
  }

  const runKey = `pr71-proof:${jobId}`;
  const now = new Date().toISOString();
  const { error: resetError } = await database
    .from("ai_jobs")
    .update({
      status: "pending",
      attempts: 0,
      max_attempts: 1,
      available_at: now,
      locked_at: null,
      locked_by: null,
      last_error: null,
      completed_at: null,
      updated_at: now,
      payload: {
        ...objectValue(job.payload),
        diagnosticRun: runKey,
        humanReviewOnly: true,
        automaticDeliveryAllowed: false,
      },
    })
    .eq("id", jobId)
    .eq("source_message_id", sourceMessageId);
  if (resetError) {
    return response.status(500).json({ error: "Failed to reset target job" });
  }

  await database.from("ai_audit_log").insert({
    actor_type: "management",
    actor_id: "pr71-diagnostic",
    event_type: "pr71_shadow_proof_rerun_requested",
    target_type: "job",
    target_id: jobId,
    details: {
      sourceMessageId,
      branch: EXPECTED_BRANCH,
      automaticDeliveryAllowed: false,
      maxAttempts: 1,
    },
  });

  const runtime = createProductionRuntime();
  if (runtime.sendMode !== "shadow") {
    return response.status(403).json({ error: "Runtime is not shadow locked" });
  }

  waitUntil(
    drainReceptionistForJobs(runtime, [jobId], 1)
      .then(async (summary) => {
        await database.from("ai_audit_log").insert({
          actor_type: "system",
          actor_id: "pr71-diagnostic",
          event_type: "pr71_shadow_proof_rerun_completed",
          target_type: "job",
          target_id: jobId,
          details: {
            sourceMessageId,
            summary,
            automaticDeliveryAllowed: false,
          },
        });
      })
      .catch(async () => {
        await database.from("ai_audit_log").insert({
          actor_type: "system",
          actor_id: "pr71-diagnostic",
          event_type: "pr71_shadow_proof_rerun_failed",
          target_type: "job",
          target_id: jobId,
          details: {
            sourceMessageId,
            automaticDeliveryAllowed: false,
          },
        });
      }),
  );

  return response.status(202).json({
    ok: true,
    state: "shadow_rerun_started",
    jobId,
    sourceMessageId,
    maxAttempts: 1,
    automaticDeliveryAllowed: false,
  });
}
