import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig } from "../../src/config.js";
import { RESET_OPENAI_MODEL_ID } from "../../src/reset/engine.js";
import { drainResetTurnJobs } from "../../src/reset/worker.js";

const PROOF_BRANCH = "proof/reset-v3-curly-no-output";
const SYNTHETIC_CONTACT_ID = "00000000-0000-4000-8000-000000000601";
const SYNTHETIC_CONVERSATION_ID = "00000000-0000-4000-8000-000000000602";
const SYNTHETIC_MESSAGE_ID = "00000000-0000-4000-8000-000000000603";
const SYNTHETIC_TURN_ID = "4a2f0c11-adc1-45da-8cf8-65b0242e515c";
const EXPECTED_TEXT =
  "I need an urgent curly haircut tomorrow and may I know who is the best curly hair specialist and what’s the price !";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

  if (
    process.env.VERCEL_ENV !== "preview" ||
    process.env.VERCEL_GIT_COMMIT_REF !== PROOF_BRANCH
  ) {
    return response.status(404).json({ error: "Not found" });
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const database = getDatabaseConfig();
    const client = createClient(database.url, database.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-reset-v3-curly-proof/1.0" },
      },
    });

    const [contactResult, conversationResult, messageResult, turnResult] =
      await Promise.all([
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
          .select("id,conversation_id,contact_id,text_body,raw_payload")
          .eq("id", SYNTHETIC_MESSAGE_ID)
          .maybeSingle(),
        client
          .from("ai_client_turns_v3")
          .select("id,conversation_id,status,delivery_control,consolidated_text")
          .eq("id", SYNTHETIC_TURN_ID)
          .maybeSingle(),
      ]);

    for (const result of [
      contactResult,
      conversationResult,
      messageResult,
      turnResult,
    ]) {
      if (result.error) throw result.error;
    }

    const contact = record(contactResult.data);
    const conversation = record(conversationResult.data);
    const message = record(messageResult.data);
    const initialTurn = record(turnResult.data);
    const consent = record(contact?.consent);
    const conversationState = record(conversation?.state);
    const rawPayload = record(message?.raw_payload);
    const syntheticBoundary = Boolean(
      contact?.id === SYNTHETIC_CONTACT_ID &&
      contact?.wa_id === "999999999999998" &&
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
      message?.text_body === EXPECTED_TEXT &&
      rawPayload?.synthetic === true &&
      rawPayload?.nonClient === true &&
      rawPayload?.doNotContact === true &&
      initialTurn?.id === SYNTHETIC_TURN_ID &&
      initialTurn?.conversation_id === SYNTHETIC_CONVERSATION_ID &&
      initialTurn?.consolidated_text === EXPECTED_TEXT &&
      initialTurn?.delivery_control === "human_only"
    );

    if (!syntheticBoundary) {
      return response.status(409).json({
        ok: false,
        code: "synthetic_boundary_not_verified",
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
    if (initialTurn?.status === "collecting") {
      drain = await drainResetTurnJobs({
        turnIds: [SYNTHETIC_TURN_ID],
        limit: 1,
        workerId: "reset-v3-exact-curly-no-output-proof",
      });
    }

    const finalTurnResult = await client
      .from("ai_client_turns_v3")
      .select("id,status,delivery_control,generation_runs,model_attempts,candidate_id,failure_code,failure_message")
      .eq("id", SYNTHETIC_TURN_ID)
      .single();
    if (finalTurnResult.error) throw finalTurnResult.error;
    const turn = record(finalTurnResult.data)!;

    let candidate: Record<string, unknown> | null = null;
    if (typeof turn.candidate_id === "string") {
      const candidateResult = await client
        .from("ai_reply_candidates_v3")
        .select("id,turn_id,status,body,body_hash,model_id,model_attempts,evidence,validation")
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
    const evidence = record(candidate?.evidence);
    const knowledge = Array.isArray(evidence?.knowledge)
      ? evidence.knowledge.map(record).filter(Boolean)
      : [];
    const evidenceCategories = [
      ...new Set(
        knowledge
          .map((item) => item?.category)
          .filter((item): item is string => typeof item === "string"),
      ),
    ].sort();
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
      evidenceCategories.includes("authority") &&
      evidenceCategories.includes("service") &&
      evidenceCategories.includes("staff") &&
      evidenceCategories.includes("price") &&
      (humanSends.count ?? 0) === 0 &&
      (legacyOutbox.count ?? 0) === 0 &&
      drain.providerSendCalls === 0 &&
      drain.timelyWriteCalls === 0
    );

    return response.status(proofPassed ? 200 : 503).json({
      ok: proofPassed,
      synthetic: true,
      nonClient: true,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      exactClientTurn: EXPECTED_TEXT,
      turnId: SYNTHETIC_TURN_ID,
      turnStatus: turn.status,
      deliveryControl: turn.delivery_control,
      generationRuns: turn.generation_runs,
      candidateId: candidate?.id ?? null,
      editableDraft: body,
      candidateHashPresent: typeof candidate?.body_hash === "string",
      modelId: candidate?.model_id ?? null,
      modelAttempts,
      evidenceCategories,
      validationPassed: record(candidate?.validation)?.passed === true,
      humanSendReservations: humanSends.count ?? 0,
      legacyOutboxRows: legacyOutbox.count ?? 0,
      providerSendCalls: drain.providerSendCalls,
      timelyWriteCalls: drain.timelyWriteCalls,
      automaticDeliveryAllowed: false,
      failureCode: turn.failure_code ?? null,
      failureMessage: turn.failure_message ?? null,
      drain,
    });
  } catch (error) {
    return response.status(500).json({
      ok: false,
      synthetic: true,
      nonClient: true,
      code: "curly_proof_execution_failed",
      errorName: error instanceof Error ? error.name.slice(0, 120) : "UnknownError",
    });
  }
}
