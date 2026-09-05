import type {
  CommandCentreRole,
  HandoffScope,
  HandoffTaskType,
} from "./types.js";

export type CommandCentreCapability =
  | "view_dashboard"
  | "view_conversations"
  | "view_audit"
  | "view_quality"
  | "review_delivery"
  | "generate_ai_reply"
  | "approve_delivery"
  | "reject_delivery"
  | "escalate_delivery"
  | "create_task"
  | "accept_task"
  | "assign_task"
  | "transition_task"
  | "control_conversation"
  | "add_note"
  | "manage_staff"
  | "manage_system";

const ROLE_CAPABILITIES: Record<
  CommandCentreRole,
  ReadonlySet<CommandCentreCapability>
> = {
  owner: new Set([
    "view_dashboard",
    "view_conversations",
    "view_audit",
    "view_quality",
    "review_delivery",
    "generate_ai_reply",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "create_task",
    "accept_task",
    "assign_task",
    "transition_task",
    "control_conversation",
    "add_note",
    "manage_staff",
    "manage_system",
  ]),
  managing_director: new Set([
    "view_dashboard",
    "view_conversations",
    "view_audit",
    "view_quality",
    "review_delivery",
    "generate_ai_reply",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "create_task",
    "accept_task",
    "assign_task",
    "transition_task",
    "control_conversation",
    "add_note",
    "manage_staff",
    "manage_system",
  ]),
  salon_manager: new Set([
    "view_dashboard",
    "view_conversations",
    "view_audit",
    "view_quality",
    "review_delivery",
    "generate_ai_reply",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "create_task",
    "accept_task",
    "assign_task",
    "transition_task",
    "control_conversation",
    "add_note",
  ]),
  receptionist: new Set([
    "view_dashboard",
    "view_conversations",
    "review_delivery",
    "generate_ai_reply",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "create_task",
    "accept_task",
    "transition_task",
    "control_conversation",
    "add_note",
  ]),
  technical_lead: new Set([
    "view_dashboard",
    "view_conversations",
    "review_delivery",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "create_task",
    "accept_task",
    "transition_task",
    "control_conversation",
    "add_note",
  ]),
  finance_admin: new Set([
    "view_dashboard",
    "view_conversations",
    "review_delivery",
    "approve_delivery",
    "escalate_delivery",
    "accept_task",
    "transition_task",
    "add_note",
  ]),
  privacy_officer: new Set([
    "view_dashboard",
    "view_conversations",
    "view_audit",
    "review_delivery",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
    "accept_task",
    "transition_task",
    "control_conversation",
    "add_note",
  ]),
  auditor: new Set([
    "view_dashboard",
    "view_conversations",
    "view_audit",
    "view_quality",
    "review_delivery",
  ]),
};

const RECEPTION_TASKS = new Set<HandoffTaskType>([
  "booking_action",
  "appointment_change",
  "arrival_issue",
  "group_booking",
  "accessibility_arrangement",
  "lost_property",
  "client_requested_human",
  "other",
]);

const TECHNICAL_TASKS = new Set<HandoffTaskType>([
  "technical_review",
  "medical_safety",
  "complaint_review",
]);

const PRIVACY_TASKS = new Set<HandoffTaskType>([
  "privacy_legal",
  "consent_media",
  "security_review",
]);

export function hasCapability(
  role: CommandCentreRole,
  capability: CommandCentreCapability,
): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function canHandleTask(
  role: CommandCentreRole,
  taskType: HandoffTaskType,
): boolean {
  if (role === "owner" || role === "managing_director") return true;
  if (role === "salon_manager") {
    return !PRIVACY_TASKS.has(taskType);
  }
  if (role === "receptionist") return RECEPTION_TASKS.has(taskType);
  if (role === "technical_lead") return TECHNICAL_TASKS.has(taskType);
  if (role === "finance_admin") return taskType === "refund_finance";
  if (role === "privacy_officer") return PRIVACY_TASKS.has(taskType);
  return false;
}

export function canControlScope(
  role: CommandCentreRole,
  scope: HandoffScope,
): boolean {
  if (role === "owner" || role === "managing_director") return true;
  if (role === "salon_manager") return true;
  if (scope === "emergency") {
    return role === "technical_lead" || role === "privacy_officer";
  }
  if (scope === "full_takeover") {
    return (
      role === "receptionist" ||
      role === "technical_lead" ||
      role === "privacy_officer"
    );
  }
  return role !== "auditor";
}

export function roleLabel(role: CommandCentreRole): string {
  const labels: Record<CommandCentreRole, string> = {
    owner: "Owner",
    managing_director: "Managing Director",
    salon_manager: "Salon Manager",
    receptionist: "Receptionist",
    technical_lead: "Technical Lead",
    finance_admin: "Finance & Administration",
    privacy_officer: "Privacy & Legal",
    auditor: "Auditor",
  };
  return labels[role];
}
