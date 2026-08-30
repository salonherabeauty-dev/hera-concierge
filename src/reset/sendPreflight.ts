import { createClient } from "@supabase/supabase-js";

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reset send preflight returned an invalid row");
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Reset send preflight is missing ${field}`);
  }
  return value;
}

export interface ResetSendPreflightReady {
  ok: true;
  state: "ready_to_send";
  sendId: string;
  draftRunId: string;
  turnId: string;
  conversationId: string;
  toWaId: string;
  phoneEnding: string;
  candidateHash: string;
  finalHash: string;
  messageText: string;
  editedByHuman: boolean;
}

export interface ResetSendPreflightBlocked {
  ok: false;
  code: string;
}

export class ResetSendPreflightRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-reset-send-preflight/1.0" },
      },
    });
  }

  async preflight(input: {
    actorUserId: string;
    sendId: string;
    expectedTurnId: string;
    expectedCandidateHash: string;
    expectedFinalHash: string;
    expectedPhoneEnding: string;
  }): Promise<ResetSendPreflightReady | ResetSendPreflightBlocked> {
    const { data, error } = await this.database.rpc(
      "ai_reset_preflight_human_send",
      {
        p_actor_user_id: input.actorUserId,
        p_send_id: input.sendId,
        p_expected_turn_id: input.expectedTurnId,
        p_expected_candidate_hash: input.expectedCandidateHash,
        p_expected_final_hash: input.expectedFinalHash,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) throw new Error(`reset send preflight: ${error.message}`);
    const result = row(data);
    if (result.ok !== true) {
      return {
        ok: false,
        code:
          typeof result.code === "string" && result.code
            ? result.code
            : "send_preflight_blocked",
      };
    }
    if (result.state !== "ready_to_send") {
      return { ok: false, code: "send_preflight_invalid_state" };
    }
    return {
      ok: true,
      state: "ready_to_send",
      sendId: required(result.sendId, "sendId"),
      draftRunId: required(result.draftRunId, "draftRunId"),
      turnId: required(result.turnId, "turnId"),
      conversationId: required(result.conversationId, "conversationId"),
      toWaId: required(result.toWaId, "toWaId"),
      phoneEnding: required(result.phoneEnding, "phoneEnding"),
      candidateHash: required(result.candidateHash, "candidateHash"),
      finalHash: required(result.finalHash, "finalHash"),
      messageText: required(result.messageText, "messageText"),
      editedByHuman: result.editedByHuman === true,
    };
  }
}
