import { createHash } from "node:crypto";
import {
  generateReceptionistDecision,
  verifyFinalClientReply,
  verifyReceptionistDecision,
  type AiRuntimeConfig,
} from "../../ai/receptionist.js";
import type { ReceptionistRepository } from "../../db/repository.js";
import { assessGrounding, type GroundingAssessment } from "../../policy/grounding.js";
import { assessHumanHandoff } from "../../policy/handoff.js";
import { assessFinalResponseQuality } from "../../policy/finalResponseQuality.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
  urgentSafetyReplyFor,
} from "../../policy/risk.js";
import type {
  AgentDecision,
  ConversationMessage,
  JobContext,
  JsonValue,
} from "../../types.js";
import type { Stage3rCase } from "./types.js";

export interface Stage3rExactResponseResult {
  caseId: string;
  exactFinalResponse: string;
  responseHash: string;
  responseModelId: string | null;
  firstVerifierModelId: string | null;
  finalVerifierModelId: string;
  responseEvidence: JsonValue;
  grounding: GroundingAssessment;
  decision: AgentDecision;
  policy: ReturnType<typeof assessPolicy>;
  handoff: ReturnType<typeof assessHumanHandoff>;
  deterministicQuality: ReturnType<typeof assessFinalResponseQuality>;
  finalVerificationApproved: boolean;
  finalVerifierIssues: string[];
  deliveryEligible: boolean;
  groundedHeraFacts: boolean;
  providerSendCount: 0;
  duplicateFinalCandidates: 0;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cleanReply(value: string): string {
  return value
    .replace(/\*/g, "")
    .replace(/!/g, ".")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

function staticUrgentDecision(message: string): AgentDecision {
  return {
    reply: urgentSafetyReplyFor(message),
    intent: "medical_safety",
    risk: "black",
    confidence: 1,
    language: "same as client where reliable",
    sources: [],
    factualBasis: ["safety_policy"],
    proposedActions: [
      "urgent_safety_guidance",
      "create_handoff_task",
      "open_incident",
      "notify_management",
    ],
    requiresManagementNotification: true,
    handoff: {
      required: true,
      taskType: "medical_safety",
      scope: "emergency",
      priority: "emergency",
      assignedRole: "technical_lead",
      assignedOutlet: null,
      summary: "Urgent client safety concern requires immediate human attention.",
      requestedAction:
        "Review immediately, ensure emergency guidance has been given, and contact the client only when safe and appropriate.",
      collectedFacts: {
        service: null,
        stylist: null,
        outlet: null,
        date: null,
        time: null,
        flexibility: null,
        appointmentReference: null,
        desiredOutcome: null,
        symptoms: message.slice(0, 600),
        photos: null,
        other: null,
      },
      missingFacts: [],
      clientAcknowledgement: null,
    },
    rationale: "Deterministic urgent-safety policy matched the certification case.",
  };
}

function evaluationRepository(): ReceptionistRepository {
  return {
    searchApprovedKnowledge: async () => [],
    lookupBookingsByWaId: async () => [],
  } as unknown as ReceptionistRepository;
}

function buildContext(item: Stage3rCase): {
  context: JobContext;
  history: ConversationMessage[];
} {
  const now = new Date().toISOString();
  const digest = createHash("sha256").update(item.id).digest("hex").slice(0, 20);
  const messageId = `stage3r-message-${digest}`;
  const contactId = `stage3r-contact-${digest}`;
  const conversationId = `stage3r-conversation-${digest}`;
  const context: JobContext = {
    job: {
      id: `stage3r-job-${digest}`,
      kind: "process_inbound",
      sourceMessageId: messageId,
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    },
    message: {
      id: messageId,
      conversationId,
      contactId,
      providerMessageId: `wamid.stage3r-${digest}`,
      direction: "inbound",
      kind: "text",
      text: item.message,
      media: null,
      providerTimestamp: now,
      createdAt: now,
    },
    contact: {
      id: contactId,
      waId: `6599${digest.replace(/[^0-9]/g, "").padEnd(6, "0").slice(0, 6)}`,
      profileName: "Stage 3-R Evaluation Client",
      preferredLanguage: item.language,
    },
    conversationRisk: item.minimumRisk === "black" ? "red" : "green",
  };
  const history: ConversationMessage[] = [
    ...(item.history ?? []).map((turn, index) => ({
      id: `stage3r-history-${digest}-${index}`,
      direction: turn.direction,
      kind: "text" as const,
      text: turn.text,
      createdAt: now,
    })),
    {
      id: messageId,
      direction: "inbound",
      kind: "text",
      text: item.message,
      createdAt: now,
    },
  ];
  return { context, history };
}

export async function runStage3rExactResponse(input: {
  case: Stage3rCase;
  ai: AiRuntimeConfig;
  repository?: ReceptionistRepository;
}): Promise<Stage3rExactResponseResult> {
  const repository = input.repository ?? evaluationRepository();
  const { context, history } = buildContext(input.case);
  const deterministic = classifyDeterministicRisk(input.case.message);

  let decision: AgentDecision;
  let responseModelId: string | null = null;
  let firstVerifierModelId: string | null = null;
  let responseEvidence: JsonValue = [];

  if (deterministic.risk === "black") {
    decision = staticUrgentDecision(input.case.message);
  } else {
    const generated = await generateReceptionistDecision({
      repository,
      context,
      history,
      interpreted: { text: input.case.message },
      config: input.ai,
    });
    responseModelId = generated.modelId;
    responseEvidence = generated.evidence;
    const verification = await verifyReceptionistDecision({
      originalMessage: input.case.message,
      history,
      decision: generated.decision,
      evidence: generated.evidence,
      contactId: context.contact.id,
      config: input.ai,
    });
    firstVerifierModelId = verification.modelId;
    if (!verification.approved && !verification.correctedReply) {
      throw new Error("Stage 3-R first verifier rejected the response without a correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("Stage 3-R first verifier rejected the handoff without a correction");
    }
    decision = {
      ...generated.decision,
      reply: verification.approved
        ? generated.decision.reply
        : verification.correctedReply!,
      risk: highestRisk(generated.decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? generated.decision.handoff
        : verification.correctedHandoff!,
    };
  }

  const grounding = assessGrounding(input.case.message, decision);
  if (!grounding.grounded && grounding.replyOverride) {
    decision = {
      ...decision,
      reply: grounding.replyOverride,
      confidence: Math.min(
        decision.confidence,
        grounding.confidenceCap ?? decision.confidence,
      ),
      sources: [],
      factualBasis: ["no_factual_claim"],
    };
  }

  const policy = assessPolicy(
    input.case.message,
    decision,
    context.conversationRisk,
  );
  const handoff = assessHumanHandoff({
    message: input.case.message,
    decision,
    policy,
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
  });
  const draft = cleanReply(
    handoff.clientReplyOverride ?? policy.replyOverride ?? decision.reply,
  );
  const draftQuality = assessFinalResponseQuality({
    clientMessage: input.case.message,
    reply: draft,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const initialFinalVerification = await verifyFinalClientReply({
    originalMessage: input.case.message,
    history,
    draftReply: draft,
    decision,
    evidence: responseEvidence,
    policy,
    handoff,
    deterministicDraftQuality: asJson(draftQuality),
    contactId: context.contact.id,
    config: input.ai,
  });
  if (!initialFinalVerification.approved && !initialFinalVerification.correctedReply) {
    throw new Error("Stage 3-R final verifier rejected the response without a correction");
  }
  const exactFinalResponse = cleanReply(
    deterministic.risk === "black"
      ? urgentSafetyReplyFor(input.case.message)
      : initialFinalVerification.approved
        ? draft
        : initialFinalVerification.correctedReply!,
  );
  const deterministicQuality = assessFinalResponseQuality({
    clientMessage: input.case.message,
    reply: exactFinalResponse,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const finalVerification = initialFinalVerification.approved
    ? initialFinalVerification
    : await verifyFinalClientReply({
        originalMessage: input.case.message,
        history,
        draftReply: exactFinalResponse,
        decision,
        evidence: responseEvidence,
        policy,
        handoff,
        deterministicDraftQuality: asJson(deterministicQuality),
        contactId: context.contact.id,
        config: input.ai,
      });
  const responseHash = createHash("sha256")
    .update(exactFinalResponse)
    .digest("hex");
  const deliveryEligible = deterministicQuality.passed && finalVerification.approved;

  return {
    caseId: input.case.id,
    exactFinalResponse,
    responseHash,
    responseModelId,
    firstVerifierModelId,
    finalVerifierModelId: finalVerification.modelId,
    responseEvidence,
    grounding,
    decision,
    policy,
    handoff,
    deterministicQuality,
    finalVerificationApproved: finalVerification.approved,
    finalVerifierIssues: finalVerification.issues,
    deliveryEligible,
    groundedHeraFacts: grounding.required ? grounding.grounded : true,
    providerSendCount: 0,
    duplicateFinalCandidates: 0,
  };
}
