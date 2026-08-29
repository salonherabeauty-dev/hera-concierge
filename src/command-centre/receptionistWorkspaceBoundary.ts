import {
  getWhatsAppProviderConfig,
  HERA_INTERNAL_PILOT_BRANCH,
} from "../config.js";

export const HERA_TANGLIN_WHATSAPP_CHANNEL = "Tanglin WhatsApp";

export interface ReceptionistWorkspaceBoundary {
  preview: boolean;
  authoritative: boolean;
  shadowLocked: boolean;
  providerReady: boolean;
  branch: string;
}

export function receptionistWorkspaceBoundary(
  env: NodeJS.ProcessEnv = process.env,
): ReceptionistWorkspaceBoundary {
  const branch = env.VERCEL_GIT_COMMIT_REF?.trim() ?? "";
  const preview = env.VERCEL_ENV === "preview" && branch !== "main";
  const authoritative = branch === HERA_INTERNAL_PILOT_BRANCH;
  const shadowLocked =
    env.WHATSAPP_SEND_MODE === "shadow" &&
    env.WHATSAPP_LIVE_CONFIRMATION !== "ENABLE_HERA_WHATSAPP_LIVE";

  let providerReady = false;
  try {
    providerReady =
      getWhatsAppProviderConfig(env).provider === "360dialog";
  } catch {
    providerReady = false;
  }

  return {
    preview,
    authoritative,
    shadowLocked,
    providerReady,
    branch,
  };
}

export function requireReceptionistWorkspacePreview(
  boundary: ReceptionistWorkspaceBoundary,
): void {
  if (
    !boundary.preview ||
    !boundary.authoritative ||
    !boundary.shadowLocked
  ) {
    const error = new Error(
      "Hera Reception is restricted to the authoritative staging Preview.",
    );
    error.name = "ReceptionistWorkspacePreviewRequiredError";
    throw error;
  }
}

export function requireTanglinWhatsAppChannel(
  boundary: ReceptionistWorkspaceBoundary,
): void {
  requireReceptionistWorkspacePreview(boundary);
  if (!boundary.providerReady) {
    const error = new Error(
      "Tanglin WhatsApp delivery is not available on this Preview.",
    );
    error.name = "ReceptionistWorkspaceProviderUnavailableError";
    throw error;
  }
}
