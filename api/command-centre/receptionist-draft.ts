import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import {
  authenticateCommandCentre,
  requireCommandCentreCsrf,
} from "../../src/command-centre/auth.js";
import { ReceptionistDraftRepository } from "../../src/command-centre/receptionistDraftRepository.js";
import {
  clientSafeError,
  methodNotAllowed,
  parseJsonBody,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import {
  receptionistWorkspaceBoundary,
  requireReceptionistWorkspacePreview,
} from "../../src/command-centre/receptionistWorkspaceBoundary.js";
import { ReceptionistWorkspaceRepository } from "../../src/command-centre/receptionistWorkspaceRepository.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../../src/worker.js";

const requestSchema = z.object({
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  expectedPhoneEnding: z.string().regex(/^[0-9]{4}$/),
});

function parseRequest(value: unknown): z.infer<typeof requestSchema> {
  const result = requestSchema.safeParse(value);
  if (!result.success) {
    const error = new Error("Draft request validation failed");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return result.data;
}

function blockedStatus(code: string | null): number {
  if (code === "source_message_not_found") return 404;
  if (code === "inactive_staff" || code === "role_not_authorized") return 403;
  return 409;
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
    const boundary = receptionistWorkspaceBoundary();
    requireReceptionistWorkspacePreview(boundary);
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);

    if (
      !hasCapability(session.staff.role, "view_conversations") ||
      !hasCapability(session.staff.role, "review_delivery") ||
      !hasCapability(session.staff.role, "approve_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const body = parseRequest(parseJsonBody<unknown>(request));
    const drafts = new ReceptionistDraftRepository();
    const requested = await drafts.requestDraft({
      actorUserId: session.staff.userId,
      conversationId: body.conversationId,
      sourceMessageId: body.sourceMessageId,
      expectedPhoneEnding: body.expectedPhoneEnding,
    });

    if (!requested.ok) {
      return response.status(blockedStatus(requested.code)).json(requested);
    }

    const workspace = new ReceptionistWorkspaceRepository();
    const existing = await workspace.listQueue({
      actorUserId: session.staff.userId,
      conversationId: body.conversationId,
      limit: 10,
    });
    const existingItem = existing.find(
      (item) => item.sourceMessageId === body.sourceMessageId,
    );
    if (existingItem) {
      return response.status(200).json({
        ok: true,
        state: "draft_ready",
        code: null,
        item: existingItem,
      });
    }

    if (requested.jobId) {
      const runtime = createProductionRuntime();
      if (runtime.sendMode !== "shadow") {
        return response.status(403).json({
          error: "Draft generation is restricted to shadow-locked staging.",
          code: "receptionist_preview_required",
        });
      }
      await drainReceptionistForJobs(runtime, [requested.jobId], 1);
    }

    const items = await workspace.listQueue({
      actorUserId: session.staff.userId,
      conversationId: body.conversationId,
      limit: 10,
    });
    const item = items.find(
      (candidate) => candidate.sourceMessageId === body.sourceMessageId,
    ) ?? null;

    if (!item) {
      return response.status(202).json({
        ok: true,
        state: "draft_pending",
        code: null,
        item: null,
      });
    }

    return response.status(200).json({
      ok: true,
      state: "draft_ready",
      code: null,
      item,
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
    return response.status(safe.status).json({
      error: safe.message,
      code: safe.code,
    });
  }
}
