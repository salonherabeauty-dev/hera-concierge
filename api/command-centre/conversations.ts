import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { SupabaseCommandCentreRepository } from "../../src/command-centre/repository.js";
import type { RiskLevel } from "../../src/types.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const modeValue = Array.isArray(request.query.mode) ? request.query.mode[0] : request.query.mode;
    const riskValue = Array.isArray(request.query.risk) ? request.query.risk[0] : request.query.risk;
    const searchValue = Array.isArray(request.query.search) ? request.query.search[0] : request.query.search;
    const repository = new SupabaseCommandCentreRepository();
    const conversations = await repository.listConversations({
      mode: modeValue === "management" ? "management" : modeValue === "ai" ? "ai" : null,
      risk:
        riskValue === "green" || riskValue === "amber" || riskValue === "red" || riskValue === "black"
          ? (riskValue as RiskLevel)
          : null,
      search: typeof searchValue === "string" ? searchValue.slice(0, 120) : null,
      limit: 120,
    });
    return response.status(200).json({ conversations });
  } catch (error) {
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
