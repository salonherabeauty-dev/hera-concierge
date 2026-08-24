import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(
  request: VercelRequest,
  response: VercelResponse,
): VercelResponse {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  // This private Preview diagnostic intentionally returns only presence flags,
  // never variable values. Vercel Deployment Protection remains the outer gate.
  return response.status(200).json({
    ok: true,
    databaseConnectionAvailable: Boolean(
      process.env.DATABASE_URL ||
        process.env.POSTGRES_URL_NON_POOLING ||
        process.env.POSTGRES_URL ||
        process.env.SUPABASE_DB_URL,
    ),
    names: {
      databaseUrl: Boolean(process.env.DATABASE_URL),
      postgresUrlNonPooling: Boolean(process.env.POSTGRES_URL_NON_POOLING),
      postgresUrl: Boolean(process.env.POSTGRES_URL),
      supabaseDbUrl: Boolean(process.env.SUPABASE_DB_URL),
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      serviceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      publishableKey: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY),
      sessionSecret: Boolean(process.env.COMMAND_CENTRE_SESSION_SECRET),
      cronSecret: Boolean(process.env.CRON_SECRET),
    },
  });
}
