import { randomUUID } from "node:crypto";
import {
  getAiConfig,
  getD360Config,
  getDatabaseConfig,
} from "../config.js";
import {
  SupabaseReceptionistRepository,
  type ReceptionistRepository,
} from "../db/repository.js";
import type { JsonValue } from "../types.js";
import {
  HERA_RESET_ARCHITECTURE_VERSION,
  HERA_RESET_MAX_MODEL_CALLS,
  HERA_RESET_MODEL_ID,
} from "./config.js";
import { buildResetEvidencePacket } from "./knowledge.js";
import {
  D360ResetMediaDownloader,
  materializeResetTurn,
  type ResetMediaDownloader,
} from "./media.js";
import {
  draftResetReply,
  RESET_REWRITE_PROMPT_VERSION,
  RESET_WRITER_PROMPT_VERSION,
  rewriteResetReply,
} from "./model.js";
import { ResetReceptionistRepository } from "./repository.js";
import type {
  ResetClaimedDraft,
  ResetEvidencePacket,
  ResetMaterializedTurn,
  ResetModelCallResult,
} from "./types.js";
import { validateResetDraft } from "./validator.js";

export interface ResetWorkerRuntime {
  repository: ResetReceptionistRepository;
  knowledgeRepository: ReceptionistRepository;
  mediaDownloader: ResetMediaDownloader;
  transcriptionModel: string;
}

