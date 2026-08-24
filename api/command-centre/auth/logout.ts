import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateCommandCentre,
  clearCommandCentreSession,
  commandCentreAdminClient,
  requireCommandCentreCsrf,
} from "../../../src/command-centre/auth.js";
import {
  methodNotAllowed,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../../src/command-centre/http.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  try {
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    const session = await authenticateCommandCentre(request, response);
    const database = commandCentreAdminClient();
    await database.from("ai_audit_log").insert({
      actor_type: "management",
      actor_id: session.staff.userId,
      event_type: "command_centre_logout",
      target_type: "staff_session",
      target_id: session.staff.userId,
      details: {},
    });
  } catch {
    // Logout remains idempotent and always clears browser credentials.
  }
  clearCommandCentreSession(response);
  return response.status(200).json({ ok: true });
}
