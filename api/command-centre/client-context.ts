import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import { createFrontDeskRepository } from "../../src/command-centre/frontDeskRepository.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";

function queryId(request: VercelRequest): string | null {
  const value = Array.isArray(request.query.id)
    ? request.query.id[0]
    : request.query.id;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const id = queryId(request);
    if (!id) {
      return response.status(400).json({ error: "Conversation id is required." });
    }
    const repository = createFrontDeskRepository();
    return response.status(200).json({
      bookings: await repository.getBookingContext(id),
      authority: "Timely must be checked before any booking outcome is confirmed.",
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
