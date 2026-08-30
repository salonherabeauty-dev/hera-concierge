import { HERA_INTERNAL_PILOT_BRANCH } from "../config.js";

export const HERA_RECEPTIONIST_RESET_BRANCH =
  "reset/receptionist-v3-vertical";
export const HERA_RECEPTIONIST_RESET_VERSION =
  "hera-receptionist-reset-v3.0.0";

export function useReceptionistResetV3(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const ref = env.VERCEL_GIT_COMMIT_REF ?? "";
  return (
    env.VERCEL_ENV === "preview" &&
    env.WHATSAPP_SEND_MODE === "shadow" &&
    (ref === HERA_INTERNAL_PILOT_BRANCH ||
      ref === HERA_RECEPTIONIST_RESET_BRANCH)
  );
}

export function requireReceptionistResetV3(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useReceptionistResetV3(env)) {
    const error = new Error(
      "Receptionist reset v3 is restricted to the private shadow-locked Preview.",
    );
    error.name = "ReceptionistResetPreviewRequiredError";
    throw error;
  }
}
