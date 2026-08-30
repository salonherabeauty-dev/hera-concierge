import { createClient } from "@supabase/supabase-js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  authenticateCommandCentre,
  requireCommandCentreCsrf,
} from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  parseJsonBody,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import {
  HERA_TANGLIN_WHATSAPP_CHANNEL,
  receptionistWorkspaceBoundary,
  requireTanglinWhatsAppChannel,
} from "../../src/command-centre/receptionistWorkspaceBoundary.js";
import { getD360Config, getDatabaseConfig } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { requireReceptionistResetV3 } from "../../src/reset/boundary.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";
import { D360WhatsAppClient } from "../../src/whatsapp/d360Client.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const phoneEnding = z.string().regex(/^[0-9]{4}$/);

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    candidateId: uuid,
    turnId: uuid,
    turnVersion: z.number().int().min(1),
    expectedCandidateHash: hash,
    expectedPhoneEnding: phoneEnding,
    messageText: z.string().trim().min(1).max(4000),
  }),
  z.object({
    action: z.literal("hold"),
    candidateId: uuid,
    expectedCandidateHash: hash,
  }),
]);

function safeFailureCode(error: unknown): string {
  const name = error instanceof Error && error.name
    ? error.name
    : "provider_send_failed";
  const status =
    error && typeof error === "object" &&
    typeof (error as { status?: unknown }).status === "number"
      ? `_${(error as { status: number }).status}`
      : "";
  return `${name}${status}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "provider_send_failed";
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") {
    return methodNotAllowed(response, ["POST"]);
  }

  try {
    requireReceptionistResetV3();
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    const body = requestSchema.parse(parseJsonBody<unknown>(request));
    const database = getDatabaseConfig();

    if (body.action === "hold") {
      if (
        !hasCapability(session.staff.role, "reject_delivery") ||
        !hasCapability(session.staff.role, "control_conversation")
      ) {
        return response.status(403).json({ error: "Forbidden" });
      }
      const client = createClient(database.url, database.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });
      const { data, error } = await client.rpc("ai_hold_reply_candidate_v3", {
        p_actor_user_id: session.staff.userId,
        p_candidate_id: body.candidateId,
        p_expected_hash: body.expectedCandidateHash,
      });
      if (error) throw new Error(`hold reset reply: ${error.message}`);
      const result = data as { ok?: boolean; state?: string; code?: string } | null;
      return response.status(result?.ok ? 200 : 409).json({
        ok: result?.ok === true,
        state: result?.state ?? null,
        code: result?.code ?? null,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    }

    if (!hasCapability(session.staff.role, "approve_delivery")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    requireTanglinWhatsAppChannel(receptionistWorkspaceBoundary());

    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const reservation = await repository.reserveHumanSend({
      actorUserId: session.staff.userId,
      candidateId: body.candidateId,
      turnId: body.turnId,
      turnVersion: body.turnVersion,
      candidateHash: body.expectedCandidateHash,
      phoneEnding: body.expectedPhoneEnding,
      finalText: body.messageText,
    });

    if (reservation.state === "sent") {
      return response.status(200).json({
        ...reservation,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    }
    if (
      !reservation.ok ||
      reservation.state !== "reserved" ||
      !reservation.reservationId ||
      !reservation.toWaId ||
      !reservation.messageText
    ) {
      return response.status(409).json({
        ...reservation,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    }

    const d360 = getD360Config();
    const whatsapp = new D360WhatsAppClient({
      apiKey: d360.apiKey,
      baseUrl: d360.baseUrl,
    });

    try {
      const sent = await whatsapp.sendText(
        reservation.toWaId,
        reservation.messageText,
      );
      await repository.completeHumanSend({
        reservationId: reservation.reservationId,
        providerMessageId: sent.providerMessageId,
      });
      return response.status(200).json({
        ok: true,
        state: "sent",
        providerMessageId: sent.providerMessageId,
        editedByHuman: reservation.editedByHuman,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    } catch (error) {
      const code = safeFailureCode(error);
      await repository
        .failHumanSend({
          reservationId: reservation.reservationId,
          failureCode: code,
        })
        .catch((persistenceError) => {
          logOperationalEvent(
            "error",
            "reset_v3_send_failure_persistence_failed",
            {
              reservationId: reservation.reservationId,
              failureCode: code,
              ...safeErrorFields(persistenceError),
            },
          );
        });
      logOperationalEvent("error", "reset_v3_human_send_failed", {
        reservationId: reservation.reservationId,
        candidateId: body.candidateId,
        turnId: body.turnId,
        recipientEnding: body.expectedPhoneEnding,
        failureCode: code,
        ...safeErrorFields(error),
      });
      return response.status(502).json({
        ok: false,
        state: "send_failed",
        code,
        providerMessageId: null,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    }
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
