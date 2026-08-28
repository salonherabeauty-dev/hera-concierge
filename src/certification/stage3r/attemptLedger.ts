import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GenerationAttemptFailure,
  GenerationAttemptLedger,
  GenerationAttemptOutcome,
} from "../../ai/generationAttempts.js";
import { accountStage3rAttempt } from "./cost.js";

interface JsonAttemptResult {
  attemptId?: unknown;
  priced?: unknown;
}

function resultObject(value: unknown): JsonAttemptResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stage3r_attempt_ledger_result_invalid");
  }
  return value as JsonAttemptResult;
}

function finishReason(value: string | null): string | null {
  return value?.trim().slice(0, 40) || null;
}

export function createStage3rAttemptLedger(input: {
  supabase: SupabaseClient;
  runId: string;
  queueId: string;
  lockToken: string;
  caseIndex: number;
}): GenerationAttemptLedger {
  async function finish(inputFinish: {
    attemptId: string;
    modelId: string;
    finishReason: string | null;
    usage: unknown;
    latencyMs: number;
    outcome: "completed" | "failed";
    errorCode: string | null;
  }): Promise<GenerationAttemptOutcome> {
    const accounting = accountStage3rAttempt({
      modelId: inputFinish.modelId,
      usage: inputFinish.usage,
      outcome: inputFinish.outcome,
    });
    const { data, error } = await input.supabase.rpc(
      "ai_stage3r_finish_model_attempt",
      {
        p_attempt_id: inputFinish.attemptId,
        p_queue_id: input.queueId,
        p_lock_token: input.lockToken,
        p_actual_model_id: inputFinish.modelId,
        p_finish_reason: finishReason(inputFinish.finishReason),
        p_usage: accounting.usageEvidence,
        p_cost_usd: accounting.costUsd,
        p_pricing_issue: accounting.issue,
        p_latency_ms: Math.max(0, Math.round(inputFinish.latencyMs)),
        p_outcome: inputFinish.outcome,
        p_error_code: inputFinish.errorCode,
      },
    );
    if (error) throw error;
    return { priced: resultObject(data).priced === true };
  }

  return {
    start: async (attempt) => {
      const { data, error } = await input.supabase.rpc(
        "ai_stage3r_begin_model_attempt",
        {
          p_run_id: input.runId,
          p_queue_id: input.queueId,
          p_lock_token: input.lockToken,
          p_case_index: input.caseIndex,
          p_stage: attempt.stage,
          p_configured_model_id: attempt.configuredModelId,
          p_call_id: attempt.callId,
          p_step_number: attempt.stepNumber,
        },
      );
      if (error) throw error;
      const attemptId = resultObject(data).attemptId;
      if (typeof attemptId !== "string" || !attemptId) {
        throw new Error("stage3r_attempt_ledger_id_missing");
      }
      return attemptId;
    },
    complete: async (attempt) =>
      finish({
        attemptId: attempt.attemptId,
        modelId: attempt.modelId,
        finishReason: attempt.finishReason,
        usage: attempt.usage,
        latencyMs: attempt.latencyMs,
        outcome: "completed",
        errorCode: null,
      }),
    fail: async (attempt: GenerationAttemptFailure) =>
      finish({
        attemptId: attempt.attemptId,
        modelId: attempt.modelId,
        finishReason: attempt.finishReason,
        usage: attempt.usage,
        latencyMs: attempt.latencyMs,
        outcome: "failed",
        errorCode: attempt.errorCode,
      }),
  };
}
