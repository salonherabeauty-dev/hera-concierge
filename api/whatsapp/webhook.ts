import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatabaseConfig, getWebhookConfig } from "../../src/config.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import { verifyMetaSignature } from "../../src/security/metaSignature.js";
import { readRawBody } from "../../src/security/readRawBody.js";
import { parseWhatsAppWebhook } from "../../src/whatsapp/webhookPayload.js";
import { createProductionRuntime, drainReceptionist } from "../../src/worker.js";

function firstQuery(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function secureHeaders(response: VercelResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureHeaders(response);

  if (request.method === "GET") {
    const { verifyToken } = getWebhookConfig();
    const mode = firstQuery(request.query["hub.mode"]);
    const token = firstQuery(request.query["hub.verify_token"]);
    const challenge = firstQuery(request.query["hub.challenge"]);
    if (mode === "subscribe" && token === verifyToken && challenge) {
      return response.status(200).send(challenge);
    }
    return response.status(403).json({ error: "Webhook verification failed" });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { appSecret } = getWebhookConfig();
  const rawBody = await readRawBody(request, 1_000_000);
  if (!verifyMetaSignature(rawBody, request.headers["x-hub-signature-256"], appSecret)) {
    return response.status(401).json({ error: "Invalid webhook signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
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
  for (const message of parsed.inbound) {
    const result = await repository.ingestInbound(message);
    if (result.inserted) inserted += 1;
  }

  if (inserted > 0) {
    waitUntil(
      drainReceptionist(createProductionRuntime(), Math.min(inserted, 8)).catch(
        (error: unknown) => {
          console.error(
            "Hera receptionist background drain failed",
            error instanceof Error ? error.message : "unknown error",
          );
        },
      ),
    );
  }

  return response.status(200).json({
    received: true,
    inbound: parsed.inbound.length,
    inserted,
    statuses: parsed.statuses.length,
  });
}
