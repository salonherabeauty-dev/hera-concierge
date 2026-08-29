import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateCommandCentre,
} from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import {
  HERA_TANGLIN_WHATSAPP_CHANNEL,
  receptionistWorkspaceBoundary,
  requireReceptionistWorkspacePreview,
} from "../../src/command-centre/receptionistWorkspaceBoundary.js";
import { ReceptionistWorkspaceRepository } from "../../src/command-centre/receptionistWorkspaceRepository.js";

function optionalConversationId(request: VercelRequest): string | null {
  const value = Array.isArray(request.query.conversationId)
    ? request.query.conversationId[0]
    : request.query.conversationId;
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
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
    const error = new Error("Queue limit is invalid.");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return Math.max(1, Math.min(Number(value), 100));
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") {
    return methodNotAllowed(response, ["GET"]);
  }

  const boundary = receptionistWorkspaceBoundary();
  try {
    requireReceptionistWorkspacePreview(boundary);
    const session = await authenticateCommandCentre(request, response);
    if (
      !hasCapability(session.staff.role, "view_conversations") ||
      !hasCapability(session.staff.role, "review_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const repository = new ReceptionistWorkspaceRepository();
    const items = await repository.listQueue({
      actorUserId: session.staff.userId,
      conversationId: optionalConversationId(request),
      limit: queueLimit(request),
    });

    return response.status(200).json({
      mode: "human_reviewed",
      deliveryEnabled: boundary.providerReady,
      channel: HERA_TANGLIN_WHATSAPP_CHANNEL,
      branch: boundary.branch,
      items,
    });
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
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
