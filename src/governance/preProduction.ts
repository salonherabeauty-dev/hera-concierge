export const PRE_PRODUCTION_GATE_REGISTER_VERSION = "2026-08-25.4";
export const LIVE_PRODUCTION_APPROVED = false;
export const SHADOW_MODE_REQUIRED = true;

export const PASSED_PRE_PRODUCTION_GATES = [
  "stage_0_baseline_lock",
  "stage_1_service_constitution",
  "stage_2_knowledge_and_action_authority",
] as const;

export interface ReleaseModeAssessment {
  allowed: boolean;
  reason: string | null;
  gateRegisterVersion: string;
  liveProductionApproved: boolean;
  shadowModeRequired: boolean;
}

export function assessReleaseMode(
  sendMode: "shadow" | "live",
  liveConfirmation: string | undefined,
  requiredConfirmation: string,
): ReleaseModeAssessment {
  if (sendMode === "shadow") {
    return {
      allowed: true,
      reason: null,
      gateRegisterVersion: PRE_PRODUCTION_GATE_REGISTER_VERSION,
      liveProductionApproved: LIVE_PRODUCTION_APPROVED,
      shadowModeRequired: SHADOW_MODE_REQUIRED,
    };
  }

  if (liveConfirmation !== requiredConfirmation) {
    return {
      allowed: false,
      reason: "live_confirmation_missing_or_incorrect",
      gateRegisterVersion: PRE_PRODUCTION_GATE_REGISTER_VERSION,
      liveProductionApproved: LIVE_PRODUCTION_APPROVED,
      shadowModeRequired: SHADOW_MODE_REQUIRED,
    };
  }

  if (!LIVE_PRODUCTION_APPROVED || SHADOW_MODE_REQUIRED) {
    return {
      allowed: false,
      reason: "pre_production_certification_incomplete",
      gateRegisterVersion: PRE_PRODUCTION_GATE_REGISTER_VERSION,
      liveProductionApproved: LIVE_PRODUCTION_APPROVED,
      shadowModeRequired: SHADOW_MODE_REQUIRED,
    };
  }

  return {
    allowed: true,
    reason: null,
    gateRegisterVersion: PRE_PRODUCTION_GATE_REGISTER_VERSION,
    liveProductionApproved: LIVE_PRODUCTION_APPROVED,
    shadowModeRequired: SHADOW_MODE_REQUIRED,
  };
}
