import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateCommandCentre } from "../../../src/command-centre/auth.js";
import {
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../../src/command-centre/http.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    return response.status(200).json({
      authenticated: true,
      staff: session.staff,
      csrfToken: session.csrfToken,
    });
  } catch {
    return response.status(401).json({ authenticated: false });
  }
}
