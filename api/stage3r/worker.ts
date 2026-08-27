import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildStage3rCorpus } from "../../src/certification/stage3r/corpus.js";
import { evaluateStage3rExecutionCase } from "../../src/certification/stage3r/executionEvaluator.js";
import { getStage3rJudgeConfigurations } from "../../src/certification/stage3r/judge.js";
import { getAiConfig, getDatabaseConfig, getOperationsConfig } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import type {
  Stage3rGoldCase,
  Stage3rSeedScenario,
} from "../../src/certification/stage3r/types.js";
import {
  STAGE3R_CERTIFICATION_VERSION,
  STAGE3R_CORPUS_VERSION,
} from "../../src/certification/stage3r/types.js";

const EMERGENCY_CALIBRATION_TOKEN_SHA256 =
  "7bebdcdced1d4ffeb6b2719a802f71c306a585a312bf058c683acf61dd534c08";
const EMERGENCY_CALIBRATION_EXPIRES_AT_MS = Date.parse(
  "2026-08-28T13:00:00Z",
);
const EMERGENCY_CALIBRATION_CASE_INDICES = [0, 6, 10, 20, 1910] as const;
const EMERGENCY_CALIBRATION_COST_CAP_USD = 10;

type ExecutionAccess = "environment" | "emergency_calibration";

async function loadCorpus() {
  const [scenarios, expanded, goldCases] = await Promise.all([
    readFile(new URL("../../evals/scenarios.json", import.meta.url), "utf8"),
    readFile(new URL("../../evals/scenarios-expanded.json", import.meta.url), "utf8"),
    readFile(new URL("../../evals/stage3r-gold-cases.json", import.meta.url), "utf8"),
  ]);
  return buildStage3rCorpus({
    seeds: [
      ...(JSON.parse(scenarios) as Stage3rSeedScenario[]),
      ...(JSON.parse(expanded) as Stage3rSeedScenario[]),
    ],
    goldCases: JSON.parse(goldCases) as Stage3rGoldCase[],
  });
}

async function loadCertificationMetadata(): Promise<{
  researchVersion: string;
  thresholds: Record<string, unknown>;
}> {
  const [researchSource, certification] = await Promise.all([
    readFile(
      new URL(
        "../../governance/stage3r-research-sources.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../governance/stage3r-certification.json", import.meta.url),
      "utf8",
    ),
  ]);
  const research = JSON.parse(researchSource) as { version?: unknown };
  const contract = JSON.parse(certification) as Record<string, unknown>;
  if (typeof research.version !== "string" || !research.version.trim()) {
    throw new Error("stage3r_research_version_missing");
  }
  return { researchVersion: research.version, thresholds: contract };
}

function calibrationIndices(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error("stage3r_calibration_requires_1_to_10_cases");
  }
  const result = value.map((item) => Number(item));
  if (
    result.some((item) => !Number.isInteger(item) || item < 0 || item > 2009) ||
    new Set(result).size !== result.length
  ) {
    throw new Error("stage3r_invalid_calibration_case_indices");
  }
  return result;
}

function calibrationCostCap(value: unknown): number {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost <= 0 || cost > 25) {
    throw new Error("stage3r_calibration_cost_cap_must_be_at_most_25_usd");
  }
  return Math.round(cost * 100) / 100;
}

