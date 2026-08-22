import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getDatabaseConfig,
  getKnowledgeSyncConfig,
  getOperationsConfig,
} from "../../src/config.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import { syncHeraWebsiteKnowledge } from "../../src/knowledge/website.js";
import { verifyBearerToken } from "../../src/security/bearer.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { cronSecret } = getOperationsConfig();
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!verifyBearerToken(authorization, cronSecret)) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const database = getDatabaseConfig();
  const knowledge = getKnowledgeSyncConfig();
  const repository = new SupabaseReceptionistRepository(
    database.url,
    database.serviceRoleKey,
  );
  const summary = await syncHeraWebsiteKnowledge({
    repository,
    sitemapUrl: knowledge.sitemapUrl,
    autoApprove: knowledge.autoApprove,
  });
  return response.status(200).json({ ok: true, autoApprove: knowledge.autoApprove, ...summary });
}
