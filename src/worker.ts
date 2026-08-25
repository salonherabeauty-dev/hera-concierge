import { randomUUID } from "node:crypto";
import {
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
  generateReceptionistDecision,
  RESPONSE_PROMPT_VERSION,
  VERIFIER_PROMPT_VERSION,
  verifyFinalClientReply,
  verifyReceptionistDecision,
  type AiRuntimeConfig,
} from "./ai/receptionist.js";
import {
  getAiConfig,
  getD360Config,
  getDatabaseConfig,
  getMetaConfig,
  getOperationsConfig,
  getWhatsAppProviderConfig,
} from "./config.js";
import {
  SupabaseReceptionistRepository,
  type ReceptionistRepository,
} from "./db/repository.js";
import {
  D360CoexistenceStore,
  type OutboundAuthorizationDisposition,
} from "./db/coexistence.js";
import {
  assessHumanHandoff,
  HUMAN_HANDOFF_POLICY_VERSION,
  type HumanHandoffAssessment,
} from "./policy/handoff.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
  POLICY_VERSION,
  urgentSafetyReplyFor,
} from "./policy/risk.js";
import {
  assessGrounding,
  GROUNDING_POLICY_VERSION,
  type GroundingAssessment,
} from "./policy/grounding.js";
import { assessCustomerCareWindow } from "./policy/customerCareWindow.js";
import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "./policy/finalResponseQuality.js";
import { detectSupportedClientLocale } from "./policy/locale.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "./observability/log.js";
import type {
  AgentDecision,
  AgentHandoffFacts,
  DrainSummary,
  PolicyAssessment,
  JsonValue,
  MessageKind,
  ReceptionistJob,
} from "./types.js";
import {
  isRetryableWhatsAppError,
  MetaWhatsAppClient,
  type WhatsAppTransport,
} from "./whatsapp/client.js";
import { D360WhatsAppClient } from "./whatsapp/d360Client.js";
import { interpretInboundMedia } from "./whatsapp/media.js";

interface WorkerRuntime {
  repository: ReceptionistRepository;
  whatsapp: WhatsAppTransport;
  ai: AiRuntimeConfig;
  sendMode: "shadow" | "live";
  managementWaId: string | null;
  authorizeOutbound?: (
    outboxId: string,
  ) => Promise<OutboundAuthorizationDisposition>;
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

function emptyHandoffFacts(): AgentHandoffFacts {
  return {
    service: null,
    stylist: null,
    outlet: null,
    date: null,
    time: null,
    flexibility: null,
    appointmentReference: null,
    desiredOutcome: null,
    symptoms: null,
    photos: null,
    other: null,
  };
}

function deadLetterFallbackReply(clientMessage: string): string {
  const locale = detectSupportedClientLocale(clientMessage);
  if (locale === "zh") {
    return "感谢您的消息。很抱歉，我目前无法安全地完成这项查询。我已将您的消息交给 Hera 的沙龙经理直接审核，团队将继续协助您。如果您出现呼吸困难、严重肿胀、眼睛接触化学品或剧烈疼痛，请立即就医。";
  }
  if (locale === "ms") {
    return "Terima kasih atas mesej anda. Maaf, saya tidak dapat melengkapkan semakan ini dengan selamat buat masa ini. Saya telah menyerahkan mesej anda kepada pengurus salon Hera untuk semak secara langsung, dan pasukan akan membantu anda seterusnya. Jika anda mengalami kesukaran bernafas, bengkak teruk, bahan kimia terkena mata atau sakit yang teruk, dapatkan rawatan perubatan segera.";
  }
  if (locale === "ta") {
    return "உங்கள் செய்திக்கு நன்றி. மன்னிக்கவும், இப்போது இந்தச் சரிபார்ப்பை பாதுகாப்பாக முடிக்க முடியவில்லை. உங்கள் செய்தியை நேரடி மதிப்பாய்விற்காக Hera சலூன் மேலாளரிடம் ஒப்படைத்துள்ளேன்; குழு தொடர்ந்து உங்களுக்கு உதவும். மூச்சுத் திணறல், கடுமையான வீக்கம், கண்ணில் இரசாயனம் படுதல் அல்லது கடுமையான வலி இருந்தால், உடனடியாக மருத்துவ உதவி பெறுங்கள்.";
  }
  return "Thank you for your message. I’m sorry, but I’m unable to complete the check safely just now. I’ve placed your message with Hera’s salon manager for direct review, and the team will assist you from here. If you are experiencing breathing difficulty, severe swelling, eye exposure or severe pain, please seek urgent medical attention immediately.";
}

function staticUrgentDecision(input: string): AgentDecision {
  return {
    reply: urgentSafetyReplyFor(input),
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
        "Review immediately, ensure emergency guidance has been given, and contact the client only when it is safe and appropriate.",
      collectedFacts: {
        service: null,
        stylist: null,
        outlet: null,
        date: null,
        time: null,
        flexibility: null,
        appointmentReference: null,
        desiredOutcome: null,
        symptoms: input.slice(0, 600),
        photos: null,
        other: null,
      },
      missingFacts: [],
      clientAcknowledgement: null,
    },
    rationale: "Deterministic urgent-safety policy matched the client message.",
  };
}

