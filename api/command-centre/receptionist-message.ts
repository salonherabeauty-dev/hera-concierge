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
  requireReceptionistWorkspacePreview,
  requireTanglinWhatsAppChannel,
} from "../../src/command-centre/receptionistWorkspaceBoundary.js";
import {
  ReceptionistWorkspaceRepository,
  type ReceptionistActionResult,
  type ReceptionistSendReservation,
} from "../../src/command-centre/receptionistWorkspaceRepository.js";
import { getD360Config } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { D360WhatsAppClient } from "../../src/whatsapp/d360Client.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const phoneEnding = z.string().regex(/^[0-9]{4}$/);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    candidateId: uuid,
    expectedSourceMessageId: uuid,
    expectedCandidateHash: hash,
    expectedPhoneEnding: phoneEnding,
    messageText: z.string().trim().min(1).max(4000),
  }),
  z.object({
    action: z.literal("hold"),
    candidateId: uuid,
    expectedSourceMessageId: uuid,
    expectedCandidateHash: hash,
    expectedPhoneEnding: phoneEnding,
  }),
]);

function parseAction(value: unknown): z.infer<typeof actionSchema> {
  const result = actionSchema.safeParse(value);
  if (!result.success) {
    const error = new Error("Receptionist action validation failed");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return result.data;
}

function blockedStatus(code: string | null): number {
  if (code === "candidate_not_found") return 404;
  if (
    code === "inactive_staff" ||
    code === "role_not_authorized" ||
    code === "role_not_authorized_for_open_task" ||
    code === "risk_requires_specialist"
  ) {
    return 403;
  }
  return 409;
}

function failureCode(error: unknown): string {
  const name =
    error instanceof Error && error.name
      ? error.name
      : "provider_send_failed";
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
  repository: ReceptionistWorkspaceRepository;
  actorUserId: string;
  reservation: ReceptionistSendReservation;
  providerMessageId: string;
}): Promise<ReceptionistActionResult> {
  try {
    return await input.repository.completeSend({
      actorUserId: input.actorUserId,
      approvedOutboxId: input.reservation.approvedOutboxId,
      reviewId: input.reservation.reviewId,
      providerMessageId: input.providerMessageId,
    });
  } catch (firstError) {
    logOperationalEvent(
      "warn",
      "receptionist_send_finalize_retry",
      {
        approvedOutboxId: input.reservation.approvedOutboxId,
        reviewId: input.reservation.reviewId,
        providerMessageId: input.providerMessageId,
        ...safeErrorFields(firstError),
      },
    );
    return input.repository.completeSend({
      actorUserId: input.actorUserId,
      approvedOutboxId: input.reservation.approvedOutboxId,
      reviewId: input.reservation.reviewId,
      providerMessageId: input.providerMessageId,
    });
  }
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") {
    return methodNotAllowed(response, ["POST"]);
  }

  const boundary = receptionistWorkspaceBoundary();

  try {
    requireReceptionistWorkspacePreview(boundary);
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);

    const body = parseAction(parseJsonBody<unknown>(request));
    const repository = new ReceptionistWorkspaceRepository();

    if (body.action === "hold") {
      if (
        !hasCapability(session.staff.role, "reject_delivery") ||
        !hasCapability(session.staff.role, "control_conversation")
      ) {
        return response.status(403).json({ error: "Forbidden" });
      }

      const result = await repository.hold({
        actorUserId: session.staff.userId,
        candidateId: body.candidateId,
        expectedSourceMessageId: body.expectedSourceMessageId,
        expectedCandidateHash: body.expectedCandidateHash,
        expectedPhoneEnding: body.expectedPhoneEnding,
      });

      return response
        .status(result.ok ? 200 : blockedStatus(result.code))
        .json({
          ...result,
          channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
        });
    }

    if (!hasCapability(session.staff.role, "approve_delivery")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    requireTanglinWhatsAppChannel(boundary);

    const reserved = await repository.reserveSend({
      actorUserId: session.staff.userId,
      candidateId: body.candidateId,
      expectedSourceMessageId: body.expectedSourceMessageId,
      expectedCandidateHash: body.expectedCandidateHash,
      expectedPhoneEnding: body.expectedPhoneEnding,
      finalMessageText: body.messageText,
    });

    if (!reserved.ok) {
      return response
        .status(blockedStatus(reserved.code))
        .json(reserved);
    }

    if (reserved.state === "already_sent") {
      return response.status(200).json({
        ...reserved,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    }

    if (
      reserved.state === "already_sending" ||
      reserved.state !== "send_reserved" ||
      !("toWaId" in reserved)
    ) {
      return response.status(409).json({
        ...reserved,
        ok: false,
        code: "receptionist_send_already_in_progress",
      });
    }

    const preflight = await repository.preflightSend({
      actorUserId: session.staff.userId,
      approvedOutboxId: reserved.approvedOutboxId,
      reviewId: reserved.reviewId,
      expectedSourceMessageId: body.expectedSourceMessageId,
      expectedCandidateHash: body.expectedCandidateHash,
      expectedFinalHash: reserved.responseHash,
      expectedPhoneEnding: body.expectedPhoneEnding,
    });

    if (!preflight.ok) {
      return response
        .status(blockedStatus(preflight.code))
        .json(preflight);
    }

    if (
      preflight.state !== "ready_to_send" ||
      !("toWaId" in preflight)
    ) {
      return response.status(409).json({
        ...preflight,
        ok: false,
        code: "receptionist_preflight_invalid",
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
        .failSend({
          actorUserId: session.staff.userId,
          approvedOutboxId: reserved.approvedOutboxId,
          reviewId: reserved.reviewId,
          failureCode: code,
        })
        .catch((persistenceError) => {
          logOperationalEvent(
            "error",
            "receptionist_send_failure_persistence_failed",
            {
              approvedOutboxId: reserved.approvedOutboxId,
              reviewId: reserved.reviewId,
              failureCode: code,
              ...safeErrorFields(persistenceError),
            },
          );
        });

      logOperationalEvent("error", "receptionist_provider_send_failed", {
        approvedOutboxId: reserved.approvedOutboxId,
        reviewId: reserved.reviewId,
        sourceMessageId: reserved.sourceMessageId,
        phoneEnding: reserved.phoneEnding,
        channel: "tanglin_whatsapp_360dialog",
        failureCode: code,
        ...safeErrorFields(error),
      });

      return response.status(502).json({
        ok: false,
        state: "send_failed_human_takeover",
        code,
        candidateId: reserved.candidateId,
        approvedOutboxId: reserved.approvedOutboxId,
        reviewId: reserved.reviewId,
        conversationId: reserved.conversationId,
        sourceMessageId: reserved.sourceMessageId,
        candidateHash: reserved.candidateHash,
        responseHash: reserved.responseHash,
        phoneEnding: reserved.phoneEnding,
        deliveryStatus: "failed",
        providerMessageId: null,
        editedByHuman: reserved.editedByHuman,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
        details: {},
      });
    }

    try {
      const completed = await completeWithOneRetry({
        repository,
        actorUserId: session.staff.userId,
        reservation: reserved,
        providerMessageId,
      });

      if (!completed.ok) {
        logOperationalEvent(
          "error",
          "receptionist_send_finalize_blocked",
          {
            approvedOutboxId: reserved.approvedOutboxId,
            reviewId: reserved.reviewId,
            providerMessageId,
            code: completed.code,
          },
        );
        return response.status(202).json({
          ...completed,
          ok: true,
          state: "sent_pending_audit_reconciliation",
          code: "send_finalize_blocked",
          providerMessageId,
          deliveryStatus: "sent",
          channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
        });
      }

      return response.status(200).json({
        ...completed,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      });
    } catch (error) {
      logOperationalEvent(
        "error",
        "receptionist_send_finalize_failed",
        {
          approvedOutboxId: reserved.approvedOutboxId,
          reviewId: reserved.reviewId,
          providerMessageId,
          ...safeErrorFields(error),
        },
      );
      return response.status(202).json({
        ok: true,
        state: "sent_pending_audit_reconciliation",
        code: "send_finalize_failed",
        candidateId: reserved.candidateId,
        approvedOutboxId: reserved.approvedOutboxId,
        reviewId: reserved.reviewId,
        conversationId: reserved.conversationId,
        sourceMessageId: reserved.sourceMessageId,
        candidateHash: reserved.candidateHash,
        responseHash: reserved.responseHash,
        phoneEnding: reserved.phoneEnding,
        deliveryStatus: "sent",
        providerMessageId,
        editedByHuman: reserved.editedByHuman,
        channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
        details: {},
      });
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ReceptionistWorkspacePreviewRequiredError"
    ) {
      return response.status(403).json({
        error: error.message,
        code: "receptionist_preview_required",
      });
    }
    if (
      error instanceof Error &&
      error.name === "ReceptionistWorkspaceProviderUnavailableError"
    ) {
      return response.status(503).json({
        error: error.message,
        code: "tanglin_whatsapp_unavailable",
      });
    }

    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
