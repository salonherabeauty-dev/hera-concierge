import type { HumanHandoffAssessment } from "./handoff.js";
import type {
  AgentAction,
  AgentDecision,
  PolicyAssessment,
  RiskLevel,
} from "../types.js";

export const ACTION_AUTHORITY_POLICY_VERSION =
  "hera-action-authority-2026-08-25.1";

export type AgentActionAuthority =
  | "ai_conversation"
  | "ai_read_only"
  | "ai_information_collection"
  | "ai_durable_handoff"
  | "ai_safety_record"
  | "ai_deterministic_safety"
  | "review_only_management_alert";

export const AGENT_ACTION_AUTHORITY: Record<AgentAction, AgentActionAuthority> = {
  answer: "ai_read_only",
  ask_clarifying_question: "ai_conversation",
  share_booking_link: "ai_read_only",
  request_photos: "ai_information_collection",
  request_appointment_details: "ai_information_collection",
  create_handoff_task: "ai_durable_handoff",
  open_incident: "ai_safety_record",
  notify_management: "review_only_management_alert",
  urgent_safety_guidance: "ai_deterministic_safety",
};

export interface ActionAuthorityAssessment {
  passed: boolean;
  issues: string[];
  checkedActions: AgentAction[];
  policyVersion: string;
  sourceIds: string[];
}

interface ActionAuthorityInput {
  reply: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  handoff: HumanHandoffAssessment;
  risk: RiskLevel;
}

