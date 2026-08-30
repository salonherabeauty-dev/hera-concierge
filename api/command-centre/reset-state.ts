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

function mapState(value: Record<string, unknown>) {
  return {
    conversationId: value.conversation_id,
    turnId: value.turn_id,
    turnVersion: value.turn_version,
    turnStatus: value.turn_status,
    deliveryControl: value.delivery_control,
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
    jobId: value.job_id,
    jobStatus: value.job_status,
    jobAttempts: value.job_attempts,
    jobModelAttempts: value.job_model_attempts,
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
        headers: { "X-Client-Info": "hera-reset-state-v3/1.0" },
      },
    });

    let query = client.from("ai_latest_client_turns_v3").select("*");
    if (conversationIds.length > 0) {
      query = query.in("conversation_id", conversationIds);
    }
    const { data, error } = await query.limit(300);
    if (error) throw new Error(`load reset state: ${error.message}`);

    return response.status(200).json({
      ok: true,
      resetVersion: HERA_RECEPTIONIST_RESET_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      states: (data ?? []).map((item) => mapState(item as Record<string, unknown>)),
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
