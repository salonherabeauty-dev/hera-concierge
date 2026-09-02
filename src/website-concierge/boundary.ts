export const WEBSITE_CONCIERGE_PREVIEW_BRANCH =
  "website/concierge-staging-adapter";
export const WEBSITE_CONCIERGE_STAGING_BRANCH =
  "feat/hera-ai-receptionist-foundation";
export const WEBSITE_CONCIERGE_PRODUCTION_BRANCH = "main";
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

export function useWebsiteConciergeProduction(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    env.VERCEL_GIT_COMMIT_REF === WEBSITE_CONCIERGE_PRODUCTION_BRANCH
  );
}

export function useWebsiteConciergeRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return useWebsiteConciergePreview(env) || useWebsiteConciergeProduction(env);
}

export function requireWebsiteConciergePreview(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useWebsiteConciergeRuntime(env)) {
    const error = new Error(
      "The Hera website concierge adapter is restricted to approved private Preview branches or the main Production release.",
    );
    error.name = "WebsiteConciergePreviewRequiredError";
    throw error;
  }
}
