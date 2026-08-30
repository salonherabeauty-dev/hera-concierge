import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import { createFrontDeskRepository } from "../../src/command-centre/frontDeskRepository.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { getDatabaseConfig } from "../../src/config.js";
import {
  HERA_RESET_ARCHITECTURE_VERSION,
  requireResetReceptionist,
} from "../../src/reset/config.js";
import { ResetReceptionistRepository } from "../../src/reset/repository.js";

function conversationLimit(request: VercelRequest): number {
  const value = Array.isArray(request.query.limit)
    ? request.query.limit[0]
    : request.query.limit;
  if (value === undefined) return 250;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    const error = new Error("Conversation limit is invalid.");
    error.name = "CommandCentreValidationError";
    throw error;
  }
  return Math.max(1, Math.min(Number(value), 300));
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);

  try {
    requireResetReceptionist();
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }

    const searchValue = Array.isArray(request.query.search)
      ? request.query.search[0]
      : request.query.search;
    const search = typeof searchValue === "string" ? searchValue.slice(0, 120) : null;
    const frontDesk = createFrontDeskRepository();
    const conversations = await frontDesk.listConversations({
      search,
      limit: conversationLimit(request),
    });

    const database = getDatabaseConfig();
    const reset = new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    );
    const states = await reset.listStates(
      conversations.map((conversation) => conversation.id),
    );
    const stateByConversation = new Map(
      states.map((state) => [state.conversationId, state]),
    );

    const items = conversations
      .map((conversation) => ({
        ...conversation,
        reset: stateByConversation.get(conversation.id) ?? {
          conversationId: conversation.id,
          turn: null,
          draft: null,
        },
        replyOwed: conversation.lastMessageDirection === "inbound",
        deliveryControl: "human_only" as const,
      }))
      .sort(
        (left, right) =>
          Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt),
      );

    const commit = process.env.VERCEL_GIT_COMMIT_SHA?.trim() || "local";
    const branch = process.env.VERCEL_GIT_COMMIT_REF?.trim() || "local";

    return response.status(200).json({
      architecture: HERA_RESET_ARCHITECTURE_VERSION,
      deployment: {
        commit,
        shortCommit: commit === "local" ? "local" : commit.slice(0, 8),
        branch,
        environment: process.env.VERCEL_ENV?.trim() || "local",
      },
      deliveryControl: "human_only",
      automaticDeliveryAllowed: false,
      conversations: items,
      count: items.length,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
