import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getOperationsConfig } from "../../src/config.js";
import { commandCentreAdminClient } from "../../src/command-centre/auth.js";
import {
  firstHeader,
  methodNotAllowed,
  parseJsonBody,
  secureCommandCentreHeaders,
} from "../../src/command-centre/http.js";
import {
  bootstrapBodySchema,
  parseSchema,
} from "../../src/command-centre/validation.js";
import { verifyBearerToken } from "../../src/security/bearer.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../../src/observability/log.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  secureCommandCentreHeaders(response);
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);

  let operations: ReturnType<typeof getOperationsConfig>;
  try {
    operations = getOperationsConfig();
  } catch (error) {
    logOperationalEvent("error", "command_centre_bootstrap_configuration_invalid", safeErrorFields(error));
    return response.status(503).json({ error: "Command Centre bootstrap is unavailable." });
  }

  const authorization = firstHeader(request.headers.authorization);
  if (!verifyBearerToken(authorization, operations.cronSecret)) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = parseSchema(bootstrapBodySchema, parseJsonBody<unknown>(request));
    const database = commandCentreAdminClient();
    const ownerCount = await database
      .from("ai_staff_profiles")
      .select("user_id", { count: "exact", head: true })
      .eq("status", "active")
      .in("role", ["owner", "managing_director"]);
    if (ownerCount.error) throw new Error(`check command centre owner: ${ownerCount.error.message}`);
    if ((ownerCount.count ?? 0) > 0) {
      return response.status(409).json({ error: "The Command Centre owner is already configured." });
    }

    const created = await database.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { display_name: body.displayName, application: "hera-command-centre" },
    });
    if (created.error || !created.data.user) {
      throw new Error(`create command centre owner: ${created.error?.message ?? "no user returned"}`);
    }

    const profile = await database.from("ai_staff_profiles").insert({
      user_id: created.data.user.id,
      email: body.email,
      display_name: body.displayName,
      role: "owner",
      outlet_scope: ["Tanglin Mall", "Sentosa Quayside Isle"],
      status: "active",
      permissions: { bootstrap_owner: true },
    });
    if (profile.error) {
      await database.auth.admin.deleteUser(created.data.user.id);
      throw new Error(`create command centre owner profile: ${profile.error.message}`);
    }

    const audit = await database.from("ai_audit_log").insert({
      actor_type: "system",
      actor_id: "command_centre_bootstrap",
      event_type: "command_centre_owner_bootstrapped",
      target_type: "staff_profile",
      target_id: created.data.user.id,
      details: { emailDomain: body.email.split("@")[1] ?? "unknown" },
    });
    if (audit.error) throw new Error(`audit command centre bootstrap: ${audit.error.message}`);

    logOperationalEvent("info", "command_centre_owner_bootstrapped", {});
    return response.status(201).json({ ok: true, ownerCreated: true });
  } catch (error) {
    logOperationalEvent("error", "command_centre_bootstrap_failed", safeErrorFields(error));
    return response.status(500).json({ error: "The Command Centre owner could not be created." });
  }
}
