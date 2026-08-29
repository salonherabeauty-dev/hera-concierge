import { createClient } from "@supabase/supabase-js";
import { HERA_INTERNAL_PILOT_BRANCH } from "../config.js";
import type { InboundMessage, IngestResult } from "../types.js";

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Human-review ingest returned an invalid result");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Human-review ingest is missing ${field}`);
  }
  return value;
}

export function usePreviewHumanReviewIngest(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === HERA_INTERNAL_PILOT_BRANCH &&
    env.WHATSAPP_SEND_MODE === "shadow"
  );
}

export async function ingestPreviewHumanReviewMessage(input: {
  databaseUrl: string;
  serviceRoleKey: string;
  message: InboundMessage;
}): Promise<IngestResult> {
  const database = createClient(input.databaseUrl, input.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        "X-Client-Info": "hera-preview-human-review-ingest/1.0",
      },
    },
  });

  const message = input.message;
  const { data, error } = await database.rpc(
    "ai_ingest_whatsapp_message_human_review",
    {
      p_provider_message_id: message.providerMessageId,
      p_wa_id: message.fromWaId,
      p_profile_name: message.profileName ?? null,
      p_phone_number_id: message.phoneNumberId ?? null,
      p_business_account_id: message.businessAccountId ?? null,
      p_kind: message.kind,
      p_text: message.text,
      p_media: message.media ?? null,
      p_context_message_id: message.contextMessageId ?? null,
      p_provider_timestamp: message.providerTimestamp,
      p_raw: message.raw,
    },
  );
  if (error) {
    throw new Error(`ingest human-review WhatsApp message: ${error.message}`);
  }

  const result = row(data);
  return {
    inserted: result.inserted === true,
    messageId: requiredString(result.messageId, "messageId"),
    conversationId: requiredString(result.conversationId, "conversationId"),
    contactId: requiredString(result.contactId, "contactId"),
    jobId: typeof result.jobId === "string" && result.jobId ? result.jobId : null,
  };
}
