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
import type { HandoffStatus } from "../../src/command-centre/types.js";
import {
  createTaskBodySchema,
  parseSchema,
} from "../../src/command-centre/validation.js";

const allowedStatuses = new Set<string>([
  "open",
  "new",
  "assigned",
  "accepted",
  "waiting_client",
  "waiting_internal",
  "resolved",
  "cancelled",
]);

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "GET" && request.method !== "POST") {
    return methodNotAllowed(response, ["GET", "POST"]);
  }

  try {
    const session = await authenticateCommandCentre(request, response);
    const repository = new SupabaseCommandCentreRepository();
    if (request.method === "GET") {
      if (!hasCapability(session.staff.role, "view_dashboard")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      const statusValue = Array.isArray(request.query.status)
        ? request.query.status[0]
        : request.query.status;
      const candidate = typeof statusValue === "string" ? statusValue : "open";
      const status = allowedStatuses.has(candidate) ? candidate : "open";
      const tasks = await repository.listTasks({
        status: status as HandoffStatus | "open",
        limit: 150,
      });
      return response.status(200).json({ tasks });
    }

    requireSameOrigin(request);
    requireCommandCentreCsrf(request);
    if (!hasCapability(session.staff.role, "create_task")) {
      return response.status(403).json({ error: "Forbidden" });
    }
    const input = parseSchema(createTaskBodySchema, parseJsonBody<unknown>(request));
    const result = await repository.createTask(input, session.staff.userId);
    return response.status(201).json({ result });
  } catch (error) {
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
