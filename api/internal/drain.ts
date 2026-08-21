import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getOperationsConfig } from "../../src/config.js";
import { verifyBearerToken } from "../../src/security/bearer.js";
import { createProductionRuntime, drainReceptionist } from "../../src/worker.js";

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

  const summary = await drainReceptionist(createProductionRuntime(), 12);
  return response.status(200).json({ ok: true, ...summary });
}
