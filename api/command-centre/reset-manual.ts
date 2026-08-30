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
  turnId: z.string().uuid(),
  expectedPhoneEnding: z.string().regex(/^[0-9]{4}$/),
  messageText: z.string().trim().min(1).max(4000),
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
      !hasCapability(session.staff.role, "approve_delivery")
    ) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const parsed = bodySchema.safeParse(parseJsonBody<unknown>(request));
    if (!parsed.success) {
      const error = new Error("Manual reply is invalid.");
      error.name = "CommandCentreValidationError";
      throw error;
    }

    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const result = await repository.createManualCandidate({
      actorUserId: session.staff.userId,
      turnId: parsed.data.turnId,
      expectedPhoneEnding: parsed.data.expectedPhoneEnding,
      messageText: parsed.data.messageText,
    });

    return response.status(200).json({
      ...result,
      state: "ready",
      origin: "human_manual",
      automaticDeliveryAllowed: false,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
