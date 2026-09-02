import type { VercelRequest, VercelResponse } from "@vercel/node";

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export default function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).end();
  }

  console.log(
    "WEBSITE_CONCIERGE_PRODUCTION_ENV_READINESS",
    JSON.stringify({
      environment: process.env.VERCEL_ENV ?? null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      exactCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      supabaseUrlPresent: present(process.env.SUPABASE_URL),
      supabaseServiceRoleKeyPresent: present(
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      ),
      openAiApiKeyPresent: present(process.env.OPENAI_API_KEY),
      aiGatewayApiKeyPresent: present(process.env.AI_GATEWAY_API_KEY),
      vercelOidcTokenPresent: present(process.env.VERCEL_OIDC_TOKEN),
    }),
  );
  return response.status(204).end();
}
