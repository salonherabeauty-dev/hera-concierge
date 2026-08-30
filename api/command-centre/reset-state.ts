import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { getDatabaseConfig } from "../../src/config.js";
import {
  HERA_RESET_ARCHITECTURE_VERSION,
  requireResetReceptionist,
} from "../../src/reset/config.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";

const conversationIdSchema = z.string().uuid();

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);

  try {
    requireResetReceptionist();
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const raw = Array.isArray(request.query.conversationId)
      ? request.query.conversationId[0]
      : request.query.conversationId;
    const parsed = conversationIdSchema.safeParse(raw);
    if (!parsed.success) {
      const error = new Error("Conversation id is invalid.");
      error.name = "CommandCentreValidationError";
      throw error;
    }

    const database = getDatabaseConfig();
    const repository = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const state = await repository.getState(parsed.data);

    return response.status(200).json({
      architecture: HERA_RESET_ARCHITECTURE_VERSION,
      deliveryControl: "human_only",
      automaticDeliveryAllowed: false,
      state,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
