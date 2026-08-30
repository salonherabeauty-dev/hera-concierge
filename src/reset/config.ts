import { HERA_INTERNAL_PILOT_BRANCH } from "../config.js";

export const HERA_RESET_ARCHITECTURE_VERSION =
  "hera-receptionist-reset-1.0.0";
export const HERA_RESET_DEVELOPMENT_BRANCH = "reset/receptionist-v1";
export const HERA_RESET_MODEL_ID = "openai/gpt-5.6-sol";
export const HERA_RESET_MAX_MODEL_CALLS = 2;
export const HERA_RESET_SETTLE_MS = 8_000;
export const HERA_RESET_MODEL_TIMEOUT_MS = 240_000;

export function useResetReceptionist(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const branch = env.VERCEL_GIT_COMMIT_REF?.trim() ?? "";
  return (
    env.VERCEL_ENV === "preview" &&
    env.WHATSAPP_SEND_MODE === "shadow" &&
    env.WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE" &&
    (branch === HERA_RESET_DEVELOPMENT_BRANCH ||
      branch === HERA_INTERNAL_PILOT_BRANCH)
  );
}

export function requireResetReceptionist(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useResetReceptionist(env)) {
    const error = new Error(
      "The Hera receptionist reset is restricted to a shadow-locked private Preview.",
    );
    error.name = "HeraResetPreviewRequiredError";
    throw error;
  }
}
