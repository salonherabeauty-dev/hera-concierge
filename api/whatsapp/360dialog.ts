import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getD360Config,
  getDatabaseConfig,
  getWhatsAppProviderConfig,
} from "../../src/config.js";
import { D360CoexistenceStore } from "../../src/db/coexistence.js";
import {
  ingestPreviewHumanReviewMessage,
  usePreviewHumanReviewIngest,
} from "../../src/db/previewHumanReviewIngest.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import {
  HERA_RECEPTIONIST_RESET_VERSION,
  useReceptionistResetV3,
} from "../../src/reset/boundary.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";
import { verifyBasicAuthorization } from "../../src/security/basicAuth.js";
import {
  PayloadTooLargeError,
  readRawBody,
} from "../../src/security/readRawBody.js";
import { parseD360Webhook } from "../../src/whatsapp/d360WebhookPayload.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../../src/worker.js";

const WEBHOOK_BACKLOG_RECOVERY_SLOTS = 2;
const INBOUND_BURST_SETTLE_MS = 9_000;

function secureHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function requestId(request: VercelRequest): string {
  const value = request.headers["x-vercel-id"];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate
    ? candidate.slice(0, 160)
    : randomUUID();
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function takeoverUntil(providerTimestamp: string, minutes: number): string {
  const parsed = Date.parse(providerTimestamp);
  const now = Date.now();
  const bounded = Number.isFinite(parsed)
    ? Math.min(parsed, now + 5 * 60 * 1000)
    : now;
  return new Date(bounded + minutes * 60 * 1000).toISOString();
}

function settleInboundBurst(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, INBOUND_BURST_SETTLE_MS);
  });
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const startedAt = Date.now();
  const correlationId = requestId(request);
  secureHeaders(response);

  if (getWhatsAppProviderConfig().provider !== "360dialog") {
    logOperationalEvent("warn", "d360_webhook_provider_disabled", {
      correlationId,
    });
    return response.status(404).json({ error: "Not found" });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  let d360: ReturnType<typeof getD360Config>;
  try {
    d360 = getD360Config();
  } catch (error) {
    logOperationalEvent("error", "d360_webhook_configuration_invalid", {
      correlationId,
      ...safeErrorFields(error),
    });
    return response.status(503).json({ error: "Webhook unavailable" });
  }

  const authorization = firstHeader(request.headers.authorization);
  if (
    !verifyBasicAuthorization(
      authorization,
      d360.webhookUsername,
      d360.webhookPassword,
    )
  ) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Hera 360dialog"');
    logOperationalEvent("warn", "d360_webhook_auth_rejected", {
      correlationId,
    });
    return response.status(401).json({ error: "Unauthorized" });
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(request, 1_000_000);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logOperationalEvent("warn", "d360_webhook_payload_too_large", {
        correlationId,
        maxBytes: error.maxBytes,
      });
      return response.status(413).json({ error: "Payload too large" });
    }
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    logOperationalEvent("warn", "d360_webhook_json_rejected", {
      correlationId,
      bodyBytes: rawBody.byteLength,
    });
    return response.status(400).json({ error: "Invalid JSON" });
  }

  let ingestionStage = "parse_payload";
  try {
    const parsed = parseD360Webhook(payload);
    ingestionStage = "load_database_config";
    const database = getDatabaseConfig();
    const repository = new SupabaseReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const coexistence = new D360CoexistenceStore(
      database.url,
      database.serviceRoleKey,
    );
    const resetV3 = useReceptionistResetV3();
    const resetRepository = resetV3
      ? new ResetReceptionistRepository(
          database.url,
          database.serviceRoleKey,
        )
      : null;
    const humanReviewDrafting = usePreviewHumanReviewIngest();

    let humanEchoesInserted = 0;
    ingestionStage = "ingest_human_echoes";
    for (const echo of parsed.humanEchoes) {
      const result = await coexistence.ingestHumanEcho(
        echo,
        takeoverUntil(echo.providerTimestamp, d360.humanTakeoverMinutes),
      );
      if (result.inserted) humanEchoesInserted += 1;
    }

    ingestionStage = "apply_delivery_statuses";
    for (const event of parsed.statuses) await repository.applyStatus(event);

    let inboundInserted = 0;
    const wakeableJobIds: string[] = [];
    const resetTurnIds = new Set<string>();
    ingestionStage = "ingest_inbound_messages";
    for (const message of parsed.inbound) {
      const result = humanReviewDrafting
        ? await ingestPreviewHumanReviewMessage({
            databaseUrl: database.url,
            serviceRoleKey: database.serviceRoleKey,
            message,
          })
        : await repository.ingestInbound(message);
      if (result.inserted) inboundInserted += 1;

      if (resetV3 && resetRepository && result.inserted) {
        const appended = await resetRepository.appendFragment({
          ingest: result,
          message,
        });
        resetTurnIds.add(appended.turnId);
      } else if (!resetV3 && result.jobId) {
        wakeableJobIds.push(result.jobId);
      }
    }

    if (parsed.ignored.history > 0 || parsed.ignored.appStateSync > 0) {
      ingestionStage = "audit_coexistence_events";
      await repository.audit(
        "d360_coexistence_non_message_event_recorded",
        "webhook",
        correlationId,
        {
          historyCount: parsed.ignored.history,
          appStateSyncCount: parsed.ignored.appStateSync,
        },
      );
    }

    ingestionStage = "schedule_background_drain";
    // Reset v3 is deliberately human-triggered. Inbound WhatsApp delivery only
    // records and consolidates the client turn; it must never spend on an AI
    // draft until a receptionist presses Generate AI Reply.
    if (!resetV3 && wakeableJobIds.length > 0) {
      const drainLimit = Math.min(
        Math.max(wakeableJobIds.length + WEBHOOK_BACKLOG_RECOVERY_SLOTS, 1),
        8,
      );
      waitUntil(
        settleInboundBurst()
          .then(() =>
            drainReceptionistForJobs(
              createProductionRuntime(),
              wakeableJobIds,
              drainLimit,
            ),
          )
          .then((summary) => {
            logOperationalEvent("info", "d360_webhook_background_drain_completed", {
              correlationId,
              burstSettleMs: INBOUND_BURST_SETTLE_MS,
              ...summary,
            });
          })
          .catch((error: unknown) => {
            logOperationalEvent("error", "d360_webhook_background_drain_failed", {
              correlationId,
              burstSettleMs: INBOUND_BURST_SETTLE_MS,
              ...safeErrorFields(error),
            });
          }),
      );
    }

    ingestionStage = "complete";
    logOperationalEvent("info", "d360_webhook_ingested", {
      correlationId,
      bodyBytes: rawBody.byteLength,
      inboundCount: parsed.inbound.length,
      inboundInserted,
      targetedJobCount: resetV3 ? resetTurnIds.size : wakeableJobIds.length,
      resetV3,
      resetVersion: resetV3 ? HERA_RECEPTIONIST_RESET_VERSION : null,
      humanReviewDrafting,
      burstSettleMs:
        resetV3
          ? 0
          : wakeableJobIds.length > 0
            ? INBOUND_BURST_SETTLE_MS
            : 0,
      statusCount: parsed.statuses.length,
      humanEchoCount: parsed.humanEchoes.length,
      humanEchoesInserted,
      ignoredHistoryCount: parsed.ignored.history,
      ignoredAppStateSyncCount: parsed.ignored.appStateSync,
      durationMs: Date.now() - startedAt,
    });

    return response.status(200).json({
      received: true,
      inbound: parsed.inbound.length,
      inserted: inboundInserted,
      statuses: parsed.statuses.length,
      humanEchoes: parsed.humanEchoes.length,
      humanEchoesInserted,
      resetV3,
      resetTurnCount: resetTurnIds.size,
      ignored: parsed.ignored,
    });
  } catch (error) {
    logOperationalEvent("error", "d360_webhook_ingestion_failed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      ingestionStage,
      ...safeErrorFields(error),
    });
    return response.status(500).json({ error: "Webhook ingestion failed" });
  }
}
