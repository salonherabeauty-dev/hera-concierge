import {
  verifyFinalClientReply,
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
} from "../src/ai/receptionist.js";
import { getAiConfig } from "../src/config.js";
import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "../src/policy/finalResponseQuality.js";
import type { HumanHandoffAssessment } from "../src/policy/handoff.js";
import type {
  AgentDecision,
  JsonValue,
  PolicyAssessment,
} from "../src/types.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const CLIENT_MESSAGE =
  "Hi, I had a curly haircut at Tanglin Mall yesterday and the layers look uneven. I’m unhappy with the result and would like the salon manager to review it. Please tell me what can be done.";
const CRUDE_DRAFT =
  "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.";

function assertSafePreview(): void {
  if (process.env.VERCEL_ENV !== "preview") {
    throw new Error("model_verification_requires_preview");
  }
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("model_verification_requires_authoritative_staging_branch");
  }
  if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
    throw new Error("model_verification_requires_shadow_mode");
  }
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
    throw new Error("model_verification_refuses_live_confirmation");
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

assertSafePreview();

const facts = {
  service: "curly haircut",
  stylist: null,
  outlet: "Tanglin Mall",
  date: "yesterday",
  time: null,
  flexibility: null,
  appointmentReference: null,
  desiredOutcome:
    "Salon manager to review the uneven layers and explain what can be done.",
  symptoms: null,
  photos: null,
  other: "Client reports uneven layers and dissatisfaction with the result.",
};

const decision: AgentDecision = {
  reply: CRUDE_DRAFT,
  intent: "complaint",
  risk: "amber",
  confidence: 0.94,
  language: "English",
  sources: [],
  factualBasis: ["client_provided_fact"],
  proposedActions: ["create_handoff_task", "open_incident", "notify_management"],
  requiresManagementNotification: true,
  handoff: {
    required: true,
    taskType: "complaint_review",
    scope: "full_takeover",
    priority: "high",
    assignedRole: "salon_manager",
    assignedOutlet: "Tanglin Mall",
    summary: "Client service concern requires management review.",
    requestedAction:
      "Review the conversation and service evidence, contact the client with management ownership, and decide the authorised recovery action.",
    collectedFacts: facts,
    missingFacts: ["stylist", "time", "appointmentReference", "photos"],
    clientAcknowledgement: CRUDE_DRAFT,
  },
  rationale: "Controlled final-response quality proof.",
};

const policy: PolicyAssessment = {
  risk: "amber",
  canAutoSend: true,
  requiresManagementNotification: true,
  requiresIncident: true,
  blockedActions: [],
  securityFlags: [],
  replyOverride: null,
};

const handoff: HumanHandoffAssessment = {
  createTask: true,
  taskType: "complaint_review",
  scope: "full_takeover",
  priority: "high",
  assignedRole: "salon_manager",
  assignedOutlet: "Tanglin Mall",
  summary: "Client service concern requires management review.",
  requestedAction:
    "Review the conversation and service evidence, contact the client with management ownership, and decide the authorised recovery action.",
  collectedFacts: facts,
  missingFacts: ["stylist", "time", "appointmentReference", "photos"],
  clientReplyOverride: CRUDE_DRAFT,
  clientVisibleStatus: CRUDE_DRAFT,
  dedupeKey: "controlled-final-response-quality-proof",
  reason: "A complaint and explicit manager review require human ownership.",
};

const draftQuality = assessFinalResponseQuality({
  clientMessage: CLIENT_MESSAGE,
  reply: CRUDE_DRAFT,
  decision,
  policy,
  handoff,
  risk: "amber",
});
if (draftQuality.passed) {
  throw new Error("crude_draft_unexpectedly_passed_deterministic_gate");
}

const config = getAiConfig();
const initial = await verifyFinalClientReply({
  originalMessage: CLIENT_MESSAGE,
  history: [],
  draftReply: CRUDE_DRAFT,
  decision,
  evidence: [],
  policy,
  handoff,
  deterministicDraftQuality: jsonValue(draftQuality),
  contactId: "controlled-final-response-model-proof",
  config,
});
if (initial.approved || !initial.correctedReply) {
  throw new Error("final_verifier_failed_to_reject_crude_draft");
}

const correctedReply = initial.correctedReply.trim();
const correctedQuality = assessFinalResponseQuality({
  clientMessage: CLIENT_MESSAGE,
  reply: correctedReply,
  decision,
  policy,
  handoff,
  risk: "amber",
});
if (!correctedQuality.passed) {
  throw new Error(
    `corrected_reply_failed_deterministic_gate:${correctedQuality.issues.join("|")}`,
  );
}

const exactFinal = await verifyFinalClientReply({
  originalMessage: CLIENT_MESSAGE,
  history: [],
  draftReply: correctedReply,
  decision,
  evidence: [],
  policy,
  handoff,
  deterministicDraftQuality: jsonValue(correctedQuality),
  contactId: "controlled-final-response-model-proof",
  config,
});

console.log(
  "HERA_FINAL_RESPONSE_MODEL_DIAGNOSTIC",
  JSON.stringify({
    promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
    deterministicPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    primaryConfiguredModel: config.primaryModel,
    configuredVerifierModel: config.verifierModel,
    initial: {
      approved: initial.approved,
      issues: initial.issues,
      scores: initial.scores,
      summary: initial.summary,
      actualModel: initial.modelId,
      correctedReply,
    },
    correctedDeterministicQuality: correctedQuality,
    exactFinal: {
      approved: exactFinal.approved,
      issues: exactFinal.issues,
      scores: exactFinal.scores,
      summary: exactFinal.summary,
      actualModel: exactFinal.modelId,
      furtherCorrection: exactFinal.correctedReply,
    },
    whatsappSendMode: process.env.WHATSAPP_SEND_MODE,
    providerSendAttempted: false,
    databaseMutationAttempted: false,
  }),
);

if (
  !exactFinal.approved ||
  exactFinal.issues.length > 0 ||
  Object.values(exactFinal.scores).some((score) => score !== 2)
) {
  throw new Error("corrected_reply_failed_exact_final_model_review");
}

console.log(
  "HERA_FINAL_RESPONSE_MODEL_PROOF",
  JSON.stringify({
    pass: true,
    promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
    deterministicPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    primaryConfiguredModel: config.primaryModel,
    configuredVerifierModel: config.verifierModel,
    initialVerifierActualModel: initial.modelId,
    exactFinalVerifierActualModel: exactFinal.modelId,
    crudeDraftRejected: true,
    correctedReply,
    correctedDeterministicPass: correctedQuality.passed,
    exactFinalApproved: exactFinal.approved,
    exactFinalScores: exactFinal.scores,
    exactFinalIssues: exactFinal.issues,
    whatsappSendMode: process.env.WHATSAPP_SEND_MODE,
    providerSendAttempted: false,
    databaseMutationAttempted: false,
  }),
);
