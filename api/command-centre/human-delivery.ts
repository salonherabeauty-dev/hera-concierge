import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getD360Config,
  getWhatsAppProviderConfig,
  HERA_INTERNAL_PILOT_BRANCH,
} from "../../src/config.js";
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
import {
  SupabaseHumanDeliveryRepository,
  type HumanDeliveryActionResult,
  type HumanDeliverySendReservation,
} from "../../src/command-centre/humanDeliveryRepository.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import {
  humanDeliveryActionBodySchema,
  parseSchema,
} from "../../src/command-centre/validation.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { D360WhatsAppClient } from "../../src/whatsapp/d360Client.js";

interface PreviewBoundary {
  preview: boolean;
  authoritative: boolean;
  shadowLocked: boolean;
  providerReady: boolean;
  deliveryEnabled: boolean;
  branch: string;
}

function previewBoundary(): PreviewBoundary {
  const branch = process.env.VERCEL_GIT_COMMIT_REF?.trim() ?? "";
  const preview = process.env.VERCEL_ENV === "preview" && branch !== "main";
  const shadowLocked =
    process.env.WHATSAPP_SEND_MODE === "shadow" &&
    process.env.WHATSAPP_LIVE_CONFIRMATION !==
      "ENABLE_HERA_WHATSAPP_LIVE";
  let providerReady = false;
  try {
    providerReady =
      getWhatsAppProviderConfig().provider === "360dialog";
  } catch {
    providerReady = false;
  }
  const authoritative = branch === HERA_INTERNAL_PILOT_BRANCH;
  return {
    preview,
    authoritative,
    shadowLocked,
    providerReady,
    deliveryEnabled:
      preview && authoritative && shadowLocked && providerReady,
    branch,
  };
}

function requirePreviewReviewBoundary(boundary: PreviewBoundary): void {
  if (!boundary.preview || !boundary.shadowLocked) {
    const error = new Error(
      "Human-approved delivery is restricted to a non-main, shadow-locked Preview.",
    );
    error.name = "HumanDeliveryPreviewRequiredError";
    throw error;
  }
}

function requireHumanSendBoundary(boundary: PreviewBoundary): void {
  requirePreviewReviewBoundary(boundary);
  if (!boundary.authoritative) {
    const error = new Error(
      "Approve & Send is available only on the authoritative staging Preview.",
    );
    error.name = "HumanDeliveryAuthoritativePreviewRequiredError";
    throw error;
  }
  if (!boundary.providerReady) {
    const error = new Error(
      "The 360dialog Preview transport is not available.",
    );
    error.name = "HumanDeliveryProviderUnavailableError";
    throw error;
  }
}

function optionalConversationId(
  request: VercelRequest,
): string | null {
  const value = Array.isArray(request.query.conversationId)
    ? request.query.conversationId[0]
    : request.query.conversationId;
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    const error = new Error("Conversation id is invalid.");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return value;
}

function queueLimit(request: VercelRequest): number {
  const value = Array.isArray(request.query.limit)
    ? request.query.limit[0]
    : request.query.limit;
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    const error = new Error("Review queue limit is invalid.");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return Math.max(1, Math.min(Number(value), 100));
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
  const diagnostic =
    error && typeof error === "object"
      ? (error as { status?: unknown })
      : {};
  const status =
    typeof diagnostic.status === "number"
      ? `_${diagnostic.status}`
      : "";
  return `${name}${status}`
    .replace(/[^a-z0-9_]+/gi, "_")
    .toLowerCase()
    .slice(0, 120);
}

