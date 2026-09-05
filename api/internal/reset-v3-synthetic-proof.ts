import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { requireReceptionistResetV3 } from "../../src/reset/boundary.js";

/**
 * Historical connectivity proof endpoint.
 *
 * Manual-assist mode permits paid Reset-v3 generation only through an
 * authenticated, same-origin staff action. Keeping this endpoint as an
 * explicit tombstone prevents an old URL from ever initiating a model call.
 */
export default function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);

  try {
    requireReceptionistResetV3();
    return response.status(410).json({
      ok: false,
      code: "synthetic_generation_disabled",
      error: "Synthetic AI generation is disabled. Staff must use Generate AI Reply.",
    });
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : 403;
    return response.status(status).json({
      ok: false,
      code: "receptionist_reset_preview_required",
    });
  }
}
