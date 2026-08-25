export const ACTION_AUTHORITY_VERSION = "hera-action-authority-2026-08-25.1";

export type ActionAuthorityLevel =
  | "read_only"
  | "ai_authorised_no_external_side_effect"
  | "human_required"
  | "prohibited";

export interface RuntimeActionAuthorityContract {
  actionKey: string;
  authority: ActionAuthorityLevel;
  owner: string | null;
  taskType: string | null;
  clientRule: string;
}

export const RUNTIME_ACTION_AUTHORITY_CONTRACTS = [
  {
    actionKey: "answer_approved_service_information",
    authority: "ai_authorised_no_external_side_effect",
    owner: null,
    taskType: null,
    clientRule:
      "Answer only from approved current evidence and pass the exact final-response quality gate.",
  },
  {
    actionKey: "calculate_nine_percent_gst",
    authority: "ai_authorised_no_external_side_effect",
    owner: null,
    taskType: null,
    clientRule:
      "Calculate deterministically from an approved base price; never present it as a final service quotation.",
  },
  {
    actionKey: "read_current_client_booking_record",
    authority: "read_only",
    owner: null,
    taskType: null,
    clientRule:
      "Use only the current client's authorised record and never infer a live change from stale data.",
  },
  {
    actionKey: "quote_live_availability",
    authority: "human_required",
    owner: "receptionist",
    taskType: "booking_action",
    clientRule:
      "Collect the request and obtain a verified live Timely result; never invent a slot or stylist schedule.",
  },
  {
    actionKey: "create_booking",
    authority: "human_required",
    owner: "receptionist",
    taskType: "booking_action",
    clientRule:
      "Acknowledge the request, but confirm only after Timely success or an authorised human outcome.",
  },
  {
    actionKey: "reschedule_booking",
    authority: "human_required",
    owner: "receptionist",
    taskType: "appointment_change",
    clientRule:
      "Record the requested change and confirm only after Timely success or an authorised human outcome.",
  },
  {
    actionKey: "cancel_booking",
    authority: "human_required",
    owner: "receptionist",
    taskType: "appointment_change",
    clientRule:
      "Record the cancellation request and confirm only after Timely success or an authorised human outcome.",
  },
  {
    actionKey: "confirm_booking_outcome",
    authority: "human_required",
    owner: "receptionist",
    taskType: "booking_action",
    clientRule:
      "State a booking outcome only from a verified Timely result or an authorised human confirmation record.",
  },
  {
    actionKey: "complaint_review",
    authority: "human_required",
    owner: "salon_manager",
    taskType: "complaint_review",
    clientRule:
      "Recognise the concern, identify salon-manager ownership and explain the review without admitting liability or promising a remedy.",
  },
  {
    actionKey: "authorise_policy_refinement",
    authority: "human_required",
    owner: "salon_manager",
    taskType: "complaint_review",
    clientRule:
      "A complimentary refinement is possible only after the manager confirms the concern relates to the original service and can be corrected safely.",
  },
  {
    actionKey: "authorise_outside_policy_exception",
    authority: "human_required",
    owner: "managing_director_or_owner",
    taskType: "complaint_review",
    clientRule:
      "Do not predict approval; record the exception request for senior decision.",
  },
  {
    actionKey: "apply_waiting_time_recovery",
    authority: "human_required",
    owner: "salon_manager",
    taskType: "complaint_review",
    clientRule:
      "Explain the approved rule, but claim application only after a manager or transaction record verifies it.",
  },
  {
    actionKey: "approve_refund",
    authority: "human_required",
    owner: "managing_director_or_owner",
    taskType: "refund_finance",
    clientRule:
      "Never promise a refund before senior approval and verified transaction evidence.",
  },
  {
    actionKey: "approve_voucher",
    authority: "human_required",
    owner: "managing_director_or_owner",
    taskType: "refund_finance",
    clientRule:
      "Never promise a voucher before senior approval and a verified voucher record.",
  },
  {
    actionKey: "approve_compensation",
    authority: "human_required",
    owner: "managing_director_or_owner",
    taskType: "refund_finance",
    clientRule:
      "Never promise compensation before senior approval and verified transaction evidence.",
  },
  {
    actionKey: "provide_urgent_safety_containment",
    authority: "ai_authorised_no_external_side_effect",
    owner: "salon_manager",
    taskType: "medical_safety",
    clientRule:
      "Give deterministic urgent-care containment without diagnosis and create the required human ownership.",
  },
  {
    actionKey: "diagnose_medical_condition",
    authority: "prohibited",
    owner: null,
    taskType: "medical_safety",
    clientRule: "Never diagnose, prescribe or provide medical clearance.",
  },
  {
    actionKey: "determine_technical_damage_or_fault",
    authority: "human_required",
    owner: "technical_lead_or_salon_manager",
    taskType: "technical_review",
    clientRule:
      "Arrange qualified review and do not assign damage or fault from AI inference.",
  },
  {
    actionKey: "admit_legal_liability",
    authority: "prohibited",
    owner: null,
    taskType: "privacy_legal",
    clientRule: "Never admit liability or make a legal determination.",
  },
  {
    actionKey: "process_privacy_access_request",
    authority: "human_required",
    owner: "privacy_officer",
    taskType: "privacy_legal",
    clientRule:
      "Acknowledge the request; claim completion only after identity verification and an approved response record.",
  },
  {
    actionKey: "process_privacy_deletion_request",
    authority: "human_required",
    owner: "privacy_officer",
    taskType: "privacy_legal",
    clientRule:
      "Acknowledge the request; claim completion only after identity, retention and legal review plus a verified action record.",
  },
  {
    actionKey: "record_media_capture_consent",
    authority: "human_required",
    owner: "privacy_officer_or_authorised_staff",
    taskType: "consent_media",
    clientRule:
      "Capture consent must be explicit and recorded; never infer it from attendance.",
  },
  {
    actionKey: "record_media_publication_consent",
    authority: "human_required",
    owner: "privacy_officer_or_authorised_staff",
    taskType: "consent_media",
    clientRule:
      "External publication requires separate explicit consent; capture consent is not enough.",
  },
  {
    actionKey: "withdraw_media_consent",
    authority: "human_required",
    owner: "privacy_officer",
    taskType: "consent_media",
    clientRule:
      "Block future use after verified action and review already-published material; never claim universal removal without evidence.",
  },
  {
    actionKey: "send_ai_generated_whatsapp_reply",
    authority: "prohibited",
    owner: null,
    taskType: null,
    clientRule:
      "Provider sending remains prohibited while shadow mode or any mandatory launch gate is open.",
  },
] as const satisfies readonly RuntimeActionAuthorityContract[];

export function getActionAuthorityContract(
  actionKey: string,
): RuntimeActionAuthorityContract | null {
  return (
    RUNTIME_ACTION_AUTHORITY_CONTRACTS.find(
      (contract) => contract.actionKey === actionKey,
    ) ?? null
  );
}

export function renderActionAuthorityPrompt(): string {
  const lines = RUNTIME_ACTION_AUTHORITY_CONTRACTS.map((contract) => {
    const owner = contract.owner ? ` Owner: ${contract.owner}.` : "";
    return `- ${contract.actionKey}: ${contract.authority}.${owner} ${contract.clientRule}`;
  });

  return [
    `HERA ACTION AUTHORITY CONTRACTS - ${ACTION_AUTHORITY_VERSION}`,
    "Unknown or unlisted external actions are prohibited.",
    "A client request is not proof that an external action occurred.",
    "Any future external mutation requires eligibility, idempotency, provider confirmation, before/after audit and reconciliation.",
    ...lines,
  ].join("\n");
}
