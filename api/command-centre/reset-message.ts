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
import { getD360Config, getDatabaseConfig } from "../../src/config.js";
import {
  HERA_RESET_ARCHITECTURE_VERSION,
  requireResetReceptionist,
} from "../../src/reset/config.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";
import { ResetSendPreflightRepository } from "../../src/reset/sendPreflight.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { D360WhatsAppClient } from "../../src/whatsapp/d360Client.js";

const bodySchema = z.object({
  draftRunId: z.string().uuid(),
  expectedTurnId: z.string().uuid(),
  expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPhoneEnding: z.string().regex(/^[0-9]{4}$/),
  messageText: z.string().trim().min(1).max(4000),
});

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Reset send reservation is missing ${field}`);
  }
  return value;
}

function failureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "provider_send_failed";
  const status =
    error &&
    typeof error === "object" &&
    typeof (error as { status?: unknown }).status === "number"
      ? `_${(error as { status: number }).status}`
      : "";
  return `${name}${status}`
    .replace(/[^a-z0-9_]+/gi, "_")
    .toLowerCase()
    .slice(0, 120);
}

async function completeWithOneRetry(input: {
  repository: ResetReceptionistRepository;
  actorUserId: string;
  sendId: string;
  providerMessageId: string;
}) {
  try {
    return await input.repository.completeHumanSend({
      actorUserId: input.actorUserId,
      sendId: input.sendId,
      providerMessageId: input.providerMessageId,
    });
  } catch (firstError) {
    logOperationalEvent("warn", "reset_human_send_finalize_retry", {
      sendId: input.sendId,
      providerMessageId: input.providerMessageId,
      ...safeErrorFields(firstError),
    });
    return input.repository.completeHumanSend({
      actorUserId: input.actorUserId,
      sendId: input.sendId,
      providerMessageId: input.providerMessageId,
    });
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);

  try {
    requireResetReceptionist();
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    if (!hasCapability(session.staff.role, "approve_delivery")) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const parsed = bodySchema.safeParse(parseJsonBody<unknown>(request));
    if (!parsed.success) {
      const error = new Error("Send request is invalid.");
      error.name = "CommandCentreValidationError";
      throw error;
    }

    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const preflights = new ResetSendPreflightRepository(
      database.url,
      database.serviceRoleKey,
    );
    const reserved = await repository.reserveHumanSend({
      actorUserId: session.staff.userId,
      draftRunId: parsed.data.draftRunId,
      expectedTurnId: parsed.data.expectedTurnId,
      expectedCandidateHash: parsed.data.expectedCandidateHash,
      expectedPhoneEnding: parsed.data.expectedPhoneEnding,
      finalText: parsed.data.messageText,
    });

    if (reserved.state === "already_sent") {
      return response.status(200).json({
        ...reserved,
        architecture: HERA_RESET_ARCHITECTURE_VERSION,
        channel: "Tanglin Mall WhatsApp",
      });
    }

    const sendId = required(reserved.sendId, "sendId");
    const finalHash = required(reserved.finalHash, "finalHash");
    const preflight = await preflights.preflight({
      actorUserId: session.staff.userId,
      sendId,
      expectedTurnId: parsed.data.expectedTurnId,
      expectedCandidateHash: parsed.data.expectedCandidateHash,
      expectedFinalHash: finalHash,
      expectedPhoneEnding: parsed.data.expectedPhoneEnding,
    });

    if (!preflight.ok) {
      await repository
        .failHumanSend({
          actorUserId: session.staff.userId,
          sendId,
          failureCode: preflight.code,
        })
        .catch(() => undefined);
      return response.status(409).json({
        ok: false,
        state: "send_blocked",
        code: preflight.code,
        sendId,
        providerMessageId: null,
        channel: "Tanglin Mall WhatsApp",
      });
    }

    const d360 = getD360Config();
    const whatsapp = new D360WhatsAppClient({
      apiKey: d360.apiKey,
      baseUrl: d360.baseUrl,
    });

    let providerMessageId: string;
    try {
      const sent = await whatsapp.sendText(
        preflight.toWaId,
        preflight.messageText,
      );
      providerMessageId = sent.providerMessageId;
    } catch (error) {
      const code = failureCode(error);
      await repository
        .failHumanSend({
          actorUserId: session.staff.userId,
          sendId,
          failureCode: code,
        })
        .catch(() => undefined);
      logOperationalEvent("error", "reset_human_provider_send_failed", {
        sendId,
        draftRunId: parsed.data.draftRunId,
        phoneEnding: parsed.data.expectedPhoneEnding,
        failureCode: code,
        ...safeErrorFields(error),
      });
      return response.status(502).json({
        ok: false,
        state: "send_failed",
        code,
        sendId,
        providerMessageId: null,
        channel: "Tanglin Mall WhatsApp",
      });
    }

    try {
      const completed = await completeWithOneRetry({
        repository,
        actorUserId: session.staff.userId,
        sendId,
        providerMessageId,
      });
      return response.status(200).json({
        ...completed,
        architecture: HERA_RESET_ARCHITECTURE_VERSION,
        channel: "Tanglin Mall WhatsApp",
      });
    } catch (error) {
      // The provider has already accepted this message. Leave the reservation
      // non-recyclable so a refresh or repeated click cannot send it twice.
      // A named operator must reconcile the audit record against the provider id.
      logOperationalEvent("error", "reset_human_send_finalize_failed", {
        sendId,
        providerMessageId,
        draftRunId: parsed.data.draftRunId,
        ...safeErrorFields(error),
      });
      return response.status(202).json({
        ok: true,
        state: "sent_pending_audit_reconciliation",
        code: "send_finalize_failed",
        sendId,
        providerMessageId,
        channel: "Tanglin Mall WhatsApp",
      });
    }
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
