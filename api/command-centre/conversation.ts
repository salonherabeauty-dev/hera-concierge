import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateCommandCentre,
  requireCommandCentreCsrf,
} from "../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  parseJsonBody,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { SupabaseCommandCentreRepository } from "../../src/command-centre/repository.js";
import {
  conversationActionBodySchema,
  parseSchema,
} from "../../src/command-centre/validation.js";

function queryId(request: VercelRequest): string | null {
  const value = Array.isArray(request.query.id) ? request.query.id[0] : request.query.id;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(response, ["GET", "POST"]);
  }
  try {
    const session = await authenticateCommandCentre(request, response);
    const repository = new SupabaseCommandCentreRepository();
    if (request.method === "GET") {
      if (!hasCapability(session.staff.role, "view_conversations")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      const id = queryId(request);
      if (!id) return response.status(400).json({ error: "Conversation id is required." });
      return response.status(200).json({ detail: await repository.getConversation(id) });
    }

    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    const body = parseSchema(conversationActionBodySchema, parseJsonBody<unknown>(request));

    if (body.action === "add_note") {
      if (!hasCapability(session.staff.role, "add_note")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      const result = await repository.addNote({
        conversationId: body.conversationId,
        taskId: body.taskId,
        actorUserId: session.staff.userId,
        body: body.note,
      });
      return response.status(201).json({ result });
    }

    if (!hasCapability(session.staff.role, "control_conversation")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const result = await repository.setConversationMode({
      conversationId: body.conversationId,
      actorUserId: session.staff.userId,
      mode: body.action === "takeover" ? "management" : "ai",
      reason: body.reason,
      takeoverUntil: body.action === "takeover" ? body.takeoverUntil : null,
    });
    return response.status(200).json({ result });
  } catch (error) {
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
