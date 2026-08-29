import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../config.js";

export interface ReceptionistDraftRequestResult {
  ok: boolean;
  state: string;
  code: string | null;
  candidateId: string | null;
  conversationId: string | null;
  sourceMessageId: string | null;
  jobId: string | null;
  jobStatus: string | null;
  phoneEnding: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid receptionist draft request result");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export class ReceptionistDraftRepository {
  private readonly database;

  constructor() {
    const config = getDatabaseConfig();
    this.database = createClient(config.url, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          "X-Client-Info": "hera-receptionist-draft/1.0",
        },
      },
    });
  }

  async requestDraft(input: {
    actorUserId: string;
    conversationId: string;
    sourceMessageId: string;
    expectedPhoneEnding: string;
  }): Promise<ReceptionistDraftRequestResult> {
    const { data, error } = await this.database.rpc(
      "ai_cc_request_receptionist_draft",
      {
        p_actor_user_id: input.actorUserId,
        p_conversation_id: input.conversationId,
        p_source_message_id: input.sourceMessageId,
        p_expected_phone_ending: input.expectedPhoneEnding,
      },
    );
    if (error) throw new Error(`request receptionist draft: ${error.message}`);
    const result = record(data);
    return {
      ok: result.ok === true,
      state: optionalString(result.state) ?? "blocked",
      code: optionalString(result.code),
      candidateId: optionalString(result.candidateId),
      conversationId: optionalString(result.conversationId),
      sourceMessageId: optionalString(result.sourceMessageId),
      jobId: optionalString(result.jobId),
      jobStatus: optionalString(result.jobStatus),
      phoneEnding: optionalString(result.phoneEnding),
    };
  }
}
