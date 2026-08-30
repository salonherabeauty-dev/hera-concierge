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
import { requireResetReceptionist } from "../../src/reset/config.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";
import {
  createResetWorkerRuntime,
  drainResetDrafts,
} from "../../src/reset/worker.js";

const bodySchema = z.object({
  turnId: z.string().uuid(),
  expectedCandidateHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
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
      !hasCapability(session.staff.role, "review_delivery") ||
      !hasCapability(session.staff.role, "control_conversation")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const parsed = bodySchema.safeParse(parseJsonBody<unknown>(request));
    if (!parsed.success) {
      const error = new Error("Regeneration request is invalid.");
      error.name = "CommandCentreValidationError";
      throw error;
    }

    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const result = await repository.requestRegeneration({
      actorUserId: session.staff.userId,
      turnId: parsed.data.turnId,
      expectedCandidateHash: parsed.data.expectedCandidateHash,
      expectedPhoneEnding: parsed.data.expectedPhoneEnding,
    });

    waitUntil(drainResetDrafts(createResetWorkerRuntime(), 1));
    return response.status(202).json({
      ...result,
      state: "pending",
      automaticDeliveryAllowed: false,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