export function clientReplyDedupeKey(sourceMessageId: string): string {
  return `client-reply:${sourceMessageId}`;
}

export function managementAlertDedupeKey(sourceMessageId: string): string {
  return `management-alert:${sourceMessageId}`;
}

export function isReplyWorthyMessage(kind: MessageKind): boolean {
  return kind !== "reaction" && kind !== "system";
}

async function completeSupersededJob(
  runtime: WorkerRuntime,
  job: ReceptionistJob,
  stage: string,
): Promise<boolean> {
  if (!(await runtime.repository.isInboundSuperseded(job.sourceMessageId))) {
    return false;
  }
  await runtime.repository.audit(
    "out_of_order_inbound_suppressed",
    "message",
    job.sourceMessageId,
    {
      suppressionStage: stage,
      jobId: job.id,
      reason: "newer_inbound_recorded_before_side_effects",
    },
  );
  await runtime.repository.completeJob(job.id);
  return true;
}

async function processJob(runtime: WorkerRuntime, job: ReceptionistJob): Promise<void> {
  if (await completeSupersededJob(runtime, job, "before_context_load")) return;
  const context = await runtime.repository.getJobContext(job);
  if (!isReplyWorthyMessage(context.message.kind)) {
    await runtime.repository.audit(
      "non_conversational_message_recorded",
      "message",
      context.message.id,
      { kind: context.message.kind },
    );
    await runtime.repository.completeJob(job.id);
    return;
  }
  const interpreted = await interpretInboundMedia(
    context.message,
    runtime.whatsapp,
    runtime.ai.transcriptionModel,
  );
  if (interpreted.text !== context.message.text) {
    await runtime.repository.updateMessageText(context.message.id, interpreted.text);
  }

  const history = await runtime.repository.getConversationHistory(
    context.message.conversationId,
    16,
    context.message.createdAt,
  );
  const deterministic = classifyDeterministicRisk(interpreted.text);

  let decision: AgentDecision;
  let responseModelId: string | null = null;
  let responseUsage: JsonValue = {};
  let responseEvidence: JsonValue = [];
  let responseLatencyMs = 0;
  let grounding: GroundingAssessment;

  if (deterministic.risk === "black") {
    decision = staticUrgentDecision(interpreted.text);
  } else {
    const generated = await generateReceptionistDecision({
      repository: runtime.repository,
      context,
      history,
      interpreted,
      config: runtime.ai,
    });
    decision = generated.decision;
    responseModelId = generated.modelId;
    responseUsage = generated.usage;
    responseEvidence = generated.evidence;
    responseLatencyMs = generated.latencyMs;

    const verification = await verifyReceptionistDecision({
      originalMessage: interpreted.text,
      history,
      decision,
      evidence: generated.evidence,
      contactId: context.contact.id,
      config: runtime.ai,
    });
    if (!verification.approved && !verification.correctedReply) {
      throw new Error("Verifier rejected the client reply without a correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("Verifier rejected the human handoff without a correction");
    }
    decision = {
      ...decision,
      reply: verification.approved
        ? decision.reply
        : verification.correctedReply!,
      risk: highestRisk(decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? decision.handoff
        : verification.correctedHandoff!,
    };
    await runtime.repository.recordDecision({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      stage: "verification",
      modelId: verification.modelId,
      promptVersion: VERIFIER_PROMPT_VERSION,
      policyVersion: POLICY_VERSION,
      risk: verification.risk,
      confidence: verification.approved ? 1 : 0.7,
      output: asJson(verification),
      usage: verification.usage,
      latencyMs: verification.latencyMs,
    });
  }

  if (
    await completeSupersededJob(
      runtime,
      job,
      "after_primary_and_first_verifier",
    )
  ) return;

  grounding = assessGrounding(interpreted.text, decision);
  if (!grounding.grounded && grounding.replyOverride) {
    const ungroundedDecision = decision;
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
    await runtime.repository.audit(
      "grounding_fallback_applied",
      "message",
      context.message.id,
      asJson({
        groundingPolicyVersion: GROUNDING_POLICY_VERSION,
        intent: ungroundedDecision.intent,
        flags: grounding.flags,
        proposedSourceIds: ungroundedDecision.sources.map((source) => source.id),
        factualBasis: ungroundedDecision.factualBasis,
      }),
    );
  }

  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "response",
    modelId: responseModelId,
    promptVersion: RESPONSE_PROMPT_VERSION,
    policyVersion: POLICY_VERSION,
    risk: decision.risk,
    confidence: decision.confidence,
    output: asJson({ decision, evidence: responseEvidence, grounding }),
    usage: responseUsage,
    latencyMs: responseLatencyMs,
  });

  const policy = assessPolicy(
    interpreted.text,
    decision,
    context.conversationRisk,
  );
  const handoff = assessHumanHandoff({
    message: interpreted.text,
    decision,
    policy,
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
  });
  const draftFinalReply = cleanReply(
    handoff.clientReplyOverride ?? policy.replyOverride ?? decision.reply,
  );
  const deterministicDraftQuality = assessFinalResponseQuality({
    clientMessage: interpreted.text,
    reply: draftFinalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const initialFinalVerification = await verifyFinalClientReply({
    originalMessage: interpreted.text,
    history,
    draftReply: draftFinalReply,
    decision,
    evidence: responseEvidence,
    policy,
    handoff,
    deterministicDraftQuality: asJson(deterministicDraftQuality),
    contactId: context.contact.id,
    config: runtime.ai,
  });
  const finalReply = cleanReply(
    initialFinalVerification.approved
      ? draftFinalReply
      : initialFinalVerification.correctedReply!,
  );
  const finalQuality = assessFinalResponseQuality({
    clientMessage: interpreted.text,
    reply: finalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const finalVerification = initialFinalVerification.approved
    ? initialFinalVerification
    : await verifyFinalClientReply({
        originalMessage: interpreted.text,
        history,
        draftReply: finalReply,
        decision,
        evidence: responseEvidence,
        policy,
        handoff,
        deterministicDraftQuality: asJson(finalQuality),
        contactId: context.contact.id,
        config: runtime.ai,
      });
  if (
    await completeSupersededJob(
      runtime,
      job,
      "after_final_response_verifier",
    )
  ) return;

  const deliveryEligible = finalQuality.passed && finalVerification.approved;
  const verificationUsage = asJson({
    initial: initialFinalVerification.usage,
    exactFinal:
      finalVerification === initialFinalVerification
        ? null
        : finalVerification.usage,
  });
  const verificationLatencyMs =
    initialFinalVerification.latencyMs +
    (finalVerification === initialFinalVerification
      ? 0
      : finalVerification.latencyMs);
  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "policy",
    modelId: finalVerification.modelId,
    promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
    policyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    risk: policy.risk,
    confidence: deliveryEligible
      ? decision.confidence
      : Math.min(decision.confidence, 0.2),
    output: asJson({
      responsePromptVersion: RESPONSE_PROMPT_VERSION,
      verifierPromptVersion: VERIFIER_PROMPT_VERSION,
      deterministicPolicyVersion: POLICY_VERSION,
      groundingPolicyVersion: GROUNDING_POLICY_VERSION,
      handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION,
      finalQualityPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
      policy,
      handoff,
      draftFinalReply,
      deterministicDraftQuality,
      initialFinalVerification: {
        approved: initialFinalVerification.approved,
        correctedReply: initialFinalVerification.correctedReply,
        issues: initialFinalVerification.issues,
        scores: initialFinalVerification.scores,
        summary: initialFinalVerification.summary,
        modelId: initialFinalVerification.modelId,
        promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        latencyMs: initialFinalVerification.latencyMs,
        usage: initialFinalVerification.usage,
      },
      finalReply,
      finalQuality,
      finalVerification: {
        approved: finalVerification.approved,
        correctedReply: finalVerification.correctedReply,
        issues: finalVerification.issues,
        scores: finalVerification.scores,
        summary: finalVerification.summary,
        modelId: finalVerification.modelId,
        promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        latencyMs: finalVerification.latencyMs,
        usage: finalVerification.usage,
      },
      correctionReverified:
        initialFinalVerification.approved || finalVerification.approved,
      deliveryEligible,
    }),
    usage: verificationUsage,
    latencyMs: verificationLatencyMs,
  });
  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);

  if (
    await completeSupersededJob(
      runtime,
      job,
      "before_operational_side_effects",
    )
  ) return;

  if (policy.requiresIncident && policy.risk !== "green") {
    await runtime.repository.openIncident({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      category: decision.intent,
      severity: policy.risk,
      clientSummary: interpreted.text,
      evidence: asJson({
        messageKind: context.message.kind,
        groundingFlags: grounding.flags,
        securityFlags: policy.securityFlags,
        blockedActions: policy.blockedActions,
      }),
    });
  }


  if (handoff.createTask) {
    if (
      await completeSupersededJob(
        runtime,
        job,
        "before_handoff_persistence",
      )
    ) return;
    if (
      !handoff.taskType ||
      !handoff.scope ||
      !handoff.priority ||
      !handoff.summary ||
      !handoff.requestedAction ||
      !handoff.dedupeKey
    ) {
      throw new Error("Human handoff assessment was incomplete");
    }

    const task = await runtime.repository.upsertAutomaticHandoff({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      taskType: handoff.taskType,
      scope: handoff.scope,
      priority: handoff.priority,
      assignedRole: handoff.assignedRole,
      assignedOutlet: handoff.assignedOutlet,
      summary: handoff.summary,
      requestedAction: handoff.requestedAction,
      collectedFacts: handoff.collectedFacts,
      missingFacts: handoff.missingFacts,
      clientVisibleStatus: deliveryEligible ? finalReply : null,
      dedupeKey: handoff.dedupeKey,
    });

    await runtime.repository.audit(
      task.inserted
        ? "automatic_handoff_created"
        : "automatic_handoff_refreshed",
      "handoff_task",
      task.taskId,
      asJson({
        sourceMessageId: context.message.id,
        conversationId: context.message.conversationId,
        taskType: handoff.taskType,
        scope: handoff.scope,
        priority: handoff.priority,
        assignedRole: handoff.assignedRole,
        assignedOutlet: handoff.assignedOutlet,
        status: task.status,
        version: task.version,
      }),
    );
  }

  if (!deliveryEligible) {
    await runtime.repository.audit(
      "final_response_quality_blocked",
      "message",
      context.message.id,
      asJson({
        conversationId: context.message.conversationId,
        intent: decision.intent,
        risk: policy.risk,
        handoffTaskType: handoff.taskType,
        handoffScope: handoff.scope,
        deterministicIssues: finalQuality.issues,
        finalVerifierApproved: finalVerification.approved,
        finalVerifierIssues: finalVerification.issues,
        finalVerifierModelId: finalVerification.modelId,
        finalVerifierPromptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        finalQualityPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
      }),
    );

    if (!handoff.createTask || handoff.scope === "task_only") {
      await runtime.repository.upsertAutomaticHandoff({
        conversationId: context.message.conversationId,
        sourceMessageId: context.message.id,
        taskType: "system_failure",
        scope: "full_takeover",
        priority: "high",
        assignedRole: "salon_manager",
        assignedOutlet: handoff.assignedOutlet,
        summary: "Final client response failed Hera’s quality gate.",
        requestedAction:
          "Review the exact client message and prepare a safe, specific and service-led response before returning the conversation to AI.",
        collectedFacts: handoff.collectedFacts,
        missingFacts: [],
        clientVisibleStatus: null,
        dedupeKey: `final-response-quality:${context.message.id}`,
      });
    }
  }

  if (deliveryEligible && (policy.canAutoSend || handoff.createTask)) {
    if (
      await completeSupersededJob(
        runtime,
        job,
        "before_client_candidate_persistence",
      )
    ) return;
    await runtime.repository.queueOutbound({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      toWaId: context.contact.waId,
      targetType: "client",
      body: finalReply,
      dedupeKey: clientReplyDedupeKey(context.message.id),
      authorization: "auto",
    });
  }

  if (policy.requiresManagementNotification && runtime.managementWaId) {
    const displayName = context.contact.profileName?.slice(0, 80) || "client";
    const summary = interpreted.text.replace(/[\r\n]+/g, " ").slice(0, 600);
    const containmentStatus = deliveryEligible
      ? "The AI prepared a final quality-checked containment response for the client."
      : "The final client response was blocked by Hera’s quality gate and requires human handling.";
    await runtime.repository.queueOutbound({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      toWaId: runtime.managementWaId,
      targetType: "management",
      body: `Hera AI ${policy.risk.toUpperCase()} concern from ${displayName} (WhatsApp ending ${context.contact.waId.slice(-4)}). Intent: ${decision.intent}. ${containmentStatus} Summary: ${summary}`,
      dedupeKey: managementAlertDedupeKey(context.message.id),
      // Management alerts are review-only until a separately approved template
      // or non-WhatsApp incident channel is configured.
      authorization: "management",
    });
  }

  await runtime.repository.completeJob(job.id);
}

async function queueDeadLetterFallback(
  repository: ReceptionistRepository,
  job: ReceptionistJob,
): Promise<void> {
  const context = await repository.getJobContext(job);
  const fallbackReply = deadLetterFallbackReply(context.message.text);
  const fallbackFacts = emptyHandoffFacts();
  const fallbackHandoff: HumanHandoffAssessment = {
    createTask: true,
    taskType: "system_failure",
    scope: "full_takeover",
    priority: "high",
    assignedRole: "salon_manager",
    assignedOutlet: null,
    summary: "AI processing failed after all protected retries.",
    requestedAction:
      "Review the client’s exact message and respond directly before returning the conversation to AI.",
    collectedFacts: fallbackFacts,
    missingFacts: [],
    clientReplyOverride: fallbackReply,
    clientVisibleStatus: fallbackReply,
    dedupeKey: `dead-letter-handoff:${context.message.id}`,
    reason: "Protected AI processing could not complete after all retries.",
  };
  const fallbackDecision: AgentDecision = {
    reply: fallbackReply,
    intent: "other",
    risk: "amber",
    confidence: 1,
    language: "same as client where reliably supported",
    sources: [],
    factualBasis: ["safety_policy"],
    proposedActions: ["create_handoff_task"],
    requiresManagementNotification: true,
    handoff: {
      required: true,
      taskType: "system_failure",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: null,
      summary: fallbackHandoff.summary,
      requestedAction: fallbackHandoff.requestedAction,
      collectedFacts: fallbackFacts,
      missingFacts: [],
      clientAcknowledgement: fallbackReply,
    },
    rationale: "Fail-closed human ownership after protected AI processing failed.",
  };
  const fallbackPolicy: PolicyAssessment = {
    risk: "amber",
    canAutoSend: true,
    requiresManagementNotification: true,
    requiresIncident: true,
    blockedActions: [],
    securityFlags: [],
    replyOverride: null,
  };
  const fallbackQuality = assessFinalResponseQuality({
    clientMessage: context.message.text,
    reply: fallbackReply,
    decision: fallbackDecision,
    policy: fallbackPolicy,
    handoff: fallbackHandoff,
    risk: "amber",
  });
  if (!fallbackQuality.passed) {
    throw new Error("Dead-letter fallback failed Hera’s deterministic quality gate");
  }

  await repository.upsertAutomaticHandoff({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    taskType: fallbackHandoff.taskType!,
    scope: fallbackHandoff.scope!,
    priority: fallbackHandoff.priority!,
    assignedRole: fallbackHandoff.assignedRole,
    assignedOutlet: fallbackHandoff.assignedOutlet,
    summary: fallbackHandoff.summary!,
    requestedAction: fallbackHandoff.requestedAction!,
    collectedFacts: fallbackHandoff.collectedFacts,
    missingFacts: fallbackHandoff.missingFacts,
    clientVisibleStatus: fallbackReply,
    dedupeKey: fallbackHandoff.dedupeKey!,
  });
  await repository.queueOutbound({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    toWaId: context.contact.waId,
    targetType: "client",
    body: fallbackReply,
    dedupeKey: `dead-letter-reply:${context.message.id}`,
    authorization: "auto",
  });
  await repository.audit("job_dead_lettered", "job", job.id, {
    sourceMessageId: job.sourceMessageId,
    humanHandoffCreated: true,
  });
}

export async function drainOutbox(input: {
  repository: ReceptionistRepository;
  whatsapp?: WhatsAppTransport;
  sendMode: "shadow" | "live";
  workerId: string;
  limit?: number;
  authorizeOutbound?: (
    outboxId: string,
  ) => Promise<OutboundAuthorizationDisposition>;
}): Promise<Pick<
  DrainSummary,
  | "outboxClaimed"
  | "outboxSent"
  | "outboxShadowed"
  | "outboxRetried"
  | "outboxDead"
>> {
  const items = await input.repository.claimOutbox(input.workerId, input.limit ?? 20);
  let outboxSent = 0;
  let outboxShadowed = 0;
  let outboxRetried = 0;
  let outboxDead = 0;

  for (const item of items) {
    if (input.sendMode === "shadow" || item.authorization !== "auto") {
      await input.repository.markOutboxShadowed(item.id);
      outboxShadowed += 1;
      continue;
    }

    if (item.targetType === "client") {
      let sourceReceivedAt: string | null = null;
      try {
        sourceReceivedAt = item.sourceMessageId
          ? await input.repository.getSourceMessageProviderTimestamp(item.sourceMessageId)
          : null;
      } catch (error) {
        const status = await input.repository.retryOutbox(item, error, true);
        if (status === "retry") outboxRetried += 1;
        else outboxDead += 1;
        logOperationalEvent("warn", "outbox_window_check_failed", {
          outboxId: item.id,
          targetType: item.targetType,
          attempt: item.attempts,
          retryable: true,
          disposition: status,
          ...safeErrorFields(error),
        });
        continue;
      }

      const window = assessCustomerCareWindow(sourceReceivedAt);
      if (!window.allowed) {
        const error = new Error("WhatsApp free-form reply blocked by customer-service-window guard");
        error.name = "CustomerServiceWindowError";
        const status = await input.repository.retryOutbox(item, error, false);
        outboxDead += 1;
        logOperationalEvent("error", "outbox_freeform_window_blocked", {
          outboxId: item.id,
          targetType: item.targetType,
          attempt: item.attempts,
          retryable: false,
          disposition: status,
          windowReason: window.reason,
          ageSeconds:
            window.ageMs === null ? null : Math.max(0, Math.round(window.ageMs / 1000)),
        });
        continue;
      }
    }

    if (input.authorizeOutbound) {
      let disposition: OutboundAuthorizationDisposition;
      try {
        disposition = await input.authorizeOutbound(item.id);
      } catch (error) {
        const status = await input.repository.retryOutbox(item, error, true);
        if (status === "retry") outboxRetried += 1;
        else outboxDead += 1;
        logOperationalEvent("warn", "outbox_coexistence_guard_failed", {
          outboxId: item.id,
          targetType: item.targetType,
          attempt: item.attempts,
          retryable: true,
          disposition: status,
          ...safeErrorFields(error),
        });
        continue;
      }

      if (disposition !== "authorized") {
        if (disposition === "shadowed") outboxShadowed += 1;
        else outboxDead += 1;
        logOperationalEvent(
          disposition === "shadowed" ? "info" : "error",
          "outbox_provider_send_suppressed",
          {
            outboxId: item.id,
            targetType: item.targetType,
            disposition,
          },
        );
        continue;
      }
    }

    try {
      if (!input.whatsapp) throw new Error("Live mode requires a WhatsApp transport");
      const result = await input.whatsapp.sendText(item.toWaId, item.body);
      await input.repository.markOutboxSent(item.id, result.providerMessageId);
      outboxSent += 1;
    } catch (error) {
      const retryable = isRetryableWhatsAppError(error);
      const status = await input.repository.retryOutbox(item, error, retryable);
      if (status === "retry") outboxRetried += 1;
      else outboxDead += 1;
      logOperationalEvent(status === "retry" ? "warn" : "error", "outbox_send_failed", {
        outboxId: item.id,
        targetType: item.targetType,
        attempt: item.attempts,
        retryable,
        disposition: status,
        ...safeErrorFields(error),
      });
    }
  }

  return {
    outboxClaimed: items.length,
    outboxSent,
    outboxShadowed,
    outboxRetried,
    outboxDead,
  };
}

async function drainClaimedReceptionistJobs(
  runtime: WorkerRuntime,
  workerId: string,
  jobs: ReceptionistJob[],
): Promise<DrainSummary> {
  let jobsCompleted = 0;
  let jobsRetried = 0;

  for (const job of jobs) {
    try {
      await processJob(runtime, job);
      jobsCompleted += 1;
    } catch (error) {
      const status = await runtime.repository.retryJob(job, error);
      jobsRetried += 1;
      logOperationalEvent(status === "retry" ? "warn" : "error", "job_processing_failed", {
        jobId: job.id,
        attempt: job.attempts,
        disposition: status,
        ...safeErrorFields(error),
      });
      if (status === "dead") {
        await queueDeadLetterFallback(runtime.repository, job).catch(() => undefined);
      }
    }
  }

  const outbox = await drainOutbox({
    repository: runtime.repository,
    whatsapp: runtime.whatsapp,
    sendMode: runtime.sendMode,
    workerId,
    authorizeOutbound: runtime.authorizeOutbound,
  });
  return {
    jobsClaimed: jobs.length,
    jobsCompleted,
    jobsRetried,
    ...outbox,
  };
}

export async function drainReceptionist(
  runtime: WorkerRuntime,
  maxJobs = 8,
): Promise<DrainSummary> {
  const workerId = `vercel:${randomUUID()}`;
  const jobs = await runtime.repository.claimJobs(workerId, maxJobs);
  return drainClaimedReceptionistJobs(runtime, workerId, jobs);
}

export async function drainReceptionistForJobs(
  runtime: WorkerRuntime,
  jobIds: string[],
  maxJobs = 8,
): Promise<DrainSummary> {
  const requestedJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);
  if (requestedJobIds.length === 0) {
    return drainReceptionist(runtime, maxJobs);
  }
  if (!runtime.repository.claimJobsByIds) {
    throw new Error("Targeted job claiming is unavailable");
  }

  const workerId = `vercel:targeted:${randomUUID()}`;
  const capacity = Math.max(
    requestedJobIds.length,
    Math.max(1, Math.min(maxJobs, 25)),
  );
  const targetedJobs = await runtime.repository.claimJobsByIds(
    workerId,
    requestedJobIds,
  );
  const targetedIds = new Set(targetedJobs.map((job) => job.id));
  const remainingCapacity = Math.max(0, capacity - targetedJobs.length);
  const backlogJobs = remainingCapacity > 0
    ? await runtime.repository.claimJobs(workerId, remainingCapacity)
    : [];
  const jobs = [
    ...targetedJobs,
    ...backlogJobs.filter((job) => !targetedIds.has(job.id)),
  ];

  return drainClaimedReceptionistJobs(runtime, workerId, jobs);
}

