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
import { requireResetReceptionist } from "../../src/reset/config.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";

const bodySchema = z.object({
  draftRunId: z.string().uuid(),
  expectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPhoneEnding: z.string().regex(/^[0-9]{4}$/),
});

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
    if (
      !hasCapability(session.staff.role, "reject_delivery") ||
      !hasCapability(session.staff.role, "control_conversation")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const parsed = bodySchema.safeParse(parseJsonBody<unknown>(request));
    if (!parsed.success) {
      const error = new Error("Hold request is invalid.");
      error.name = "CommandCentreValidationError";
      throw error;
    }

    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const result = await repository.holdCandidate({
      actorUserId: session.staff.userId,
      draftRunId: parsed.data.draftRunId,
      expectedCandidateHash: parsed.data.expectedCandidateHash,
      expectedPhoneEnding: parsed.data.expectedPhoneEnding,
    });

    return response.status(200).json({
      ...result,
      automaticDraftingForFutureTurns: true,
      automaticDeliveryAllowed: false,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
