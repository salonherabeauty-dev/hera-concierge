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

function retryBlockedMessage(code: string | null): string {
  if (code === "retry_limit_reached") {
    return "The single AI retry has already been used. Please write the reply manually.";
  }
  if (code === "turn_not_retryable") {
    return "This reply is already being prepared or has been superseded by a newer client message.";
  }
  return "This AI reply cannot be retried in its current state.";
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
    if (
      !hasCapability(session.staff.role, "view_conversations") ||
      !hasCapability(session.staff.role, "review_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const body = requestSchema.parse(parseJsonBody<unknown>(request));
    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const retry = await repository.retryTurn(body.turnId);
    if (!retry.ok) {
      return response.status(409).json({
        ...retry,
        error: retryBlockedMessage(retry.code),
      });
    }

    waitUntil(
      drainResetTurnJobs({
        turnIds: [body.turnId],
        limit: 1,
        workerId: `reset-v3-human-retry-${session.staff.userId}`,
      }),
    );

    return response.status(202).json({
      ok: true,
      state: "processing",
      turnId: body.turnId,
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
