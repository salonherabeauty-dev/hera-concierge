import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createStage3rAttemptLedger } from "../src/certification/stage3r/attemptLedger.js";
import { STAGE3R_FAILED_ATTEMPT_RESERVE_USD } from "../src/certification/stage3r/cost.js";

test("failed missing-usage evidence reaches the ledger as a priced reserve", async () => {
  const calls: Array<{
    name: string;
    parameters: Record<string, unknown>;
  }> = [];
  const supabase = {
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return {
        data: {
          attemptId: parameters.p_attempt_id ?? "attempt-1",
          priced:
            parameters.p_usage !== null && parameters.p_cost_usd !== null,
        },
        error: null,
      };
    },
  } as unknown as SupabaseClient;
  const ledger = createStage3rAttemptLedger({
    supabase,
    runId: "run-1",
    queueId: "queue-1",
    lockToken: "lock-1",
    caseIndex: 10,
  });

  const outcome = await ledger.fail({
    attemptId: "attempt-1",
    configuredModelId: "openai/gpt-5.6-terra",
    modelId: "openai/gpt-5.6-terra",
    finishReason: null,
    usage: null,
    latencyMs: 5,
    errorCode: "gatewayresponseerror",
  });

  assert.deepEqual(outcome, { priced: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "ai_stage3r_finish_model_attempt");
  assert.equal(
    calls[0]?.parameters.p_cost_usd,
    STAGE3R_FAILED_ATTEMPT_RESERVE_USD,
  );
  assert.equal(
    calls[0]?.parameters.p_pricing_issue,
    "failed_attempt_reserve:openai/gpt-5.6-terra",
  );
  assert.deepEqual(calls[0]?.parameters.p_usage, {
    accountingMode: "failed_attempt_reserve",
    providerUsageAvailable: false,
    reportedUsage: null,
    reserveUsd: STAGE3R_FAILED_ATTEMPT_RESERVE_USD,
  });
});

test("completed missing-usage evidence remains blocked as unpriced", async () => {
  const supabase = {
    rpc: async (_name: string, parameters: Record<string, unknown>) => ({
      data: {
        attemptId: parameters.p_attempt_id ?? "attempt-1",
        priced: parameters.p_usage !== null && parameters.p_cost_usd !== null,
      },
      error: null,
    }),
  } as unknown as SupabaseClient;
  const ledger = createStage3rAttemptLedger({
    supabase,
    runId: "run-1",
    queueId: "queue-1",
    lockToken: "lock-1",
    caseIndex: 10,
  });

  const outcome = await ledger.complete({
    attemptId: "attempt-1",
    configuredModelId: "openai/gpt-5.6-terra",
    modelId: "openai/gpt-5.6-terra",
    finishReason: "stop",
    rawFinishReason: null,
    usage: null,
    latencyMs: 5,
  });

  assert.deepEqual(outcome, { priced: false });
});
