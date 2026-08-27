import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getDatabaseConfig,
  getWebhookConfig,
  getWhatsAppProviderConfig,
} from "../../src/config.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";
import { verifyMetaSignature } from "../../src/security/metaSignature.js";
import {
  PayloadTooLargeError,
  readRawBody,
} from "../../src/security/readRawBody.js";
import { parseWhatsAppWebhook } from "../../src/whatsapp/webhookPayload.js";
import {
  createProductionRuntime,
  drainReceptionistForJobs,
} from "../../src/worker.js";

const WEBHOOK_BACKLOG_RECOVERY_SLOTS = 2;

function firstQuery(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

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

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const startedAt = Date.now();
  const correlationId = requestId(request);
  secureHeaders(response);

  if (getWhatsAppProviderConfig().provider !== "meta") {
    logOperationalEvent("warn", "meta_webhook_provider_disabled", {
      correlationId,
    });
    return response.status(404).json({ error: "Not found" });
  }

  if (request.method === "GET") {
    const { verifyToken } = getWebhookConfig();
    const mode = firstQuery(request.query["hub.mode"]);
    const token = firstQuery(request.query["hub.verify_token"]);
    const challenge = firstQuery(request.query["hub.challenge"]);
    if (mode === "subscribe" && token === verifyToken && challenge) {
      logOperationalEvent("info", "webhook_verification_succeeded", {
        correlationId,
      });
      return response.status(200).send(challenge);
    }
    logOperationalEvent("warn", "webhook_verification_rejected", {
      correlationId,
    });
    return response.status(403).json({ error: "Webhook verification failed" });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { appSecret } = getWebhookConfig();
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(request, 1_000_000);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logOperationalEvent("warn", "webhook_payload_too_large", {
        correlationId,
        maxBytes: error.maxBytes,
      });
      return response.status(413).json({ error: "Payload too large" });
    }
    throw error;
  }
  if (!verifyMetaSignature(rawBody, request.headers["x-hub-signature-256"], appSecret)) {
    logOperationalEvent("warn", "webhook_signature_rejected", {
      correlationId,
      bodyBytes: rawBody.byteLength,
    });
    return response.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    logOperationalEvent("warn", "webhook_json_rejected", {
      correlationId,
      bodyBytes: rawBody.byteLength,
    });
    return response.status(400).json({ error: "Invalid JSON" });
  }

  const parsed = parseWhatsAppWebhook(payload);
  const database = getDatabaseConfig();
  const repository = new SupabaseReceptionistRepository(
    database.url,
    database.serviceRoleKey,
  );

  for (const event of parsed.statuses) await repository.applyStatus(event);
  let inserted = 0;
  const wakeableJobIds: string[] = [];
  for (const message of parsed.inbound) {
    const result = await repository.ingestInbound(message);
    if (result.inserted) inserted += 1;
    if (result.jobId) wakeableJobIds.push(result.jobId);
  }

  // A valid inbound delivery is also a safe wake-up signal for eligible retry
  // jobs. Meta's dashboard may resend the same fixed sample message during
  // Preview validation; ingestion remains idempotent, while the worker can
  // recover work that was deferred by a transient provider failure.
  if (wakeableJobIds.length > 0) {
    const drainLimit = Math.min(
      Math.max(wakeableJobIds.length + WEBHOOK_BACKLOG_RECOVERY_SLOTS, 1),
      8,
    );
    waitUntil(
      Promise.resolve()
        .then(() =>
          drainReceptionistForJobs(
            createProductionRuntime(),
            wakeableJobIds,
            drainLimit,
          ),
        )
        .then((summary) => {
          logOperationalEvent("info", "webhook_background_drain_completed", {
            correlationId,
            ...summary,
          });
        })
        .catch((error: unknown) => {
          logOperationalEvent("error", "webhook_background_drain_failed", {
            correlationId,
            ...safeErrorFields(error),
          });
        }),
    );
  }

  logOperationalEvent("info", "webhook_ingested", {
    correlationId,
    bodyBytes: rawBody.byteLength,
    inboundCount: parsed.inbound.length,
    insertedCount: inserted,
    targetedJobCount: wakeableJobIds.length,
    statusCount: parsed.statuses.length,
    durationMs: Date.now() - startedAt,
  });

  return response.status(200).json({
    received: true,
    inbound: parsed.inbound.length,
    inserted,
    statuses: parsed.statuses.length,
  });
}
