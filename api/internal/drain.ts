import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getOperationsConfig } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { verifyBearerToken } from "../../src/security/bearer.js";
import { createProductionRuntime, drainReceptionist } from "../../src/worker.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const correlationId = randomUUID();
  const startedAt = Date.now();
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
    logOperationalEvent("warn", "recovery_drain_unauthorized", { correlationId });
    return response.status(401).json({ error: "Unauthorized" });
  }

  try {
    const summary = await drainReceptionist(createProductionRuntime(), 12);
    logOperationalEvent("info", "recovery_drain_completed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ...summary,
    });
    return response.status(200).json({ ok: true, ...summary });
  } catch (error) {
    logOperationalEvent("error", "recovery_drain_failed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ...safeErrorFields(error),
    });
    return response.status(500).json({ error: "Drain failed" });
  }
}
