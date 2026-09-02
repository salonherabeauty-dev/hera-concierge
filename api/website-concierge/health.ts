import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  requireWebsiteConciergePreview,
  WEBSITE_CONCIERGE_VERSION,
} from "../../src/website-concierge/boundary.js";
import {
  WEBSITE_CONCIERGE_MAX_MODEL_CALLS,
  WEBSITE_CONCIERGE_MODEL_ID,
  WEBSITE_CONCIERGE_REASONING_EFFORT,
} from "../../src/website-concierge/engine.js";
import {
  applyWebsiteConciergeHeaders,
  safeWebsiteError,
} from "../../src/website-concierge/http.js";

export default function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  applyWebsiteConciergeHeaders(request, response);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }
  try {
    requireWebsiteConciergePreview();
    return response.status(200).json({
      ok: true,
      version: WEBSITE_CONCIERGE_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      modelId: WEBSITE_CONCIERGE_MODEL_ID,
      reasoningEffort: WEBSITE_CONCIERGE_REASONING_EFFORT,
      maximumContentCalls: WEBSITE_CONCIERGE_MAX_MODEL_CALLS,
      supportsTanglin: true,
      supportsSentosa: true,
      sessionsSeparatedFromWhatsApp: true,
      automaticWhatsAppSendAllowed: false,
      timelyWriteAllowed: false,
      liveWebsiteModified: false,
    });
  } catch (error) {
    const safe = safeWebsiteError(error);
    return response.status(safe.status).json({
      ok: false,
      code: safe.code,
      error: safe.message,
    });
  }
}
