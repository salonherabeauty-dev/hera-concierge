import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateCommandCentre } from "../../src/command-centre/auth.js";
import { createFrontDeskRepository } from "../../src/command-centre/frontDeskRepository.js";
import {
  clientSafeError,
  methodNotAllowed,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { ReceptionistWorkspaceRepository } from "../../src/command-centre/receptionistWorkspaceRepository.js";
import type { ConversationSummary } from "../../src/command-centre/types.js";
import type { RiskLevel } from "../../src/types.js";

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

function normalizeExpiredHumanHandling(
  conversation: ConversationSummary,
  now = Date.now(),
): ConversationSummary {
  if (
    conversation.operatingMode !== "management" ||
    !conversation.humanTakeoverUntil
  ) {
    return conversation;
  }
  const until = Date.parse(conversation.humanTakeoverUntil);
  if (!Number.isFinite(until) || until > now) return conversation;
  return {
    ...conversation,
    operatingMode: "ai",
    humanTakeoverUntil: null,
  };
}

function exposeReviewableDraft(
  conversation: ConversationSummary,
  reviewableConversationIds: ReadonlySet<string>,
): ConversationSummary {
  if (!reviewableConversationIds.has(conversation.id)) return conversation;

  // A human-controlled complaint may still have a fully verified AI draft that
  // the receptionist must review, edit and send. It belongs in Needs Reply,
  // not hidden in On Hold. This is a presentation normalization only; the
  // durable database conversation mode and all human-approval guards remain
  // unchanged.
  return {
    ...conversation,
    operatingMode: "ai",
  };
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    if (!hasCapability(session.staff.role, "view_conversations")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const modeValue = Array.isArray(request.query.mode)
      ? request.query.mode[0]
      : request.query.mode;
    const riskValue = Array.isArray(request.query.risk)
      ? request.query.risk[0]
      : request.query.risk;
    const searchValue = Array.isArray(request.query.search)
      ? request.query.search[0]
      : request.query.search;

    const repository = createFrontDeskRepository();
    const workspace = new ReceptionistWorkspaceRepository();
    const [rawConversations, reviewableDrafts] = await Promise.all([
      repository.listConversations({
        mode:
          modeValue === "management"
            ? "management"
            : modeValue === "ai"
              ? "ai"
              : null,
        risk:
          riskValue === "green" ||
          riskValue === "amber" ||
          riskValue === "red" ||
          riskValue === "black"
            ? (riskValue as RiskLevel)
            : null,
        search:
          typeof searchValue === "string" ? searchValue.slice(0, 120) : null,
        limit: conversationLimit(request),
      }),
      workspace.listQueue({
        actorUserId: session.staff.userId,
        limit: 100,
      }),
    ]);

    const reviewableConversationIds = new Set(
      reviewableDrafts.map((item) => item.conversationId),
    );
    const conversations = rawConversations
      .map((conversation) => normalizeExpiredHumanHandling(conversation))
      .map((conversation) =>
        exposeReviewableDraft(conversation, reviewableConversationIds),
      );

    return response.status(200).json({
      conversations,
      count: conversations.length,
    });
  } catch (error) {
    const safe = clientSafeError(error);
    return response
      .status(safe.status)
      .json({ error: safe.message, code: safe.code });
  }
}
