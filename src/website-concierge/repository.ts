import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { JsonValue } from "../types.js";
import type {
  WebsiteConciergeHistoryMessage,
  WebsiteConciergeOutlet,
  WebsiteConciergeResult,
} from "./types.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_CREATE_ATTEMPTS = 2;
const SESSION_CREATE_RETRY_DELAY_MS = 450;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Website concierge database returned an invalid row.");
  }
  return value as Record<string, unknown>;
}

function databaseFailure(
  operation: string,
  error: { message: string; code?: string; details?: string; hint?: string },
): Error & { code?: string } {
  const failure = new Error(`${operation}: ${error.message}`) as Error & {
    code?: string;
  };
  failure.name = "WebsiteConciergeDatabaseError";
  if (error.code) failure.code = error.code;
  return failure;
}

function transientSchemaFailure(error: {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}): boolean {
  const text = `${error.message} ${error.details ?? ""} ${error.hint ?? ""}`;
  return (
    error.code === "PGRST200" ||
    error.code === "PGRST202" ||
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /schema cache|relation .* does not exist|could not find the table/i.test(text)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface WebsiteConciergeSessionCredential {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export class WebsiteConciergeRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-website-concierge/1.0" },
      },
    });
  }

  async createSession(): Promise<WebsiteConciergeSessionCredential> {
    const sessionId = randomUUID();
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    for (let attempt = 1; attempt <= SESSION_CREATE_ATTEMPTS; attempt += 1) {
      const { error } = await this.database
        .from("ai_website_concierge_sessions_v1")
        .insert({
          id: sessionId,
          token_hash: tokenHash(sessionToken),
          status: "active",
          outlet_preference: "unspecified",
          expires_at: expiresAt,
        });
      if (!error) return { sessionId, sessionToken, expiresAt };
      if (
        attempt < SESSION_CREATE_ATTEMPTS &&
        transientSchemaFailure(error)
      ) {
        await delay(SESSION_CREATE_RETRY_DELAY_MS);
        continue;
      }
      throw databaseFailure("create website concierge session", error);
    }

    throw new Error("Website concierge session creation ended unexpectedly.");
  }

  async authenticateAndConsume(input: {
    sessionId: string;
    sessionToken: string;
    inputCharacters: number;
  }): Promise<{ outletPreference: WebsiteConciergeOutlet }> {
    const { data, error } = await this.database.rpc(
      "ai_consume_website_concierge_quota_v1",
      {
        p_session_id: input.sessionId,
        p_token_hash: tokenHash(input.sessionToken),
        p_input_chars: input.inputCharacters,
      },
    );
    if (error) throw databaseFailure("consume website concierge quota", error);
    const value = record(data);
    if (value.ok !== true) {
      const code = typeof value.code === "string" ? value.code : "session_invalid";
      const failure = new Error(code);
      failure.name = code === "rate_limited"
        ? "WebsiteConciergeRateLimitError"
        : "WebsiteConciergeAuthenticationError";
      throw failure;
    }
    const outlet = value.outletPreference;
    return {
      outletPreference:
        outlet === "tanglin" || outlet === "sentosa" || outlet === "either"
          ? outlet
          : "unspecified",
    };
  }

  async loadHistory(
    sessionId: string,
    limit = 12,
  ): Promise<WebsiteConciergeHistoryMessage[]> {
    const { data, error } = await this.database
      .from("ai_website_concierge_messages_v1")
      .select("role,body,created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 20)));
    if (error) throw databaseFailure("load website concierge history", error);
    return (data ?? [])
      .map((item) => ({
        role: item.role === "concierge" ? "concierge" as const : "visitor" as const,
        body: String(item.body ?? ""),
        createdAt: String(item.created_at ?? ""),
      }))
      .reverse();
  }

  async appendVisitorMessage(input: {
    sessionId: string;
    body: string;
    outlet: WebsiteConciergeOutlet;
  }): Promise<string> {
    const id = randomUUID();
    const { error } = await this.database
      .from("ai_website_concierge_messages_v1")
      .insert({
        id,
        session_id: input.sessionId,
        role: "visitor",
        body: input.body,
        outlet_context: input.outlet,
        evidence: {},
      });
    if (error) throw databaseFailure("store website visitor message", error);
    return id;
  }

  async appendConciergeMessage(input: {
    sessionId: string;
    replyToMessageId: string;
    result: WebsiteConciergeResult;
  }): Promise<string> {
    const id = randomUUID();
    const { error } = await this.database
      .from("ai_website_concierge_messages_v1")
      .insert({
        id,
        session_id: input.sessionId,
        reply_to_message_id: input.replyToMessageId,
        role: "concierge",
        body: input.result.reply,
        intent: input.result.decision.intent,
        outlet_context: input.result.decision.resolvedOutlet,
        evidence: input.result.evidence as unknown as JsonValue,
        validation: input.result.validation as unknown as JsonValue,
        model_id: input.result.modelId,
        model_attempts: input.result.modelAttempts,
        latency_ms: input.result.latencyMs,
      });
    if (error) throw databaseFailure("store website concierge reply", error);
    await this.updateOutletPreference(
      input.sessionId,
      input.result.decision.resolvedOutlet,
    );
    return id;
  }

  async updateOutletPreference(
    sessionId: string,
    outlet: WebsiteConciergeOutlet,
  ): Promise<void> {
    if (outlet === "unspecified") return;
    const { error } = await this.database
      .from("ai_website_concierge_sessions_v1")
      .update({
        outlet_preference: outlet,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
    if (error) throw databaseFailure("update website concierge outlet", error);
  }
}
