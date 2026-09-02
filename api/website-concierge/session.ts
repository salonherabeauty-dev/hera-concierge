import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig } from "../../src/config.js";
import {
  requireWebsiteConciergePreview,
  WEBSITE_CONCIERGE_VERSION,
} from "../../src/website-concierge/boundary.js";
import {
  applyWebsiteConciergeHeaders,
  requireAllowedWebsiteOrigin,
  safeWebsiteError,
} from "../../src/website-concierge/http.js";
import { WebsiteConciergeRepository } from "../../src/website-concierge/repository.js";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const origin = applyWebsiteConciergeHeaders(request, response);
  if (request.method === "OPTIONS") {
    return response.status(origin ? 204 : 403).end();
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    requireWebsiteConciergePreview();
    requireAllowedWebsiteOrigin(request);
    const database = getDatabaseConfig();
    const repository = new WebsiteConciergeRepository(
      database.url,
      database.serviceRoleKey,
    );
    const credential = await repository.createSession();
    return response.status(201).json({
      ok: true,
      version: WEBSITE_CONCIERGE_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ...credential,
      automaticWhatsAppSendAllowed: false,
      timelyWriteAllowed: false,
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
