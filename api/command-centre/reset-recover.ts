import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { requireReceptionistResetV3 } from "../../src/reset/boundary.js";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") {
    return methodNotAllowed(response, ["POST"]);
  }

  requireReceptionistResetV3();
  return response.status(410).json({
    error: "Automatic AI recovery is disabled. Use Generate AI Reply.",
    code: "automatic_generation_disabled",
  });
}
