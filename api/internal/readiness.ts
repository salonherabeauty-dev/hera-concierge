import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getAiConfig,
  getD360Config,
  getDatabaseConfig,
  getMetaConfig,
  getOperationsConfig,
  getWebhookConfig,
  getWhatsAppProviderConfig,
} from "../../src/config.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { assessOperationalReadiness } from "../../src/observability/readiness.js";
import { verifyBearerToken } from "../../src/security/bearer.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  let operations: ReturnType<typeof getOperationsConfig>;
  try {
    operations = getOperationsConfig();
  } catch (error) {
    logOperationalEvent("error", "readiness_configuration_invalid", {
      correlationId,
      ...safeErrorFields(error),
    });
    return response.status(503).json({
      ok: false,
      readiness: "critical",
      reasons: ["configuration_invalid"],
    });
  }

  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!verifyBearerToken(authorization, operations.cronSecret)) {
    logOperationalEvent("warn", "readiness_unauthorized", { correlationId });
    return response.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Parse every required runtime group. Values are intentionally never returned
    // or logged; this proves presence and format, not provider connectivity.
    const database = getDatabaseConfig();
    const provider = getWhatsAppProviderConfig().provider;
    if (provider === "360dialog") {
      getD360Config();
    } else {
      getWebhookConfig();
      getMetaConfig();
    }
    getAiConfig();

    const repository = new SupabaseReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const snapshot = await repository.getOperationalSnapshot();
    const readiness = assessOperationalReadiness(snapshot);
    const durationMs = Date.now() - startedAt;
    const status = readiness.level === "critical" ? 503 : 200;

    logOperationalEvent(
      readiness.level === "critical" ? "error" : readiness.level === "attention" ? "warn" : "info",
      "readiness_checked",
      {
        correlationId,
        durationMs,
        provider,
        readiness: readiness.level,
        activeJobs: snapshot.activeJobs,
        deadJobs: snapshot.deadJobs,
        activeOutbox: snapshot.activeOutbox,
        deadOutbox: snapshot.deadOutbox,
        openIncidents: snapshot.openIncidents,
        blackIncidents: snapshot.blackIncidents,
      },
    );

    return response.status(status).json({
      ok: status === 200,
      checkedAt: new Date().toISOString(),
      provider,
      mode: operations.sendMode,
      readiness: readiness.level,
      cutoverEligible: readiness.cutoverEligible,
      reasons: readiness.reasons,
      queueAgeMs: {
        jobs: readiness.oldestJobAgeMs,
        outbox: readiness.oldestOutboxAgeMs,
      },
      counts: {
        activeJobs: snapshot.activeJobs,
        deadJobs: snapshot.deadJobs,
        activeOutbox: snapshot.activeOutbox,
        deadOutbox: snapshot.deadOutbox,
        openIncidents: snapshot.openIncidents,
        blackIncidents: snapshot.blackIncidents,
      },
    });
  } catch (error) {
    logOperationalEvent("error", "readiness_check_failed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ...safeErrorFields(error),
    });
    return response.status(503).json({
      ok: false,
      readiness: "critical",
      reasons: ["readiness_check_failed"],
    });
  }
}
