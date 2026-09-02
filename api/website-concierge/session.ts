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

function databaseProjectRef(): string | null {
  try {
    const raw = process.env.SUPABASE_URL?.trim();
    if (!raw) return null;
    return new URL(raw).hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

function safeDiagnostic(error: unknown): {
  name: string;
  code: string | null;
  message: string;
} {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const rawMessage =
    typeof candidate?.message === "string"
      ? candidate.message
      : String(error);
  return {
    name:
      typeof candidate?.name === "string"
        ? candidate.name.slice(0, 100)
        : "UnknownError",
    code:
      typeof candidate?.code === "string"
        ? candidate.code.slice(0, 80)
        : null,
    message: rawMessage
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500),
  };
}

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
    console.error(
      "WEBSITE_CONCIERGE_SESSION_FAILURE",
      JSON.stringify({
        ...safeDiagnostic(error),
        databaseProjectRef: databaseProjectRef(),
        environment: process.env.VERCEL_ENV ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      }),
    );
    const safe = safeWebsiteError(error);
    return response.status(safe.status).json({
      ok: false,
      code: safe.code,
      error: safe.message,
    });
  }
}
