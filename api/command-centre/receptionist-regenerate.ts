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
  receptionistWorkspaceBoundary,
  requireReceptionistWorkspacePreview,
} from "../../src/command-centre/receptionistWorkspaceBoundary.js";
import { ReceptionistWorkspaceRepository } from "../../src/command-centre/receptionistWorkspaceRepository.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../../src/worker.js";
import { useReceptionistResetV3 } from "../../src/reset/boundary.js";

const requestSchema = z.object({
  candidateId: z.string().uuid(),
  expectedSourceMessageId: z.string().uuid(),
  expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPhoneEnding: z.string().regex(/^[0-9]{4}$/),
});

function parseRequest(value: unknown): z.infer<typeof requestSchema> {
  const result = requestSchema.safeParse(value);
  if (!result.success) {
    const error = new Error("Regeneration request validation failed");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return result.data;
}

function blockedStatus(code: string | null): number {
  if (code === "candidate_not_found") return 404;
  if (
    code === "inactive_staff" ||
    code === "role_not_authorized"
  ) {
    return 403;
  }
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


  if (useReceptionistResetV3()) {
    return response.status(410).json({
      error: "Use the Reception Desk regeneration control.",
      code: "legacy_generation_disabled",
    });
  }

  try {
    requireReceptionistWorkspacePreview(
      receptionistWorkspaceBoundary(),
    );
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);

    if (
      !hasCapability(session.staff.role, "review_delivery") ||
      !hasCapability(session.staff.role, "approve_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const body = parseRequest(parseJsonBody<unknown>(request));
    const repository = new ReceptionistWorkspaceRepository();
    const requested = await repository.requestRegeneration({
      actorUserId: session.staff.userId,
      candidateId: body.candidateId,
      expectedSourceMessageId: body.expectedSourceMessageId,
      expectedCandidateHash: body.expectedCandidateHash,
      expectedPhoneEnding: body.expectedPhoneEnding,
    });

    if (
      !requested.ok ||
      !requested.jobId ||
      !requested.conversationId ||
      !requested.sourceMessageId
    ) {
      return response
        .status(blockedStatus(requested.code))
        .json(requested);
    }

    const runtime = createProductionRuntime();
    if (runtime.sendMode !== "shadow") {
      return response.status(403).json({
        error: "Regeneration is restricted to shadow-locked staging.",
        code: "receptionist_preview_required",
      });
    }

    await drainReceptionistForJobs(runtime, [requested.jobId], 1);

    const items = await repository.listQueue({
      actorUserId: session.staff.userId,
      conversationId: requested.conversationId,
      limit: 10,
    });
    const replacement = items.find(
      (item) =>
        item.sourceMessageId === requested.sourceMessageId &&
        item.candidateId !== body.candidateId,
    );

    if (!replacement) {
      const recovery = await repository.recoverRegeneration({
        actorUserId: session.staff.userId,
        jobId: requested.jobId,
        reason: "Regeneration did not produce a replacement candidate.",
      });

      if (recovery.state === "original_restored") {
        const restoredItems = await repository.listQueue({
          actorUserId: session.staff.userId,
          conversationId: requested.conversationId,
          limit: 10,
        });
        const restored = restoredItems.find(
          (item) => item.candidateId === body.candidateId,
        ) ?? null;
        return response.status(200).json({
          ok: true,
          state: "original_restored",
          code: recovery.code,
          candidateId: body.candidateId,
          conversationId: requested.conversationId,
          sourceMessageId: requested.sourceMessageId,
          jobId: requested.jobId,
          item: restored,
        });
      }

      return response.status(202).json({
        ok: true,
        state: "regeneration_pending",
        code: recovery.code,
        candidateId: body.candidateId,
        conversationId: requested.conversationId,
        sourceMessageId: requested.sourceMessageId,
        jobId: requested.jobId,
        item: null,
      });
    }

    return response.status(200).json({
      ok: true,
      state: "regenerated",
      code: null,
      candidateId: replacement.candidateId,
      conversationId: replacement.conversationId,
      sourceMessageId: replacement.sourceMessageId,
      jobId: requested.jobId,
      item: replacement,
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
