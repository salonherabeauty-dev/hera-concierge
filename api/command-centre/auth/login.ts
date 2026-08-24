import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  commandCentreAdminClient,
  signInCommandCentre,
} from "../../../src/command-centre/auth.js";
import {
  clientSafeError,
  methodNotAllowed,
  parseJsonBody,
  requireSameOrigin,
  secureCommandCentreHeaders,
} from "../../../src/command-centre/http.js";
import {
  loginBodySchema,
  parseSchema,
} from "../../../src/command-centre/validation.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../../src/observability/log.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);

  try {
    requireSameOrigin(request);
    const body = parseSchema(loginBodySchema, parseJsonBody<unknown>(request));
    const session = await signInCommandCentre({
      email: body.email,
      password: body.password,
      response,
    });

    const database = commandCentreAdminClient();
    const audit = await database.from("ai_audit_log").insert({
      actor_type: "management",
      actor_id: session.staff.userId,
      event_type: "command_centre_login",
      target_type: "staff_session",
      target_id: session.staff.userId,
      details: { role: session.staff.role },
    });
    if (audit.error) throw new Error(`audit command centre login: ${audit.error.message}`);

    logOperationalEvent("info", "command_centre_login_succeeded", {
      role: session.staff.role,
    });
    return response.status(200).json({
      ok: true,
      staff: session.staff,
      csrfToken: session.csrfToken,
    });
  } catch (error) {
    logOperationalEvent("warn", "command_centre_login_failed", safeErrorFields(error));
    if (error instanceof Error && /invalid email or password/i.test(error.message)) {
      return response.status(401).json({
        error: "Email or password is incorrect.",
        code: "invalid_credentials",
      });
    }
    const safe = clientSafeError(error);
    return response.status(safe.status).json({ error: safe.message, code: safe.code });
  }
}