async function completeWithOneRetry(input: {
  repository: SupabaseHumanDeliveryRepository;
  actorUserId: string;
  reservation: HumanDeliverySendReservation;
  providerMessageId: string;
}): Promise<HumanDeliveryActionResult> {
  try {
    return await input.repository.complete({
      actorUserId: input.actorUserId,
      approvedOutboxId: input.reservation.approvedOutboxId,
      reviewId: input.reservation.reviewId,
      providerMessageId: input.providerMessageId,
    });
  } catch (firstError) {
    logOperationalEvent(
      "warn",
      "human_delivery_send_finalize_retry",
      {
        approvedOutboxId: input.reservation.approvedOutboxId,
        reviewId: input.reservation.reviewId,
        providerMessageId: input.providerMessageId,
        ...safeErrorFields(firstError),
      },
    );
    return input.repository.complete({
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
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(response, ["GET", "POST"]);
  }

  const boundary = previewBoundary();

  try {
    requirePreviewReviewBoundary(boundary);
    const session = await authenticateCommandCentre(request, response);
    const repository = new SupabaseHumanDeliveryRepository();

    if (request.method === "GET") {
      if (
        !hasCapability(session.staff.role, "view_conversations") ||
        !hasCapability(session.staff.role, "review_delivery")
      ) {
        return response.status(403).json({ error: "Forbidden" });
      }

      const items = await repository.listQueue({
        actorUserId: session.staff.userId,
        conversationId: optionalConversationId(request),
        limit: queueLimit(request),
      });
      return response.status(200).json({
        mode: "human_approved_preview",
        deliveryEnabled: boundary.deliveryEnabled,
        branch: boundary.branch,
        items,
      });
    }

    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    const body = parseSchema(
      humanDeliveryActionBodySchema,
      parseJsonBody<unknown>(request),
    );

    if (body.action === "approve") {
      if (!hasCapability(session.staff.role, "approve_delivery")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      requireHumanSendBoundary(boundary);

      const reserved = await repository.reserveApproval({
        actorUserId: session.staff.userId,
        candidateId: body.candidateId,
        expectedSourceMessageId: body.expectedSourceMessageId,
        expectedResponseHash: body.expectedResponseHash,
        expectedPhoneEnding: body.expectedPhoneEnding,
      });
      if (!reserved.ok) {
        return response
          .status(blockedStatus(reserved.code))
          .json(reserved);
      }
      if (reserved.state === "already_sent") {
        return response.status(200).json(reserved);
      }
      if (
        reserved.state !== "send_reserved" ||
        !("toWaId" in reserved)
      ) {
        return response.status(409).json({
          ...reserved,
          ok: false,
          code: "human_delivery_send_already_in_progress",
        });
      }

      const preflight = await repository.preflight({
        actorUserId: session.staff.userId,
        approvedOutboxId: reserved.approvedOutboxId,
        reviewId: reserved.reviewId,
        expectedSourceMessageId: body.expectedSourceMessageId,
        expectedResponseHash: body.expectedResponseHash,
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
          code: "human_delivery_preflight_invalid",
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
          .fail({
            actorUserId: session.staff.userId,
            approvedOutboxId: reserved.approvedOutboxId,
            reviewId: reserved.reviewId,
            failureCode: code,
          })
          .catch((failurePersistenceError) => {
            logOperationalEvent(
              "error",
              "human_delivery_failure_persistence_failed",
              {
                approvedOutboxId: reserved.approvedOutboxId,
                reviewId: reserved.reviewId,
                failureCode: code,
                ...safeErrorFields(failurePersistenceError),
              },
            );
          });
        logOperationalEvent("error", "human_delivery_provider_send_failed", {
          approvedOutboxId: reserved.approvedOutboxId,
          reviewId: reserved.reviewId,
          sourceMessageId: reserved.sourceMessageId,
          phoneEnding: reserved.phoneEnding,
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
          responseHash: reserved.responseHash,
          phoneEnding: reserved.phoneEnding,
          deliveryStatus: "failed",
          providerMessageId: null,
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
            "human_delivery_send_finalize_blocked",
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
          });
        }
        return response.status(200).json(completed);
      } catch (error) {
        logOperationalEvent(
          "error",
          "human_delivery_send_finalize_failed",
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
          responseHash: reserved.responseHash,
          phoneEnding: reserved.phoneEnding,
          deliveryStatus: "sent",
          providerMessageId,
          details: {},
        });
      }
    }

    if (body.action === "reject") {
      if (
        !hasCapability(session.staff.role, "reject_delivery") ||
        !hasCapability(session.staff.role, "control_conversation")
      ) {
        return response.status(403).json({ error: "Forbidden" });
      }

      const result = await repository.reject({
        actorUserId: session.staff.userId,
        candidateId: body.candidateId,
        expectedSourceMessageId: body.expectedSourceMessageId,
        expectedResponseHash: body.expectedResponseHash,
        expectedPhoneEnding: body.expectedPhoneEnding,
        reason: body.reason,
      });
      return response
        .status(result.ok ? 200 : blockedStatus(result.code))
        .json(result);
    }

    if (
      !hasCapability(session.staff.role, "escalate_delivery") ||
      !hasCapability(session.staff.role, "control_conversation")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const result = await repository.escalate({
      actorUserId: session.staff.userId,
      candidateId: body.candidateId,
      expectedSourceMessageId: body.expectedSourceMessageId,
      expectedResponseHash: body.expectedResponseHash,
      expectedPhoneEnding: body.expectedPhoneEnding,
      escalationRole: body.escalationRole,
      reason: body.reason,
    });
    return response
      .status(result.ok ? 200 : blockedStatus(result.code))
      .json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "HumanDeliveryPreviewRequiredError" ||
        error.name ===
          "HumanDeliveryAuthoritativePreviewRequiredError")
    ) {
      return response.status(403).json({
        error: error.message,
        code: "human_delivery_preview_required",
      });
    }
    if (
      error instanceof Error &&
      error.name === "HumanDeliveryProviderUnavailableError"
    ) {
      return response.status(503).json({
        error: error.message,
        code: "human_delivery_provider_unavailable",
      });
    }
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
