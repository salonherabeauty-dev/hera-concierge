import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateCommandCentre,
  requireCommandCentreCsrf,
} from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { requireReceptionistResetV3 } from "../../src/reset/boundary.js";
import { drainResetTurnJobs } from "../../src/reset/worker.js";

const RECOVERY_LIMIT = 2;

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

    waitUntil(
      drainResetTurnJobs({
        limit: RECOVERY_LIMIT,
        workerId: `reset-v3-session-recovery-${session.staff.userId}`,
      }),
    );

    return response.status(202).json({
      ok: true,
      state: "recovery_queued",
      recoveryLimit: RECOVERY_LIMIT,
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
