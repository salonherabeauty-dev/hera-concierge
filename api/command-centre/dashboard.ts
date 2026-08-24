import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getOperationsConfig } from "../../src/config.js";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { SupabaseCommandCentreRepository } from "../../src/command-centre/repository.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_dashboard")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const repository = new SupabaseCommandCentreRepository();
    const dashboard = await repository.dashboard(getOperationsConfig().sendMode);
    return response.status(200).json({ dashboard });
  } catch (error) {
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
