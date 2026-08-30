import { createClient } from "@supabase/supabase-js";
import type { JsonValue } from "../types.js";

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reset claim-failure persistence returned an invalid row");
  }
  return value as Record<string, unknown>;
}

export interface ResetClaimFailureInput {
  draftRunId: string;
  turnId: string;
  failureCode: string;
  failureMessage: string;
  modelCalls: number;
  modelMetadata: JsonValue;
}

export class ResetClaimFailureRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-reset-claim-failure/1.0" },
      },
    });
  }

  async markClaimFailed(
    input: ResetClaimFailureInput,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.database.rpc(
      "ai_reset_mark_claim_failed",
      {
        p_draft_run_id: input.draftRunId,
        p_turn_id: input.turnId,
        p_failure_code: input.failureCode,
        p_failure_message: input.failureMessage,
        p_model_calls: input.modelCalls,
        p_model_metadata: input.modelMetadata,
      },
    );
    if (error) throw new Error(`reset mark claim failed: ${error.message}`);
    const result = row(data);
    if (result.ok !== true) {
      throw new Error(
        `reset_mark_claim_failed:${
          typeof result.state === "string" ? result.state : "blocked"
        }`,
      );
    }
    return result;
  }
}