const BOOKING_COMPLETION_PATTERNS = [
  /\b(?:your|the)\s+(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured|rescheduled|changed|cancelled)\b/i,
  /\b(?:i|we)(?:'ve| have)\s+(?:booked|confirmed|reserved|secured|rescheduled|changed|cancelled)\b/i,
  /\b(?:booking|appointment)\s+(?:reference|confirmation)\s+(?:is|:)\s*[a-z0-9-]{4,}\b/i,
];

const LIVE_AVAILABILITY_PATTERNS = [
  /\b(?:we|hera|the salon)\s+(?:have|has)\s+(?:an?\s+)?(?:available\s+)?(?:slot|appointment)\b/i,
  /\b(?:the stylist|[A-Z][a-z]{2,})\s+(?:is|will be)\s+available\s+(?:today|tomorrow|this\s+(?:morning|afternoon|evening)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/,
  /\b(?:available|open)\s+slot\s+(?:at|for)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
];

const FINANCIAL_COMPLETION_PATTERNS = [
  /\b(?:refund|voucher|compensation|credit|discount)\s+(?:is|has been|was)\s+(?:approved|issued|applied|processed|confirmed)\b/i,
  /\b(?:i|we)(?:'ve| have)\s+(?:approved|issued|applied|processed)\s+(?:a|the|your)?\s*(?:refund|voucher|compensation|credit|discount)\b/i,
  /\b(?:you will|we will)\s+(?:receive|provide)\s+(?:a\s+)?(?:refund|voucher|compensation|credit)\b/i,
];

const UNAUTHORISED_REFINEMENT_PATTERNS = [
  /\byou\s+will\s+receive\s+(?:a\s+)?complimentary\s+(?:refinement|adjustment|redo)\b/i,
  /\bwe\s+will\s+(?:provide|arrange|do)\s+(?:a\s+)?complimentary\s+(?:refinement|adjustment|redo)\b/i,
  /\byou\s+(?:are|have been)\s+eligible\s+for\s+(?:a\s+)?complimentary\s+(?:refinement|adjustment|redo)\b/i,
];

const CONSENT_OR_PRIVACY_COMPLETION_PATTERNS = [
  /\b(?:your|the)\s+(?:photo|video|media)?\s*consent\s+(?:is|has been|was)\s+(?:recorded|confirmed|withdrawn|revoked|updated)\b/i,
  /\b(?:your|the)\s+(?:data|record|photos?|videos?)\s+(?:is|has been|was|have been|were)\s+(?:deleted|removed|erased|suppressed)\b/i,
  /\b(?:we|i)(?:'ve| have)\s+(?:deleted|removed|erased|withdrawn)\s+(?:your|the)\s+(?:data|record|photos?|videos?|consent)\b/i,
];

const LIABILITY_PATTERNS = [
  /\b(?:we|hera|our stylist|the salon)\s+(?:are|is|were|was)\s+(?:at fault|responsible|liable)\b/i,
  /\b(?:we|our stylist|the salon)\s+(?:caused|damaged|ruined|burned|burnt)\s+(?:your|the)\b/i,
  /\bthis\s+was\s+(?:our|the stylist's|hera's)\s+(?:fault|mistake|negligence)\b/i,
];

const DIAGNOSIS_PATTERNS = [
  /\byou\s+have\s+(?:an?\s+)?(?:allergic reaction|infection|chemical burn|scalp disease|alopecia)\b/i,
  /\bthis\s+is\s+(?:an?\s+)?(?:allergic reaction|infection|chemical burn|medical condition|chemical damage)\b/i,
  /\byour\s+(?:scalp|skin|hair)\s+is\s+(?:infected|chemically burned|medically unsafe|permanently damaged)\b/i,
];

const HUMAN_OWNERSHIP_LANGUAGE =
  /\b(?:salon manager|manager|receptionist|privacy officer|managing director|owner|hera's team)\b.{0,80}\b(?:will|has|is reviewing|is handling|will review|will contact|will assist)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function completeHandoff(handoff: HumanHandoffAssessment): boolean {
  return Boolean(
    handoff.createTask &&
      handoff.taskType &&
      handoff.scope &&
      handoff.priority &&
      handoff.assignedRole &&
      handoff.summary?.trim() &&
      handoff.requestedAction?.trim() &&
      handoff.dedupeKey?.trim(),
  );
}

export function assessActionAuthority(
  input: ActionAuthorityInput,
): ActionAuthorityAssessment {
  const issues: string[] = [];
  const sourceIds = input.decision.sources.map((source) => source.id);
  const actions = unique(input.decision.proposedActions) as AgentAction[];

  for (const action of actions) {
    if (!(action in AGENT_ACTION_AUTHORITY)) {
      issues.push(`unknown_agent_action:${action}`);
      continue;
    }

    if (action === "answer") {
      if (
        input.decision.factualBasis.includes("approved_hera_source") &&
        sourceIds.length === 0
      ) {
        issues.push("approved_hera_answer_missing_current_run_source");
      }
      if (
        input.decision.factualBasis.includes("current_client_record") &&
        !sourceIds.includes("booking:current-client-lookup")
      ) {
        issues.push("current_client_record_claim_missing_read_evidence");
      }
      if (
        input.decision.factualBasis.includes("deterministic_calculation") &&
        !sourceIds.includes("calculation:gst-9")
      ) {
        issues.push("deterministic_calculation_claim_missing_tool_evidence");
      }
    }

    if (
      action === "share_booking_link" &&
      !sourceIds.includes("hera-digital-tools")
    ) {
      issues.push("booking_link_missing_approved_digital_tool_evidence");
    }

    if (action === "create_handoff_task" && !completeHandoff(input.handoff)) {
      issues.push("human_handoff_action_missing_complete_durable_task_contract");
    }

    if (action === "open_incident" && !input.policy.requiresIncident) {
      issues.push("incident_action_not_authorised_by_policy");
    }

    if (
      action === "notify_management" &&
      !input.policy.requiresManagementNotification &&
      !input.decision.requiresManagementNotification
    ) {
      issues.push("management_notification_not_authorised_by_policy");
    }

    if (
      action === "urgent_safety_guidance" &&
      !["red", "black"].includes(input.risk) &&
      !input.decision.factualBasis.includes("safety_policy")
    ) {
      issues.push("urgent_safety_guidance_without_safety_authority");
    }
  }

  if (hasAny(input.reply, BOOKING_COMPLETION_PATTERNS)) {
    issues.push("unverified_booking_write_or_completion_claim");
  }
  if (hasAny(input.reply, LIVE_AVAILABILITY_PATTERNS)) {
    issues.push("unverified_live_availability_claim");
  }
  if (hasAny(input.reply, FINANCIAL_COMPLETION_PATTERNS)) {
    issues.push("unauthorised_financial_decision_or_completion_claim");
  }
  if (hasAny(input.reply, UNAUTHORISED_REFINEMENT_PATTERNS)) {
    issues.push("unauthorised_complimentary_refinement_promise");
  }
  if (hasAny(input.reply, CONSENT_OR_PRIVACY_COMPLETION_PATTERNS)) {
    issues.push("unverified_consent_or_privacy_completion_claim");
  }
  if (hasAny(input.reply, LIABILITY_PATTERNS)) {
    issues.push("liability_admission_prohibited");
  }
  if (hasAny(input.reply, DIAGNOSIS_PATTERNS)) {
    issues.push("medical_or_damage_diagnosis_prohibited");
  }
  if (HUMAN_OWNERSHIP_LANGUAGE.test(input.reply) && !completeHandoff(input.handoff)) {
    issues.push("human_ownership_claim_without_durable_task");
  }

  return {
    passed: issues.length === 0,
    issues: unique(issues),
    checkedActions: actions,
    policyVersion: ACTION_AUTHORITY_POLICY_VERSION,
    sourceIds,
  };
}