export function createProductionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): WorkerRuntime {
  const database = getDatabaseConfig(env);
  const operations = getOperationsConfig(env);
  const provider = getWhatsAppProviderConfig(env).provider;

  let whatsapp: WhatsAppTransport;
  let authorizeOutbound:
    | ((outboxId: string) => Promise<OutboundAuthorizationDisposition>)
    | undefined;

  if (provider === "360dialog") {
    const d360 = getD360Config(env);
    const coexistence = new D360CoexistenceStore(
      database.url,
      database.serviceRoleKey,
    );
    whatsapp = new D360WhatsAppClient({
      apiKey: d360.apiKey,
      baseUrl: d360.baseUrl,
    });
    authorizeOutbound = (outboxId) => coexistence.authorizeOutbound(outboxId);
  } else {
    const meta = getMetaConfig(env);
    whatsapp = new MetaWhatsAppClient({
      graphApiVersion: meta.graphApiVersion,
      accessToken: meta.accessToken,
      phoneNumberId: meta.phoneNumberId,
    });
  }

  return {
    repository: new SupabaseReceptionistRepository(database.url, database.serviceRoleKey),
    whatsapp,
    ai: getAiConfig(env),
    sendMode: operations.sendMode,
    managementWaId: operations.managementWaId,
    authorizeOutbound,
  };
}
