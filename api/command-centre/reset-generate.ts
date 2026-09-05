import { waitUntil } from "@vercel/functions";
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
import { getDatabaseConfig } from "../../src/config.js";
import { requireReceptionistResetV3 } from "../../src/reset/boundary.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";
import { drainResetTurnJobs } from "../../src/reset/worker.js";

const requestSchema = z.object({
  turnId: z.string().uuid(),
});

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
    if (
      !hasCapability(session.staff.role, "view_conversations") ||
      !hasCapability(session.staff.role, "review_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const { turnId } = requestSchema.parse(parseJsonBody<unknown>(request));
    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const state = await repository.getGenerationRequestState(turnId);
    if (!state) {
      return response.status(404).json({
        error: "This client message is no longer available for drafting.",
        code: "turn_not_found",
      });
    }
    if (
      state.turnStatus !== "collecting" ||
      state.jobStatus !== "pending" ||
      state.turnModelAttempts !== 0 ||
      state.jobModelAttempts !== 0
    ) {
      return response.status(409).json({
        error: "This client message is already being processed or has a draft.",
        code: "generation_not_available",
      });
    }
    const readyAt = Math.max(
      Date.parse(state.settleAt),
      Date.parse(state.availableAt),
    );
    if (!Number.isFinite(readyAt) || readyAt > Date.now()) {
      return response.status(409).json({
        error: "Please wait a few seconds for the client’s messages to finish arriving.",
        code: "turn_still_collecting",
      });
    }

    waitUntil(
      drainResetTurnJobs({
        turnIds: [turnId],
        limit: 1,
        workerId: `reset-v3-human-generate-${session.staff.userId}`,
      }),
    );

    return response.status(202).json({
      ok: true,
      state: "processing",
      turnId,
      initiatedByHuman: true,
      automaticDeliveryAllowed: false,
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
