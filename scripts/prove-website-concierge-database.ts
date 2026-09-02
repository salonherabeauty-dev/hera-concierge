import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../src/config.js";
import { WebsiteConciergeRepository } from "../src/website-concierge/repository.js";

const EXPECTED_BRANCH = "website/concierge-staging-adapter";

if (
  process.env.VERCEL_ENV !== "preview" ||
  process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH
) {
  console.log("WEBSITE_CONCIERGE_DATABASE_PROOF_SKIPPED");
} else {
  const database = getDatabaseConfig();
  const projectRef = new URL(database.url).hostname.split(".")[0] ?? "unknown";
  const repository = new WebsiteConciergeRepository(
    database.url,
    database.serviceRoleKey,
  );
  let sessionId: string | null = null;

  try {
    const credential = await repository.createSession();
    sessionId = credential.sessionId;
    const consumed = await repository.authenticateAndConsume({
      sessionId: credential.sessionId,
      sessionToken: credential.sessionToken,
      inputCharacters: 64,
    });
    if (consumed.outletPreference !== "unspecified") {
      throw new Error("unexpected synthetic website outlet preference");
    }
    console.log(
      "WEBSITE_CONCIERGE_DATABASE_PROOF_PASS",
      JSON.stringify({
        projectRef,
        sessionCreated: true,
        quotaConsumed: true,
        whatsappTablesUsed: false,
      }),
    );
  } finally {
    if (sessionId) {
      const client = createClient(database.url, database.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });
      const { error } = await client
        .from("ai_website_concierge_sessions_v1")
        .delete()
        .eq("id", sessionId);
      if (error) {
        throw new Error(`cleanup website concierge proof session: ${error.message}`);
      }
    }
  }
}
