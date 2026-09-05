import { HERA_INTERNAL_PILOT_BRANCH } from "../config.js";

export const HERA_RECEPTIONIST_RESET_BRANCH =
  "reset/receptionist-v3-vertical";
export const HERA_RECEPTIONIST_RESET_VERSION =
  "hera-receptionist-reset-v3.0.0";

export type ReceptionistInboundMode =
  | "reset-v3-manual"
  | "preview-human-review"
  | "legacy";

export function selectReceptionistInboundMode(input: {
  resetV3: boolean;
  humanReviewDrafting: boolean;
}): ReceptionistInboundMode {
  // Manual-assist is the stronger boundary and must win when an older Preview
  // shadow flag is also enabled on the same branch.
  if (input.resetV3) return "reset-v3-manual";
  if (input.humanReviewDrafting) return "preview-human-review";
  return "legacy";
}

export function useReceptionistResetV3(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const ref = env.VERCEL_GIT_COMMIT_REF ?? "";
  // Branch identity is the fail-closed boundary. If a Preview setting such as
  // WHATSAPP_SEND_MODE is missing or changed, this branch must remain on the
  // manual Reset-v3 path instead of falling back to the legacy auto-drafter.
  return env.VERCEL_ENV === "preview" &&
    (ref === HERA_INTERNAL_PILOT_BRANCH ||
      ref === HERA_RECEPTIONIST_RESET_BRANCH);
}

export function requireReceptionistResetV3(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!useReceptionistResetV3(env)) {
    const error = new Error(
      "Receptionist reset v3 is restricted to its isolated feature branch.",
    );
    error.name = "ReceptionistResetPreviewRequiredError";
    throw error;
  }
}
