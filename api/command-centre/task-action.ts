import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  authenticateCommandCentre,
  isCommandCentrePasswordlessPreview,
  requireCommandCentreCsrf,
} from "../../src/command-centre/auth.js";
import { CommandCentreGuardRepository } from "../../src/command-centre/guardRepository.js";
import {
  clientSafeError,
  methodNotAllowed,
  parseJsonBody,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import { validateTaskTransition } from "../../src/command-centre/operationPolicy.js";
import { hasCapability } from "../../src/command-centre/permissions.js";
import { SupabaseCommandCentreRepository } from "../../src/command-centre/repository.js";
import {
  parseSchema,
  taskActionBodySchema,
} from "../../src/command-centre/validation.js";
import type { JsonValue } from "../../src/types.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  try {
    const session = await authenticateCommandCentre(request, response);
    requireSameOrigin(request);
    requireCommandCentreCsrf(request);

    const body = parseSchema(taskActionBodySchema, parseJsonBody<unknown>(request));
    const preview = isCommandCentrePasswordlessPreview();
    const repository = new SupabaseCommandCentreRepository();
    let result: JsonValue;

    if (body.action === "accept") {
      if (!hasCapability(session.staff.role, "accept_task")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      result = await repository.acceptTask(
        body.taskId,
        session.staff.userId,
        body.expectedVersion,
      );
    } else if (body.action === "assign") {
      // The protected Preview supports self-acceptance only. Arbitrary staff
      // assignment remains disabled until the multi-user staff directory is live.
      if (preview) {
        return response.status(403).json({
          error: "Preview tasks can be accepted by the current named operator but cannot be assigned to another staff member.",
          code: "preview_assignment_blocked",
        });
      }
      if (!hasCapability(session.staff.role, "assign_task")) {
        return response.status(403).json({ error: "Forbidden" });
      }
      result = await repository.assignTask({
        taskId: body.taskId,
        actorUserId: session.staff.userId,
        ownerUserId: body.ownerUserId,
        expectedVersion: body.expectedVersion,
      });
    } else {
      if (!hasCapability(session.staff.role, "transition_task")) {
        return response.status(403).json({ error: "Forbidden" });
      }

      const guard = new CommandCentreGuardRepository();
      const task = await guard.getTask(body.taskId);
      const validationError = validateTaskTransition({
        task,
        toStatus: body.toStatus,
        note: body.note,
        resolution: body.resolution as JsonValue,
      });
      if (validationError) {
        return response.status(400).json({
          error: validationError,
          code: "booking_outcome_invalid",
        });
      }

      result = await repository.transitionTask({
        taskId: body.taskId,
        actorUserId: session.staff.userId,
        expectedVersion: body.expectedVersion,
        toStatus: body.toStatus,
        note: body.note,
        resolution: body.resolution as JsonValue,
      });
    }
    return response.status(200).json({ result });
  } catch (error) {
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
