import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../src/config.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../src/worker.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const EXPIRES_AT = Date.parse("2026-08-30T08:00:00.000Z");
const PROOF_VERSION = "pr73-staging-proof-1.0.0";
const TARGETS = [
  {
    key: "appointment-change",
    jobHash:
      "98acef1dad358678154466bf0fdfe96de52bc546764f639b4808a55df02e1120",
    sourceHash:
      "39bf5fecc90224150edcefdc6ec5c7942dd3d6f82729a74cd06275086ac41736",
  },
  {
    key: "consolidated-legal",
    jobHash:
      "4c96105ad0e985e27eb5b1bebbfb309445264ce5e17a3ca793ce0c1b8d9b1f34",
    sourceHash:
      "f08d2db3b6504b949be630439a6300cd9dae07656f2382d8e463d0001c38008b",
  },
] as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bodyText(value: unknown): string {
  const body = objectValue(value);
  return typeof body.text === "string" ? body.text.trim() : "";
}

function runsHere(): boolean {
  return (
    process.env.VERCEL_ENV === "preview" &&
    process.env.VERCEL_GIT_COMMIT_REF === EXPECTED_BRANCH &&
    process.env.WHATSAPP_SEND_MODE === "shadow" &&
    process.env.WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE" &&
    Date.now() < EXPIRES_AT
  );
}

