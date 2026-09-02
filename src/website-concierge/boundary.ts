export const WEBSITE_CONCIERGE_PREVIEW_BRANCH =
  "website/concierge-staging-adapter";
export const WEBSITE_CONCIERGE_VERSION =
  "hera-website-concierge-adapter-1.0.0";

export function useWebsiteConciergePreview(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.VERCEL_ENV === "preview" &&
    env.VERCEL_GIT_COMMIT_REF === WEBSITE_CONCIERGE_PREVIEW_BRANCH
  );
}

export function requireWebsiteConciergePreview(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useWebsiteConciergePreview(env)) {
    const error = new Error(
      "The Hera website concierge adapter is restricted to its private Preview branch.",
    );
    error.name = "WebsiteConciergePreviewRequiredError";
    throw error;
  }
}
