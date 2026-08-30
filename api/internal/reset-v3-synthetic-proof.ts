import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig } from "../../src/config.js";
import {
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import {
  HERA_RECEPTIONIST_RESET_VERSION,
  requireReceptionistResetV3,
} from "../../src/reset/boundary.js";
import { RESET_OPENAI_MODEL_ID } from "../../src/reset/engine.js";
import { drainResetTurnJobs } from "../../src/reset/worker.js";

const SYNTHETIC_CONTACT_ID = "00000000-0000-4000-8000-000000000501";
const SYNTHETIC_CONVERSATION_ID = "00000000-0000-4000-8000-000000000502";
const SYNTHETIC_MESSAGE_ID = "00000000-0000-4000-8000-000000000503";
const SYNTHETIC_TURN_ID = "749c82f7-0ad8-4696-9be5-3a2b57df6594";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeFailure(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\r\n\t]+/g, " ").slice(0, 300)
    : null;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);

  try {
    requireReceptionistResetV3();
    const database = getDatabaseConfig();
    const client = createClient(database.url, database.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-reset-v3-synthetic-proof/1.0" },
      },
    });

    const [contactResult, conversationResult, messageResult] = await Promise.all([
      client
        .from("ai_contacts")
        .select("id,wa_id,profile_name,consent,safety_flags")
        .eq("id", SYNTHETIC_CONTACT_ID)
        .maybeSingle(),
      client
        .from("ai_conversations")
        .select("id,contact_id,state")
        .eq("id", SYNTHETIC_CONVERSATION_ID)
        .maybeSingle(),
      client
        .from("ai_messages")
        .select("id,conversation_id,contact_id,raw_payload")
        .eq("id", SYNTHETIC_MESSAGE_ID)
        .maybeSingle(),
    ]);
    if (contactResult.error) throw contactResult.error;
    if (conversationResult.error) throw conversationResult.error;
    if (messageResult.error) throw messageResult.error;

    const contact = record(contactResult.data);
    const conversation = record(conversationResult.data);
    const message = record(messageResult.data);
    const consent = record(contact?.consent);
    const conversationState = record(conversation?.state);
    const rawPayload = record(message?.raw_payload);
    const syntheticBoundary = Boolean(
      contact?.id === SYNTHETIC_CONTACT_ID &&
      contact?.wa_id === "999999999999999" &&
      consent?.synthetic === true &&
      consent?.doNotContact === true &&
      conversation?.id === SYNTHETIC_CONVERSATION_ID &&
      conversation?.contact_id === SYNTHETIC_CONTACT_ID &&
      conversationState?.synthetic === true &&
      conversationState?.nonClient === true &&
      conversationState?.doNotSend === true &&
      message?.id === SYNTHETIC_MESSAGE_ID &&
      message?.conversation_id === SYNTHETIC_CONVERSATION_ID &&
      message?.contact_id === SYNTHETIC_CONTACT_ID &&
      rawPayload?.synthetic === true &&
      rawPayload?.nonClient === true &&
      rawPayload?.doNotContact === true
    );
    if (!syntheticBoundary) {
      return response.status(409).json({
        ok: false,
        code: "synthetic_boundary_not_verified",
      });
    }

    const initial = await client
      .from("ai_client_turns_v3")
      .select("id,status")
      .eq("id", SYNTHETIC_TURN_ID)
      .eq("conversation_id", SYNTHETIC_CONVERSATION_ID)
      .maybeSingle();
    if (initial.error) throw initial.error;
    if (!initial.data) {
      return response.status(404).json({
        ok: false,
        code: "synthetic_turn_not_found",
      });
    }

    let drain = {
      jobsClaimed: 0,
      jobsReady: 0,
      jobsFailed: 0,
      jobsSuperseded: 0,
      providerSendCalls: 0 as const,
      timelyWriteCalls: 0 as const,
    };
    if (initial.data.status === "collecting") {
      drain = await drainResetTurnJobs({
        turnIds: [SYNTHETIC_TURN_ID],
        limit: 1,
        workerId: "reset-v3-approved-synthetic-connectivity-proof",
      });
    }

    const turnResult = await client
      .from("ai_client_turns_v3")
      .select("id,status,delivery_control,generation_runs,model_attempts,candidate_id,failure_code,failure_message")
      .eq("id", SYNTHETIC_TURN_ID)
      .single();
    if (turnResult.error) throw turnResult.error;
    const turn = record(turnResult.data)!;

    let candidate: Record<string, unknown> | null = null;
    if (typeof turn.candidate_id === "string") {
      const candidateResult = await client
        .from("ai_reply_candidates_v3")
        .select("id,turn_id,status,body,body_hash,model_id,model_attempts")
        .eq("id", turn.candidate_id)
        .maybeSingle();
      if (candidateResult.error) throw candidateResult.error;
      candidate = record(candidateResult.data);
    }

    const [humanSends, legacyOutbox] = await Promise.all([
      client
        .from("ai_human_send_reservations_v3")
        .select("id", { count: "exact", head: true })
        .eq("turn_id", SYNTHETIC_TURN_ID),
      client
        .from("ai_outbox")
        .select("id", { count: "exact", head: true })
        .eq("source_message_id", SYNTHETIC_MESSAGE_ID),
    ]);
    if (humanSends.error) throw humanSends.error;
    if (legacyOutbox.error) throw legacyOutbox.error;

    const body = typeof candidate?.body === "string" ? candidate.body.trim() : "";
    const modelAttempts = Number(candidate?.model_attempts ?? 0);
    const proofPassed = Boolean(
      turn.status === "ready" &&
      turn.delivery_control === "human_only" &&
      candidate?.id === turn.candidate_id &&
      candidate?.turn_id === SYNTHETIC_TURN_ID &&
      candidate?.status === "ready" &&
      body.length > 0 &&
      candidate?.model_id === RESET_OPENAI_MODEL_ID &&
      Number.isInteger(modelAttempts) &&
      modelAttempts >= 1 &&
      modelAttempts <= 2 &&
      (humanSends.count ?? 0) === 0 &&
      (legacyOutbox.count ?? 0) === 0 &&
      drain.providerSendCalls === 0 &&
      drain.timelyWriteCalls === 0
    );

    return response.status(proofPassed ? 200 : 503).json({
      ok: proofPassed,
      synthetic: true,
      nonClient: true,
      resetVersion: HERA_RECEPTIONIST_RESET_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      turnId: SYNTHETIC_TURN_ID,
      turnStatus: turn.status,
      deliveryControl: turn.delivery_control,
      generationRuns: turn.generation_runs,
      candidateId: candidate?.id ?? null,
      editableCharacterCount: body.length,
      candidateHashPresent: typeof candidate?.body_hash === "string",
      modelId: candidate?.model_id ?? null,
      modelAttempts,
      humanSendReservations: humanSends.count ?? 0,
      legacyOutboxRows: legacyOutbox.count ?? 0,
      providerSendCalls: drain.providerSendCalls,
      timelyWriteCalls: drain.timelyWriteCalls,
      automaticDeliveryAllowed: false,
      failureCode: safeFailure(turn.failure_code),
      failureMessage: safeFailure(turn.failure_message),
      drain,
    });
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : 500;
    return response.status(status).json({
      ok: false,
      synthetic: true,
      nonClient: true,
      code: "synthetic_proof_execution_failed",
      errorName: error instanceof Error ? error.name.slice(0, 120) : "UnknownError",
    });
  }
}