async function main(): Promise<void> {
  if (!runsHere()) {
    console.log(
      JSON.stringify({
        proof: PROOF_VERSION,
        state: "skipped_outside_expiring_shadow_staging_preview",
      }),
    );
    return;
  }

  const credentials = getDatabaseConfig();
  const database = createClient(credentials.url, credentials.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "X-Client-Info": PROOF_VERSION } },
  });
  const runtime = createProductionRuntime();
  if (runtime.sendMode !== "shadow") {
    throw new Error("pr73_proof_runtime_not_shadow_locked");
  }

  // This proof may create review candidates, but it cannot claim an outbox
  // item or contact any WhatsApp provider.
  const proofRepository = runtime.repository as typeof runtime.repository & {
    claimOutbox: (...args: unknown[]) => Promise<never[]>;
  };
  proofRepository.claimOutbox = async () => [];

  const { data: jobs, error: jobsError } = await database
    .from("ai_jobs")
    .select("id,source_message_id,payload,created_at")
    .gte("created_at", "2026-08-29T00:00:00.000Z")
    .order("created_at", { ascending: false })
    .limit(500);
  if (jobsError) throw new Error("pr73_proof_jobs_unavailable");

  const failures: string[] = [];
  const results: Record<string, unknown>[] = [];

  for (const target of TARGETS) {
    const job = (jobs ?? []).find(
      (candidate) =>
        digest(String(candidate.id)) === target.jobHash &&
        digest(String(candidate.source_message_id)) === target.sourceHash,
    );
    if (!job) {
      failures.push(`${target.key}:target_not_found`);
      continue;
    }

    const jobId = String(job.id);
    const sourceMessageId = String(job.source_message_id);
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
      failures.push(`${target.key}:source_not_reply_worthy`);
      continue;
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
    const sourceAt = Date.parse(
      String(message.provider_timestamp ?? message.created_at ?? ""),
    );
    if (latestError || latestInbound?.id !== sourceMessageId) {
      failures.push(`${target.key}:source_not_latest`);
      continue;
    }
    if (
      !Number.isFinite(sourceAt) ||
      Date.now() - sourceAt >= 24 * 60 * 60 * 1000
    ) {
      failures.push(`${target.key}:reply_window_closed`);
      continue;
    }

    const { data: existingCandidate } = await database
      .from("ai_outbox")
      .select("id,status,provider_message_id,body")
      .eq("source_message_id", sourceMessageId)
      .eq("target_type", "client")
      .in("status", ["pending", "processing", "shadowed"])
      .is("provider_message_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let startedAt: string | null = null;
    if (!existingCandidate) {
      const { data: prior } = await database
        .from("ai_audit_log")
        .select("id")
        .eq("event_type", "pr73_staging_proof_requested")
        .eq("target_type", "diagnostic_target")
        .eq("target_id", target.key)
        .limit(1)
        .maybeSingle();
      if (prior) {
        failures.push(`${target.key}:one_attempt_already_consumed`);
        continue;
      }

      startedAt = new Date().toISOString();
      const { error: resetError } = await database
        .from("ai_jobs")
        .update({
          status: "pending",
          attempts: 0,
          max_attempts: 1,
          available_at: startedAt,
          locked_at: null,
          locked_by: null,
          last_error: null,
          completed_at: null,
          updated_at: startedAt,
          payload: {
            ...objectValue(job.payload),
            proofRun: PROOF_VERSION,
            humanReviewOnly: true,
            automaticDeliveryAllowed: false,
          },
        })
        .eq("id", jobId)
        .eq("source_message_id", sourceMessageId);
      if (resetError) {
        failures.push(`${target.key}:job_reset_failed`);
        continue;
      }

      const { error: auditError } = await database.from("ai_audit_log").insert({
        actor_type: "management",
        actor_id: PROOF_VERSION,
        event_type: "pr73_staging_proof_requested",
        target_type: "diagnostic_target",
        target_id: target.key,
        details: {
          proofVersion: PROOF_VERSION,
          maxAttempts: 1,
          automaticDeliveryAllowed: false,
        },
      });
      if (auditError) {
        failures.push(`${target.key}:audit_failed`);
        continue;
      }

      const summary = await drainReceptionistForJobs(runtime, [jobId], 1);
      console.log(
        JSON.stringify({
          proof: PROOF_VERSION,
          target: target.key,
          state: "drain_completed",
          summary,
        }),
      );
    }

    const { data: finalJob, error: finalJobError } = await database
      .from("ai_jobs")
      .select("status,attempts,last_error,completed_at")
      .eq("id", jobId)
      .maybeSingle();
    const { data: candidate, error: candidateError } = await database
      .from("ai_outbox")
      .select("id,status,provider_message_id,body")
      .eq("source_message_id", sourceMessageId)
      .eq("target_type", "client")
      .in("status", ["pending", "processing", "shadowed"])
      .is("provider_message_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let policyQuery = database
      .from("ai_decisions")
      .select("model_id,output,created_at")
      .eq("source_message_id", sourceMessageId)
      .eq("stage", "policy");
    if (startedAt) policyQuery = policyQuery.gte("created_at", startedAt);
    const { data: policyDecision, error: policyError } = await policyQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const policyOutput = objectValue(policyDecision?.output);
    const finalVerification = objectValue(policyOutput.finalVerification);
    const finalQuality = objectValue(policyOutput.finalQuality);
    const text = bodyText(candidate?.body);
    const passed = Boolean(
      !finalJobError &&
        !candidateError &&
        !policyError &&
        finalJob?.status === "completed" &&
        finalJob?.last_error == null &&
        candidate &&
        candidate.provider_message_id == null &&
        ["pending", "shadowed"].includes(String(candidate.status)) &&
        text.length > 0 &&
        policyOutput.deliveryEligible === true &&
        finalVerification.approved === true &&
        finalQuality.passed === true &&
        policyDecision?.model_id === "openai/gpt-5.6-sol"
    );
    const result = {
      target: target.key,
      passed,
      jobStatus: finalJob?.status ?? null,
      attempts: finalJob?.attempts ?? null,
      candidateStatus: candidate?.status ?? null,
      providerMessageId: candidate?.provider_message_id ?? null,
      draftLength: text.length,
      deliveryEligible: policyOutput.deliveryEligible === true,
      finalVerificationApproved: finalVerification.approved === true,
      finalQualityPassed: finalQuality.passed === true,
      modelId: policyDecision?.model_id ?? null,
    };
    results.push(result);

    await database.from("ai_audit_log").insert({
      actor_type: "system",
      actor_id: PROOF_VERSION,
      event_type: passed
        ? "pr73_staging_proof_passed"
        : "pr73_staging_proof_blocked",
      target_type: "diagnostic_target",
      target_id: target.key,
      details: { ...result, automaticDeliveryAllowed: false },
    });
    if (!passed) failures.push(`${target.key}:draft_proof_failed`);
  }

  console.log(
    JSON.stringify({
      proof: PROOF_VERSION,
      state: failures.length === 0 ? "PASS" : "BLOCKED",
      results,
      failures,
    }),
  );
  if (failures.length > 0) {
    throw new Error(`pr73_staging_proof_blocked:${failures.join(",")}`);
  }
}

await main();
