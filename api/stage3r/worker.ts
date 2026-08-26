import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildStage3rCorpus } from "../../src/certification/stage3r/corpus.js";
import { evaluateStage3rExecutionCase } from "../../src/certification/stage3r/executionEvaluator.js";
import { getAiConfig, getDatabaseConfig, getOperationsConfig } from "../../src/config.js";

export const maxDuration = 500;

function bearer(request: VercelRequest): string | null {
  const value = request.headers.authorization;
  if (!value || !value.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
}

function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "stage3r_unknown_failure";
  return error.name
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .slice(0, 80) || "stage3r_processing_failure";
}

function requirePreviewSafety(): void {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("stage3r_worker_requires_preview");
  }
  if (process.env.VERCEL_GIT_COMMIT_REF !== "feat/hera-ai-receptionist-foundation") {
    throw new Error("stage3r_worker_requires_authoritative_staging_branch");
  }
  const operations = getOperationsConfig();
  if (operations.sendMode !== "shadow") {
    throw new Error("stage3r_worker_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
    throw new Error("stage3r_worker_refuses_live_confirmation");
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || bearer(request) !== cronSecret) {
    response.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    requirePreviewSafety();
    const database = getDatabaseConfig();
    const supabase = createClient(database.url, database.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "hera-stage3r-worker" } },
    });

    let runId =
      typeof request.query.runId === "string" ? request.query.runId.trim() : "";
    if (!runId) {
      const { data, error } = await supabase
        .from("ai_stage3r_runs")
        .select("id")
        .eq("status", "running")
        .gt("requested_case_count", 0)
        .order("started_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      runId = data?.id ?? "";
    }
    if (!runId) {
      response.status(200).json({ ok: true, state: "idle" });
      return;
    }

    const { data: claimed, error: claimError } = await supabase.rpc(
      "ai_stage3r_claim_case",
      { p_run_id: runId, p_lock_minutes: 12 },
    );
    if (claimError) throw claimError;
    const claim = Array.isArray(claimed) ? claimed[0] : null;
    if (!claim) {
      const { data: execution, error: healthError } = await supabase.rpc(
        "ai_stage3r_execution_health",
        { p_run_id: runId },
      );
      if (healthError) throw healthError;
      if (execution?.queueComplete) {
        const { data: finalized, error: finalizeError } = await supabase.rpc(
          "ai_stage3r_finalize_execution",
          { p_run_id: runId },
        );
        if (finalizeError) throw finalizeError;
        response.status(200).json({ ok: true, state: "finalized", runId, finalized });
        return;
      }
      response.status(200).json({ ok: true, state: "at_capacity_or_waiting", runId, execution });
      return;
    }

    const caseIndex = Number(claim.case_index);
    const corpus = buildStage3rCorpus();
    const caseItem = corpus[caseIndex];
    if (!caseItem) throw new Error("stage3r_case_index_out_of_range");

    try {
      const result = await evaluateStage3rExecutionCase(caseItem, getAiConfig());
      const { data: caseId, error: recordError } = await supabase.rpc(
        "ai_stage3r_record_case",
        {
          p_run_id: runId,
          p_case_key: result.caseItem.id,
          p_family: result.caseItem.family,
          p_case_type: result.caseItem.caseType,
          p_language: result.caseItem.language,
          p_minimum_risk: result.caseItem.minimumRisk,
          p_high_consequence: result.caseItem.highConsequence,
          p_multi_intent: result.caseItem.multiIntent,
          p_adversarial: result.caseItem.adversarial,
          p_input_text: result.caseItem.message,
          p_exact_final_response: result.exactFinalResponse,
          p_response_hash: result.responseHash,
          p_generator_model_id: result.generatorModelId,
          p_first_verifier_model_id: result.firstVerifierModelId,
          p_final_verifier_model_id: result.finalVerifierModelId,
          p_deterministic_delivery_eligible: result.deterministicDeliveryEligible,
          p_grounded_hera_facts: result.groundedHeraFacts,
          p_judge_results: result.judgeResults,
          p_dimension_means: result.dimensionMeans,
          p_dimension_ranges: result.dimensionRanges,
          p_mean_overall: result.meanOverall,
          p_candidate_preference_rate: result.candidatePreferenceRate,
          p_position_consistent: result.positionConsistent,
          p_repeated_judge_consistent: result.repeatedJudgeConsistent,
          p_verdict: result.verdict,
          p_reasons: result.reasons,
          p_critical_flags: result.criticalFlags,
          p_provider_send_count: result.providerSendCount,
          p_duplicate_final_candidates: result.duplicateFinalCandidates,
          p_lost: false,
        },
      );
      if (recordError) throw recordError;
      const { error: usageError } = await supabase
        .from("ai_stage3r_case_results")
        .update({
          model_usage: result.modelUsage,
          cost_usd: result.costUsd,
          latency_ms: result.latencyMs,
          model_call_count: result.modelCallCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", caseId);
      if (usageError) throw usageError;
      const { error: completeError } = await supabase.rpc(
        "ai_stage3r_complete_case",
        { p_queue_id: claim.queue_id, p_lock_token: claim.lock_token },
      );
      if (completeError) throw completeError;
      response.status(200).json({
        ok: true,
        state: "case_completed",
        runId,
        caseIndex,
        caseKey: result.caseItem.id,
        verdict: result.verdict,
        meanOverall: Number(result.meanOverall.toFixed(4)),
        modelCallCount: result.modelCallCount,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      });
    } catch (error) {
      const errorCode = safeCode(error);
      const { data: retryState } = await supabase.rpc("ai_stage3r_retry_case", {
        p_queue_id: claim.queue_id,
        p_lock_token: claim.lock_token,
        p_error_code: errorCode,
      });
      response.status(200).json({
        ok: false,
        state: retryState ?? "retry",
        runId,
        caseIndex,
        errorCode,
      });
    }
  } catch (error) {
    response.status(500).json({ ok: false, error: safeCode(error) });
  }
}