export interface ResetDrainSummary {
  claimed: number;
  ready: number;
  failed: number;
  superseded: number;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function safeFailure(error: unknown): {
  code: string;
  message: string;
  technical: JsonValue;
} {
  const name = error instanceof Error ? error.name : "UnknownError";
  const detail = error instanceof Error ? error.message : String(error);
  const combined = `${name} ${detail}`;

  if (/abort|timeout|timed out/i.test(combined)) {
    return {
      code: "openai_timeout",
      message:
        "OpenAI did not finish this draft within the protected processing window. Retry once or write the reply manually.",
      technical: { name, category: "timeout" },
    };
  }
  if (/rate.?limit|429/i.test(combined)) {
    return {
      code: "openai_rate_limited",
      message:
        "OpenAI is temporarily busy. Retry once after a short pause or write the reply manually.",
      technical: { name, category: "rate_limit" },
    };
  }
  if (/media|download|attachment|transcrib/i.test(combined)) {
    return {
      code: "attachment_processing_failed",
      message:
        "One or more attachments could not be prepared for AI review. Retry once or write the reply manually using the visible conversation.",
      technical: { name, category: "attachment" },
    };
  }
  if (/knowledge|appointment lookup|database/i.test(combined)) {
    return {
      code: "evidence_retrieval_failed",
      message:
        "The verified Hera information needed for this reply could not be loaded. Retry once or write the reply manually.",
      technical: { name, category: "evidence" },
    };
  }
  return {
    code: "ai_draft_failed",
    message:
      "The AI could not prepare a safe reply for this client turn. Retry once or write the reply manually.",
    technical: { name, category: "generation" },
  };
}

function totalLatency(calls: ResetModelCallResult[]): number {
  return calls.reduce((total, call) => total + call.latencyMs, 0);
}

function modelMetadata(input: {
  calls: ResetModelCallResult[];
  materialized: ResetMaterializedTurn;
  evidence: ResetEvidencePacket;
  operatingMode: string;
}): JsonValue {
  return asJson({
    architectureVersion: HERA_RESET_ARCHITECTURE_VERSION,
    writerPromptVersion: RESET_WRITER_PROMPT_VERSION,
    rewritePromptVersion:
      input.calls.length > 1 ? RESET_REWRITE_PROMPT_VERSION : null,
    modelCalls: input.calls.length,
    totalLatencyMs: totalLatency(input.calls),
    usages: input.calls.map((call) => call.usage),
    attachmentWarnings: input.materialized.warnings,
    transcriptionCount: input.materialized.transcriptionCount,
    retrievalQueries: input.evidence.queries,
    retrievalWarnings: input.evidence.retrievalWarnings,
    operatingModeObserved: input.operatingMode,
    deliveryControl: "human_only",
    automaticDeliveryAllowed: false,
  });
}

export async function processResetDraft(
  runtime: ResetWorkerRuntime,
  claimed: ResetClaimedDraft,
): Promise<"ready" | "failed" | "superseded"> {
  let modelCalls = 0;
  let context;
  const callResults: ResetModelCallResult[] = [];

  try {
    context = await runtime.repository.loadDraftContext(claimed.draftRunId);
    if (context.draft.status !== "processing") return "superseded";
    if (
      context.turn.id !== claimed.turnId ||
      context.turn.status === "superseded" ||
      context.turn.supersededByTurnId
    ) {
      return "superseded";
    }

    const materialized = await materializeResetTurn({
      fragments: context.fragments,
      downloader: runtime.mediaDownloader,
      transcriptionModel: runtime.transcriptionModel,
    });
    const evidence = await buildResetEvidencePacket({
      repository: runtime.knowledgeRepository,
      clientTurnText: materialized.text,
      waId: context.contact.waId,
    });

    modelCalls = 1;
    let generated = await draftResetReply({
      history: context.history,
      materialized,
      evidence,
      clientName: context.contact.profileName,
    });
    callResults.push(generated);

    if (generated.modelId !== HERA_RESET_MODEL_ID) {
      throw new Error(`Unexpected reset model: ${generated.modelId}`);
    }

    let validation = validateResetDraft({
      clientTurnText: materialized.text,
      draft: generated.output,
      evidence,
    });

    if (!validation.passed) {
      modelCalls = 2;
      generated = await rewriteResetReply({
        history: context.history,
        materialized,
        evidence,
        clientName: context.contact.profileName,
        priorDraft: generated.output,
        validationIssues: validation.issues,
      });
      callResults.push(generated);
      if (generated.modelId !== HERA_RESET_MODEL_ID) {
        throw new Error(`Unexpected reset rewrite model: ${generated.modelId}`);
      }
      validation = validateResetDraft({
        clientTurnText: materialized.text,
        draft: generated.output,
        evidence,
      });
    }

    if (modelCalls > HERA_RESET_MAX_MODEL_CALLS) {
      throw new Error("Reset model-call ceiling was exceeded");
    }

    if (!validation.passed) {
      const result = await runtime.repository.markFailed({
        draftRunId: context.draft.id,
        turnId: context.turn.id,
        turnVersion: context.turn.version,
        failureCode: "hard_validation_failed",
        failureMessage:
          "The AI reply still failed a protected factual or safety check after one rewrite. Review the listed issue and write the reply manually.",
        modelCalls,
        modelMetadata: asJson({
          ...((modelMetadata({
            calls: callResults,
            materialized,
            evidence,
            operatingMode: context.conversation.operatingMode,
          }) as Record<string, JsonValue>) ?? {}),
          validationIssues: validation.issues,
        }),
      });
      return result.state === "superseded" ? "superseded" : "failed";
    }

    const result = await runtime.repository.markReady({
      draftRunId: context.draft.id,
      turnId: context.turn.id,
      turnVersion: context.turn.version,
      candidateText: generated.output.finalReply,
      replyRequired: generated.output.replyRequired,
      modelId: HERA_RESET_MODEL_ID,
      modelCalls,
      rewriteUsed: modelCalls === 2,
      evidence: asJson(evidence.knowledge),
      validationIssues: asJson(validation.issues),
      modelMetadata: modelMetadata({
        calls: callResults,
        materialized,
        evidence,
        operatingMode: context.conversation.operatingMode,
      }),
    });
    return result.state === "superseded" ? "superseded" : "ready";
  } catch (error) {
    if (!context) throw error;
    const failure = safeFailure(error);
    const result = await runtime.repository.markFailed({
      draftRunId: context.draft.id,
      turnId: context.turn.id,
      turnVersion: context.turn.version,
      failureCode: failure.code,
      failureMessage: failure.message,
      modelCalls: Math.min(modelCalls, HERA_RESET_MAX_MODEL_CALLS),
      modelMetadata: asJson({
        architectureVersion: HERA_RESET_ARCHITECTURE_VERSION,
        modelCalls: Math.min(modelCalls, HERA_RESET_MAX_MODEL_CALLS),
        technical: failure.technical,
        automaticDeliveryAllowed: false,
      }),
    });
    return result.state === "superseded" ? "superseded" : "failed";
  }
}

export async function drainResetDrafts(
  runtime: ResetWorkerRuntime,
  limit = 3,
): Promise<ResetDrainSummary> {
  const claimed = await runtime.repository.claimDrafts(
    `reset-worker-${randomUUID()}`,
    limit,
  );
  const summary: ResetDrainSummary = {
    claimed: claimed.length,
    ready: 0,
    failed: 0,
    superseded: 0,
  };

  // Sequential processing is deliberate: it prevents a burst of expensive
  // Sol Max calls and makes the two-call ceiling auditable per client turn.
  for (const item of claimed) {
    const result = await processResetDraft(runtime, item);
    summary[result] += 1;
  }
  return summary;
}

export function createResetWorkerRuntime(): ResetWorkerRuntime {
  const database = getDatabaseConfig();
  const d360 = getD360Config();
  const ai = getAiConfig();
  return {
    repository: new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    ),
    knowledgeRepository: new SupabaseReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    ),
    mediaDownloader: new D360ResetMediaDownloader({
      apiKey: d360.apiKey,
      baseUrl: d360.baseUrl,
    }),
    transcriptionModel: ai.transcriptionModel,
  };
}
