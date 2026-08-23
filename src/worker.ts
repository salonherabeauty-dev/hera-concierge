import { randomUUID } from "node:crypto";
import {
  generateReceptionistDecision,
  RESPONSE_PROMPT_VERSION,
  VERIFIER_PROMPT_VERSION,
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
  logOperationalEvent,
  safeErrorFields,
} from "./observability/log.js";
import type {
  AgentDecision,
  DrainSummary,
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

function staticUrgentDecision(input: string): AgentDecision {
  return {
    reply: urgentSafetyReplyFor(input),
    intent: "medical_safety",
    risk: "black",
    confidence: 1,
    language: "same as client where reliable",
    sources: [],
    factualBasis: ["safety_policy"],
    proposedActions: ["urgent_safety_guidance", "open_incident", "notify_management"],
    requiresManagementNotification: true,
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

async function processJob(runtime: WorkerRuntime, job: ReceptionistJob): Promise<void> {
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
      decision,
      evidence: generated.evidence,
      contactId: context.contact.id,
      config: runtime.ai,
    });
    decision = {
      ...decision,
      reply:
        verification.approved || !verification.correctedReply
          ? decision.reply
          : verification.correctedReply,
      risk: highestRisk(decision.risk, verification.risk),
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
  const finalReply = cleanReply(policy.replyOverride ?? decision.reply);
  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "policy",
    modelId: null,
    promptVersion: RESPONSE_PROMPT_VERSION,
    policyVersion: POLICY_VERSION,
    risk: policy.risk,
    confidence: decision.confidence,
    output: asJson({ policy, finalReply }),
  });
  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);

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

  if (policy.canAutoSend) {
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
    const containmentStatus =
      "The AI prepared a policy-checked containment response for the client.";
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
  await repository.queueOutbound({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    toWaId: context.contact.waId,
    targetType: "client",
    body:
      "Thank you for your message. I’m sorry—Hera’s concierge could not complete the check just now. Please resend your message in a few minutes, or use our secure booking page for bookings: https://bookings.gettimely.com/herabeauty1/bb/book. If this concerns breathing difficulty, severe swelling, eye exposure or another urgent symptom, seek urgent medical attention now.",
    dedupeKey: `dead-letter-reply:${context.message.id}`,
    authorization: "auto",
  });
  await repository.audit("job_dead_lettered", "job", job.id, {
    sourceMessageId: job.sourceMessageId,
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

export async function drainReceptionist(
  runtime: WorkerRuntime,
  maxJobs = 8,
): Promise<DrainSummary> {
  const workerId = `vercel:${randomUUID()}`;
  const jobs = await runtime.repository.claimJobs(workerId, maxJobs);
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
