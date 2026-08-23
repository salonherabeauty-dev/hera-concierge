export const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FREEFORM_REPLY_SAFETY_MARGIN_MS = 5 * 60 * 1000;
export const MAX_FREEFORM_REPLY_AGE_MS =
  WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS - FREEFORM_REPLY_SAFETY_MARGIN_MS;
export const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type CustomerCareWindowReason =
  | "within_window"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "future_timestamp"
  | "expired";

export interface CustomerCareWindowAssessment {
  allowed: boolean;
  reason: CustomerCareWindowReason;
  ageMs: number | null;
}

/**
 * Fail-closed check for ordinary WhatsApp free-form replies.
 *
 * Meta's customer-service window is 24 hours from the user's most recent
 * message. Hera uses the source inbound message for each queued reply and a
 * five-minute safety margin so network/queue delay cannot cross the boundary.
 */
export function assessCustomerCareWindow(
  sourceReceivedAt: string | null,
  nowMs = Date.now(),
): CustomerCareWindowAssessment {
  if (!sourceReceivedAt) {
    return { allowed: false, reason: "missing_timestamp", ageMs: null };
  }

  const receivedAtMs = Date.parse(sourceReceivedAt);
  if (!Number.isFinite(receivedAtMs)) {
    return { allowed: false, reason: "invalid_timestamp", ageMs: null };
  }

  const ageMs = nowMs - receivedAtMs;
  if (ageMs < -MAX_PROVIDER_CLOCK_SKEW_MS) {
    return { allowed: false, reason: "future_timestamp", ageMs };
  }
  if (ageMs > MAX_FREEFORM_REPLY_AGE_MS) {
    return { allowed: false, reason: "expired", ageMs };
  }

  return { allowed: true, reason: "within_window", ageMs };
}
