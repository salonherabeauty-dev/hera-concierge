export const WEBSITE_CONCIERGE_PREVIEW_BRANCH =
  "website/concierge-staging-adapter";
export const WEBSITE_CONCIERGE_STAGING_BRANCH =
  "feat/hera-ai-receptionist-foundation";
export const WEBSITE_CONCIERGE_VERSION =
  "hera-website-concierge-adapter-1.0.1";

const ALLOWED_PRIVATE_BRANCHES = new Set([
  WEBSITE_CONCIERGE_PREVIEW_BRANCH,
  WEBSITE_CONCIERGE_STAGING_BRANCH,
]);

export function useWebsiteConciergePreview(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    typeof env.VERCEL_GIT_COMMIT_REF === "string" &&
    ALLOWED_PRIVATE_BRANCHES.has(env.VERCEL_GIT_COMMIT_REF)
  );
}

export function requireWebsiteConciergePreview(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useWebsiteConciergePreview(env)) {
    const error = new Error(
      "The Hera website concierge adapter is restricted to approved private Preview branches.",
    );
    error.name = "WebsiteConciergePreviewRequiredError";
    throw error;
  }
}
