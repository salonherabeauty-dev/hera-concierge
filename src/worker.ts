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
  getDatabaseConfig,
  getMetaConfig,
  getOperationsConfig,
} from "./config.js";
import {
  SupabaseReceptionistRepository,
  type ReceptionistRepository,
} from "./db/repository.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
  POLICY_VERSION,
  URGENT_SAFETY_REPLY,
} from "./policy/risk.js";
import type {
  AgentDecision,
  DrainSummary,
  JsonValue,
  MessageKind,
  ReceptionistJob,
} from "./types.js";
import { MetaWhatsAppClient, type WhatsAppTransport } from "./whatsapp/client.js";
import { interpretInboundMedia } from "./whatsapp/media.js";

interface WorkerRuntime {
  repository: ReceptionistRepository;
  whatsapp: WhatsAppTransport;
  ai: AiRuntimeConfig;
  sendMode: "shadow" | "live";
  managementWaId: string | null;
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

function staticUrgentDecision(): AgentDecision {
  return {
    reply: URGENT_SAFETY_REPLY,
    intent: "medical_safety",
    risk: "black",
    confidence: 1,
    language: "same as client where reliable",
    sources: [],
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

  if (deterministic.risk === "black") {
    decision = staticUrgentDecision();
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
      waId: context.contact.waId,
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

  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "response",
    modelId: responseModelId,
    promptVersion: RESPONSE_PROMPT_VERSION,
    policyVersion: POLICY_VERSION,
    risk: decision.risk,
    confidence: decision.confidence,
    output: asJson({ decision, evidence: responseEvidence }),
    usage: responseUsage,
    latencyMs: responseLatencyMs,
  });

  const policy = assessPolicy(interpreted.text, decision);
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
    await runtime.repository.queueOutbound({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      toWaId: runtime.managementWaId,
      targetType: "management",
      body: `Hera AI ${policy.risk.toUpperCase()} concern from ${displayName} (WhatsApp ending ${context.contact.waId.slice(-4)}). Intent: ${decision.intent}. The AI sent a safe containment response. Summary: ${summary}`,
      dedupeKey: managementAlertDedupeKey(context.message.id),
      authorization: "auto",
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
}): Promise<Pick<
  DrainSummary,
  "outboxClaimed" | "outboxSent" | "outboxShadowed" | "outboxRetried"
>> {
  const items = await input.repository.claimOutbox(input.workerId, input.limit ?? 20);
  let outboxSent = 0;
  let outboxShadowed = 0;
  let outboxRetried = 0;

  for (const item of items) {
    try {
      if (input.sendMode === "shadow" || item.authorization !== "auto") {
        await input.repository.markOutboxShadowed(item.id);
        outboxShadowed += 1;
        continue;
      }
      if (!input.whatsapp) throw new Error("Live mode requires a WhatsApp transport");
      const result = await input.whatsapp.sendText(item.toWaId, item.body);
      await input.repository.markOutboxSent(item.id, result.providerMessageId);
      outboxSent += 1;
    } catch (error) {
      await input.repository.retryOutbox(item, error);
      outboxRetried += 1;
    }
  }

  return {
    outboxClaimed: items.length,
    outboxSent,
    outboxShadowed,
    outboxRetried,
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
  const meta = getMetaConfig(env);
  const operations = getOperationsConfig(env);
  return {
    repository: new SupabaseReceptionistRepository(database.url, database.serviceRoleKey),
    whatsapp: new MetaWhatsAppClient({
      graphApiVersion: meta.graphApiVersion,
      accessToken: meta.accessToken,
      phoneNumberId: meta.phoneNumberId,
    }),
    ai: getAiConfig(env),
    sendMode: operations.sendMode,
    managementWaId: operations.managementWaId,
  };
}