function bearer(request: VercelRequest): string | null {
  const value = request.headers.authorization;
  if (!value || !value.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

function tokenMatchesHash(actual: string | null, expectedHash: string): boolean {
  if (!actual || actual.length < 64) return false;
  return tokenMatches(
    createHash("sha256").update(actual, "utf8").digest("hex"),
    expectedHash,
  );
}

function executionAccess(request: VercelRequest): ExecutionAccess | null {
  const actual = bearer(request);
  const executionToken = process.env.STAGE3R_EXECUTION_TOKEN?.trim();
  if (
    executionToken &&
    executionToken.length >= 32 &&
    tokenMatches(actual, executionToken)
  ) {
    return "environment";
  }
  if (
    Date.now() < EMERGENCY_CALIBRATION_EXPIRES_AT_MS &&
    tokenMatchesHash(actual, EMERGENCY_CALIBRATION_TOKEN_SHA256)
  ) {
    return "emergency_calibration";
  }
  return null;
}

function isExactEmergencyCalibration(
  caseIndices: readonly number[],
  maxEstimatedCostUsd: number,
): boolean {
  return maxEstimatedCostUsd === EMERGENCY_CALIBRATION_COST_CAP_USD &&
    caseIndices.length === EMERGENCY_CALIBRATION_CASE_INDICES.length &&
    caseIndices.every(
      (caseIndex, index) =>
        caseIndex === EMERGENCY_CALIBRATION_CASE_INDICES[index],
    );
}

function safeCode(error: unknown): string {
  if (!(error instanceof Error)) return "stage3r_unknown_failure";
  if (/^stage3r_[a-z0-9_:.-]+$/i.test(error.message)) {
    return error.message
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()
      .slice(0, 120);
  }
  if (/^fetch failed$/i.test(error.message.trim())) {
    return "stage3r_dependency_fetch_failed";
  }
  return error.name
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase()
    .slice(0, 80) || "stage3r_processing_failure";
}

function requirePreviewSafety(): void {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("stage3r_worker_requires_preview");
  }
  const allowedBranches = new Set([
    "feat/hera-ai-receptionist-foundation",
    "pilot/urgent-green-lane",
  ]);
  if (!allowedBranches.has(process.env.VERCEL_GIT_COMMIT_REF ?? "")) {
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

function immutableDeploymentIdentity(): {
  releaseCommit: string;
  deploymentUrl: string;
} {
  const releaseCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  const deploymentHost = process.env.VERCEL_URL?.trim() ?? "";
  if (
    !/^[0-9a-f]{40}$/i.test(releaseCommit) ||
    !/^[a-z0-9.-]+\.vercel\.app$/i.test(deploymentHost)
  ) {
    throw new Error("stage3r_immutable_deployment_identity_missing");
  }
  return { releaseCommit, deploymentUrl: `https://${deploymentHost}` };
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const access = executionAccess(request);
  if (!access) {
    response.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  let requestStage = "authorization_complete";
  try {
    requestStage = "preview_safety";
    requirePreviewSafety();
    requestStage = "request_parse";
    const body = request.body && typeof request.body === "object"
      ? request.body as Record<string, unknown>
      : {};
    const action = typeof body.action === "string" ? body.action.trim() : "step";
    requestStage = "database_config";
    const database = getDatabaseConfig();
    requestStage = "database_client";
    const supabase = createClient(database.url, database.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "X-Client-Info": "hera-stage3r-worker" } },
    });

    if (action === "configure_calibration") {
      requestStage = "calibration_scope_validation";
      const caseIndices = calibrationIndices(body.caseIndices);
      const maxEstimatedCostUsd = calibrationCostCap(
        body.maxEstimatedCostUsd,
      );
      if (
        access === "emergency_calibration" &&
        !isExactEmergencyCalibration(caseIndices, maxEstimatedCostUsd)
      ) {
        response.status(403).json({
          ok: false,
          error: "emergency_calibration_scope_mismatch",
        });
        return;
      }
      requestStage = "deployment_identity";
      const { releaseCommit, deploymentUrl } = immutableDeploymentIdentity();
      const databaseProjectRef = new URL(database.url).hostname.split(".")[0] ?? "";
      if (!/^[a-z0-9]{10,40}$/.test(databaseProjectRef)) {
        throw new Error("stage3r_database_project_identity_missing");
      }
      requestStage = "certification_metadata";
      const [metadata, ai] = await Promise.all([
        loadCertificationMetadata(),
        Promise.resolve(getAiConfig()),
      ]);
      const judgeConfigurations = getStage3rJudgeConfigurations();
      const calibrationVersion = [
        STAGE3R_CERTIFICATION_VERSION,
        "calibration",
        releaseCommit.slice(0, 12),
        Date.now().toString(36),
      ].join("-");
      requestStage = "start_calibration";
      const { data: started, error: startError } = await supabase.rpc(
        "ai_stage3r_start_calibration",
        {
          p_certification_version: calibrationVersion,
          p_release_commit: releaseCommit,
          p_deployment_url: deploymentUrl,
          p_database_project_ref: databaseProjectRef,
          p_research_source_version: metadata.researchVersion,
          p_corpus_version: STAGE3R_CORPUS_VERSION,
          p_generator_models: [
            ai.primaryModel,
            ai.verifierModel,
            ...ai.fallbackModels,
          ],
          p_judge_configurations: judgeConfigurations,
          p_thresholds: metadata.thresholds,
          p_case_indices: caseIndices,
          p_max_estimated_cost_usd: maxEstimatedCostUsd,
        },
      );
      if (startError) throw startError;
      const createdRunId = typeof started?.runId === "string"
        ? started.runId
        : "";
      if (!createdRunId) throw new Error("stage3r_run_identity_missing");
      response.status(201).json({
        ok: true,
        state: "calibration_configured",
        runId: createdRunId,
        configured: started.configuration,
        paidCallsStarted: false,
      });
      return;
    }

    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!runId) {
      response.status(400).json({ ok: false, error: "run_id_required" });
      return;
    }

    if (action === "status") {
      const { data: execution, error } = await supabase.rpc(
        "ai_stage3r_execution_health",
        { p_run_id: runId },
      );
      if (error) throw error;
      if (
        access === "emergency_calibration" &&
        execution?.runMode !== "calibration"
      ) {
        response.status(403).json({
          ok: false,
          error: "emergency_access_requires_calibration_run",
          runId,
        });
        return;
      }
      response.status(200).json({ ok: true, state: "status", runId, execution });
      return;
    }
    if (action !== "step") {
      response.status(400).json({ ok: false, error: "invalid_action" });
      return;
    }

    const { data: beforeClaim, error: beforeClaimError } = await supabase.rpc(
      "ai_stage3r_execution_health",
      { p_run_id: runId },
    );
    if (beforeClaimError) throw beforeClaimError;
    if (
      access === "emergency_calibration" &&
      beforeClaim?.runMode !== "calibration"
    ) {
      response.status(403).json({
        ok: false,
        error: "emergency_access_requires_calibration_run",
        runId,
      });
      return;
    }
    if (beforeClaim?.status !== "running") {
      response.status(200).json({
        ok: true,
        state: "run_not_active",
        runId,
        execution: beforeClaim,
      });
      return;
    }
    if (
      beforeClaim?.runMode === "full" &&
      process.env.STAGE3R_FULL_RUN_CONFIRMATION !==
        "APPROVED_FULL_2010_CASE_RUN"
    ) {
      response.status(403).json({
        ok: false,
        error: "full_run_confirmation_missing",
        runId,
      });
      return;
    }

    const currentIdentity = immutableDeploymentIdentity();
    const currentDatabaseProjectRef = new URL(database.url).hostname.split(".")[0] ?? "";
    const { data: runIdentity, error: runIdentityError } = await supabase
      .from("ai_stage3r_runs")
      .select(
        "certification_version,release_commit,deployment_url,database_project_ref,corpus_version",
      )
      .eq("id", runId)
      .maybeSingle();
    if (runIdentityError) throw runIdentityError;
    const certificationVersion = runIdentity?.certification_version ?? "";
    const certificationMatches =
      certificationVersion === STAGE3R_CERTIFICATION_VERSION ||
      certificationVersion.startsWith(`${STAGE3R_CERTIFICATION_VERSION}-calibration-`);
    if (
      !runIdentity ||
      !certificationMatches ||
      runIdentity.release_commit !== currentIdentity.releaseCommit ||
      runIdentity.deployment_url !== currentIdentity.deploymentUrl ||
      runIdentity.database_project_ref !== currentDatabaseProjectRef ||
      runIdentity.corpus_version !== STAGE3R_CORPUS_VERSION
    ) {
      throw new Error("stage3r_run_deployment_identity_mismatch");
    }
    if (beforeClaim?.costCapReached) {
      response.status(200).json({
        ok: true,
        state: "cost_cap_reached",
        runId,
        execution: beforeClaim,
      });
      return;
    }

    const { data: claimed, error: claimError } = await supabase.rpc(
      "ai_stage3r_claim_case",
      { p_run_id: runId, p_lock_minutes: 30 },
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
      response.status(200).json({
        ok: true,
        state: execution?.unpricedCases > 0
          ? "cost_instrumentation_blocked"
          : execution?.costCapReached
            ? "cost_cap_reached"
            : "at_capacity_or_waiting",
        runId,
        execution,
      });
      return;
    }

    const caseIndex = Number(claim.case_index);
    const corpus = await loadCorpus();
    const caseItem = corpus[caseIndex];
    if (!caseItem) throw new Error("stage3r_case_index_out_of_range");

    try {
      const result = await evaluateStage3rExecutionCase(caseItem, getAiConfig());
      const { error: commitError } = await supabase.rpc(
        "ai_stage3r_commit_case",
        {
          p_queue_id: claim.queue_id,
          p_lock_token: claim.lock_token,
          p_run_id: runId,
          p_case_index: caseIndex,
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
          p_model_usage: result.modelUsage,
          p_cost_usd: result.costUsd,
          p_latency_ms: result.latencyMs,
          p_model_call_count: result.modelCallCount,
        },
      );
      if (commitError) throw commitError;
      response.status(200).json({
        ok: true,
        state: "case_completed",
        runId,
        caseIndex,
        caseKey: result.caseItem.id,
        verdict: result.verdict,
        meanOverall: Number(result.meanOverall.toFixed(4)),
        modelCallCount: result.modelCallCount,
        estimatedCostUsd: result.costUsd,
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
    const errorCode = safeCode(error);
    logOperationalEvent("error", "stage3r_worker_request_failed", {
      errorCode,
      requestStage,
      ...safeErrorFields(error),
    });
    response.status(
      errorCode === "stage3r_dependency_fetch_failed" ? 503 : 500,
    ).json({ ok: false, error: errorCode, stage: requestStage });
  }
}
