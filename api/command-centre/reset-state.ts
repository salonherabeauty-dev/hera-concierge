import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { getDatabaseConfig } from "../../src/config.js";
import {
  HERA_RECEPTIONIST_RESET_VERSION,
  requireReceptionistResetV3,
} from "../../src/reset/boundary.js";

const uuid = z.string().uuid();

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseConversationIds(request: VercelRequest): string[] {
  const one = firstQuery(request.query.conversationId);
  const many = firstQuery(request.query.conversationIds);
  const candidates = [
    ...(one ? [one] : []),
    ...(many ? many.split(",") : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(candidates)].slice(0, 300);
  for (const candidate of unique) uuid.parse(candidate);
  return unique;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const RESET_WORKER_LEASE_MS = 7 * 60 * 1_000;

function mapState(
  value: Record<string, unknown>,
  sendReservation?: Record<string, unknown>,
) {
  const turnStatus = typeof value.turn_status === "string"
    ? value.turn_status
    : null;
  const generationRuns = numberValue(value.generation_runs);
  const generationRequestPending =
    turnStatus === "collecting" &&
    value.job_status === "pending" &&
    typeof value.job_generation_request_id === "string" &&
    value.job_generation_request_id.length > 0 &&
    value.job_generation_authorization_consumed_at == null;
  const jobLockedAt = typeof value.job_locked_at === "string"
    ? value.job_locked_at
    : null;
  const jobLockedAtMs = Date.parse(jobLockedAt ?? "");
  const jobLeaseStale =
    turnStatus === "processing" &&
    value.job_status === "processing" &&
    Number.isFinite(jobLockedAtMs) &&
    jobLockedAtMs <= Date.now() - RESET_WORKER_LEASE_MS;
  const retryAvailable =
    (turnStatus === "failed" || jobLeaseStale) &&
    generationRuns < 2;
  return {
    conversationId: value.conversation_id,
    turnId: value.turn_id,
    turnVersion: value.turn_version,
    turnStatus,
    deliveryControl: value.delivery_control,
    lastFragmentMessageId:
      typeof value.last_fragment_message_id === "string"
        ? value.last_fragment_message_id
        : null,
    turnContentHash:
      typeof value.turn_content_hash === "string" &&
        /^[0-9a-f]{64}$/.test(value.turn_content_hash)
        ? value.turn_content_hash
        : null,
    generationRuns,
    generationRequestPending,
    jobLeaseStale,
    retryAvailable,
    retryUnavailableReason:
      (turnStatus === "failed" || jobLeaseStale) &&
        !retryAvailable
        ? "retry_limit_reached"
        : null,
    firstFragmentAt: value.first_fragment_at,
    lastFragmentAt: value.last_fragment_at,
    settleAt: value.settle_at,
    failureCode: value.failure_code,
    failureMessage: value.failure_message,
    candidateId: value.candidate_id,
    candidateText: value.candidate_text,
    candidateHash: value.candidate_hash,
    candidateStatus: value.candidate_status,
    candidateModelId: value.candidate_model_id,
    candidateModelAttempts: value.candidate_model_attempts,
    sendReservationStatus:
      sendReservation?.status === "reserved" ||
        sendReservation?.status === "sent" ||
        sendReservation?.status === "failed"
        ? sendReservation.status
        : null,
    sendReservationFailureCode:
      typeof sendReservation?.failure_code === "string"
        ? sendReservation.failure_code
        : null,
    jobId: value.job_id,
    jobStatus: value.job_status,
    jobAttempts: value.job_attempts,
    jobGenerationRun: value.job_generation_run,
    jobModelAttempts: value.job_model_attempts,
    jobAuthorizedGenerationRun: value.job_authorized_generation_run,
    jobGenerationAuthorizedAt: value.job_generation_authorized_at,
    jobGenerationAuthorizationConsumedAt:
      value.job_generation_authorization_consumed_at,
    jobLockedAt,
  };
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") {
    return methodNotAllowed(response, ["GET"]);
  }

  try {
    requireReceptionistResetV3();
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const conversationIds = parseConversationIds(request);
    const database = getDatabaseConfig();
    const client = createClient(database.url, database.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { "X-Client-Info": "hera-reset-state-v3/1.3" },
      },
    });

    let query = client.from("ai_latest_client_turns_v3").select("*");
    if (conversationIds.length > 0) {
      query = query.in("conversation_id", conversationIds);
    }
    const { data, error } = await query.limit(300);
    if (error) throw new Error(`load reset state: ${error.message}`);

    const stateRows = (data ?? []) as Array<Record<string, unknown>>;
    const candidateIds = [
      ...new Set(
        stateRows
          .map((item) => item.candidate_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    ];
    const reservationsByCandidate = new Map<string, Record<string, unknown>>();
    if (candidateIds.length > 0) {
      const { data: reservations, error: reservationError } = await client
        .from("ai_human_send_reservations_v3")
        .select("candidate_id,status,failure_code,reserved_at")
        .in("candidate_id", candidateIds)
        .order("reserved_at", { ascending: false });
      if (reservationError) {
        throw new Error(`load reset send reservation: ${reservationError.message}`);
      }
      for (const reservation of (reservations ?? []) as Array<Record<string, unknown>>) {
        const candidateId = reservation.candidate_id;
        if (
          typeof candidateId === "string" &&
          !reservationsByCandidate.has(candidateId)
        ) {
          reservationsByCandidate.set(candidateId, reservation);
        }
      }
    }

    return response.status(200).json({
      ok: true,
      resetVersion: HERA_RECEPTIONIST_RESET_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      states: stateRows.map((item) => mapState(
        item,
        typeof item.candidate_id === "string"
          ? reservationsByCandidate.get(item.candidate_id)
          : undefined,
      )),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ReceptionistResetPreviewRequiredError"
    ) {
      return response.status(403).json({
        error: error.message,
        code: "receptionist_reset_preview_required",
      });
    }
    const safe = clientSafeError(error);
    return response.status(safe.status).json({
      error: safe.message,
      code: safe.code,
    });
  }
}
