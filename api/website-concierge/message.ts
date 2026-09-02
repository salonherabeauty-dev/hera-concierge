import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { getDatabaseConfig } from "../../src/config.js";
import { SupabaseReceptionistRepository } from "../../src/db/repository.js";
import {
  requireWebsiteConciergePreview,
  WEBSITE_CONCIERGE_VERSION,
} from "../../src/website-concierge/boundary.js";
import { buildWebsiteConciergeEvidence } from "../../src/website-concierge/evidence.js";
import { generateWebsiteConciergeReply } from "../../src/website-concierge/engine.js";
import {
  applyWebsiteConciergeHeaders,
  requireAllowedWebsiteOrigin,
  safeWebsiteError,
  writeSse,
} from "../../src/website-concierge/http.js";
import { WebsiteConciergeRepository } from "../../src/website-concierge/repository.js";

const requestSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().trim().min(1).max(2000),
});

function parseBody(request: VercelRequest): unknown {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body);
  return null;
}

function sessionToken(request: VercelRequest): string {
  const raw = request.headers["x-hera-website-session"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length < 20 || value.length > 200) {
    const error = new Error("Website concierge session token is missing.");
    error.name = "WebsiteConciergeAuthenticationError";
    throw error;
  }
  return value;
}

function replyChunks(reply: string): string[] {
  const words = reply.split(/(\s+)/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length > 90 && current) {
      chunks.push(current);
      current = word;
    } else {
      current += word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

  let sseStarted = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  try {
    requireWebsiteConciergePreview();
    requireAllowedWebsiteOrigin(request);
    const body = requestSchema.parse(parseBody(request));
    const token = sessionToken(request);
    const database = getDatabaseConfig();
    const repository = new WebsiteConciergeRepository(
      database.url,
      database.serviceRoleKey,
    );
    const session = await repository.authenticateAndConsume({
      sessionId: body.sessionId,
      sessionToken: token,
      inputCharacters: body.message.length,
    });
    const history = await repository.loadHistory(body.sessionId, 12);
    const visitorMessageId = await repository.appendVisitorMessage({
      sessionId: body.sessionId,
      body: body.message,
      outlet: session.outletPreference,
    });

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    sseStarted = true;
    writeSse(response, "status", {
      stage: "retrieving",
      message: "Checking Hera’s approved service and stylist information…",
    });
    keepAlive = setInterval(() => response.write(": keepalive\n\n"), 12_000);

    const knowledgeRepository = new SupabaseReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const evidence = await buildWebsiteConciergeEvidence({
      repository: knowledgeRepository,
      message: body.message,
      history,
      previousOutlet: session.outletPreference,
    });
    writeSse(response, "status", {
      stage: "composing",
      message: "Preparing your personalised Hera answer…",
    });

    const result = await generateWebsiteConciergeReply({ evidence });
    const replyId = await repository.appendConciergeMessage({
      sessionId: body.sessionId,
      replyToMessageId: visitorMessageId,
      result,
    });

    writeSse(response, "meta", {
      version: WEBSITE_CONCIERGE_VERSION,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      replyId,
      modelId: result.modelId,
      modelAttempts: result.modelAttempts,
      outlet: result.decision.resolvedOutlet,
      needsOutletClarification: result.decision.needsOutletClarification,
    });
    for (const chunk of replyChunks(result.reply)) {
      writeSse(response, "delta", { text: chunk });
    }
    writeSse(response, "actions", {
      items: result.decision.suggestedActions,
      contacts: result.evidence.contactOptions,
    });
    writeSse(response, "done", {
      ok: true,
      automaticWhatsAppSendAllowed: false,
      timelyWriteAllowed: false,
    });
    response.end();
  } catch (error) {
    const safe = safeWebsiteError(error);
    if (sseStarted) {
      writeSse(response, "error", {
        ok: false,
        code: safe.code,
        message: safe.message,
      });
      response.end();
    } else {
      response.status(safe.status).json({
        ok: false,
        code: safe.code,
        error: safe.message,
      });
    }
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }
}
