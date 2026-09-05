import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getOperationsConfig } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import {
  HERA_RECEPTIONIST_RESET_VERSION,
  useReceptionistResetV3,
} from "../../src/reset/boundary.js";
import { verifyBearerToken } from "../../src/security/bearer.js";
import { createProductionRuntime, drainReceptionist } from "../../src/worker.js";

const RECOVERY_DRAIN_LIMIT = 5;

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
    if (useReceptionistResetV3()) {
      // Manual-assist mode must never turn a scheduled recovery request into a
      // paid model call. Pending turns remain available for an explicit click.
      const summary = {
        jobsClaimed: 0,
        jobsReady: 0,
        jobsFailed: 0,
        jobsSuperseded: 0,
        providerSendCalls: 0 as const,
        timelyWriteCalls: 0 as const,
      };
      logOperationalEvent("info", "reset_v3_automatic_drain_suppressed", {
        correlationId,
        resetVersion: HERA_RECEPTIONIST_RESET_VERSION,
        durationMs: Date.now() - startedAt,
        ...summary,
      });
      return response.status(200).json({
        ok: true,
        resetV3: true,
        resetVersion: HERA_RECEPTIONIST_RESET_VERSION,
        ...summary,
      });
    }

    const summary = await drainReceptionist(
      createProductionRuntime(),
      RECOVERY_DRAIN_LIMIT,
    );
    logOperationalEvent("info", "recovery_drain_completed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ...summary,
    });
    return response.status(200).json({ ok: true, resetV3: false, ...summary });
  } catch (error) {
    logOperationalEvent("error", "recovery_drain_failed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      resetV3: useReceptionistResetV3(),
      ...safeErrorFields(error),
    });
    return response.status(500).json({ error: "Drain failed" });
  }
}
