import { createClient } from "@supabase/supabase-js";
import type { D360HumanEcho } from "../whatsapp/d360WebhookPayload.js";

export type OutboundAuthorizationDisposition =
  | "authorized"
  | "shadowed"
  | "dead";

export interface HumanEchoIngestResult {
  inserted: boolean;
  messageId: string;
  conversationId: string;
  contactId: string;
  takeoverUntil: string;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Database returned an invalid coexistence row");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Database row is missing ${field}`);
  }
  return value;
}

export class D360CoexistenceStore {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-d360-coexistence/1.0" } },
    });
  }

  async ingestHumanEcho(
    echo: D360HumanEcho,
    takeoverUntil: string,
  ): Promise<HumanEchoIngestResult> {
    const { data, error } = await this.database.rpc(
      "ai_ingest_whatsapp_human_echo",
      {
        p_provider_message_id: echo.providerMessageId,
        p_wa_id: echo.toWaId,
        p_phone_number_id: echo.phoneNumberId ?? null,
        p_business_account_id: echo.businessAccountId ?? null,
        p_kind: echo.kind,
        p_text: echo.text,
        p_media: echo.media ?? null,
        p_context_message_id: echo.contextMessageId ?? null,
        p_provider_timestamp: echo.providerTimestamp,
        p_takeover_until: takeoverUntil,
        p_raw: echo.raw,
      },
    );
    if (error) throw new Error(`ingest 360dialog human echo: ${error.message}`);
    const value = row(data);
    return {
      inserted: value.inserted === true,
      messageId: requiredString(value.messageId, "messageId"),
      conversationId: requiredString(value.conversationId, "conversationId"),
      contactId: requiredString(value.contactId, "contactId"),
      takeoverUntil: requiredString(value.takeoverUntil, "takeoverUntil"),
    };
  }

  async authorizeOutbound(
    outboxId: string,
  ): Promise<OutboundAuthorizationDisposition> {
    const { data, error } = await this.database.rpc(
      "ai_authorize_whatsapp_outbox_send",
      { p_outbox_id: outboxId },
    );
    if (error) throw new Error(`authorize WhatsApp outbox send: ${error.message}`);
    if (data === "authorized" || data === "shadowed" || data === "dead") {
      return data;
    }
    throw new Error("authorize WhatsApp outbox send: invalid disposition");
  }

  async authorizeInternalPilot(
    outboxId: string,
    pilot: {
      pilotId: string;
      allowlistedWaIds: readonly string[];
      maxSendAttempts: number;
    },
  ): Promise<OutboundAuthorizationDisposition> {
    const { data, error } = await this.database.rpc(
      "ai_authorize_internal_pilot_outbox_send",
      {
        p_outbox_id: outboxId,
        p_pilot_id: pilot.pilotId,
        p_allowlisted_wa_ids: pilot.allowlistedWaIds,
        p_max_send_attempts: pilot.maxSendAttempts,
      },
    );
    if (error) {
      throw new Error(`authorize internal pilot send: ${error.message}`);
    }
    if (data === "authorized" || data === "shadowed" || data === "dead") {
      return data;
    }
    throw new Error("authorize internal pilot send: invalid disposition");
  }
}
