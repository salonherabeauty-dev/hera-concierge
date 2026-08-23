import { randomUUID } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig, getOperationsConfig } from "../../src/config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { SupabaseShadowQualityRepository } from "../../src/quality/repository.js";
import {
  SHADOW_RUBRIC_VERSION,
  shadowSince,
} from "../../src/quality/shadow.js";
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
    logOperationalEvent("error", "shadow_quality_configuration_invalid", {
      correlationId,
      ...safeErrorFields(error),
    });
    return response.status(503).json({
      ok: false,
      reasons: ["configuration_invalid"],
    });
  }

  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!verifyBearerToken(authorization, operations.cronSecret)) {
    logOperationalEvent("warn", "shadow_quality_unauthorized", { correlationId });
    return response.status(401).json({ error: "Unauthorized" });
  }

  let since: string;
  try {
    since = shadowSince(request.query.since);
  } catch {
    return response.status(400).json({ error: "Invalid since parameter" });
  }

  try {
    const database = getDatabaseConfig();
    const repository = new SupabaseShadowQualityRepository(
      database.url,
      database.serviceRoleKey,
    );
    const quality = await repository.snapshot(since);
    const durationMs = Date.now() - startedAt;

    logOperationalEvent(
      quality.failCases > 0 || quality.criticalFlagCases > 0 ? "warn" : "info",
      "shadow_quality_checked",
      {
        correlationId,
        durationMs,
        eligibleCases: quality.eligibleCases,
        humanReviewedCases: quality.humanReviewedCases,
        launchMetricCases: quality.launchMetricCases,
        failCases: quality.failCases,
        needsReviewCases: quality.needsReviewCases,
        providerSendCount: quality.providerSendCount,
        duplicateCandidateCases: quality.duplicateCandidateCases,
      },
    );

    return response.status(200).json({
      ok: true,
      checkedAt: new Date().toISOString(),
      mode: operations.sendMode,
      rubricVersion: SHADOW_RUBRIC_VERSION,
      quality,
    });
  } catch (error) {
    logOperationalEvent("error", "shadow_quality_check_failed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ...safeErrorFields(error),
    });
    return response.status(503).json({
      ok: false,
      reasons: ["shadow_quality_check_failed"],
    });
  }
}
