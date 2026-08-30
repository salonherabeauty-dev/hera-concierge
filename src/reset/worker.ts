import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { getDatabaseConfig } from "../config.js";
import {
  logOperationalEvent,
  safeErrorFields,
} from "../observability/log.js";
import { buildResetEvidenceBundle } from "./evidence.js";
import {
  generateResetDraft,
  RESET_MAX_TRANSPORT_RETRIES,
  resetProviderFailureDiagnostic,
  ResetDraftValidationError,
} from "./engine.js";
import { ResetReceptionistRepository } from "./repository.js";
import type { ClaimedResetTurnJob } from "./types.js";

export interface ResetWorkerRuntime {
  repository: ResetReceptionistRepository;
  modelFactory?: (modelId: string) => LanguageModel;
}

export interface ResetDrainSummary {
  jobsClaimed: number;
  jobsReady: number;
  jobsFailed: number;
  jobsSuperseded: number;
  providerSendCalls: 0;
  timelyWriteCalls: 0;
}

export function createResetWorkerRuntime(): ResetWorkerRuntime {
  const database = getDatabaseConfig();
  return {
    repository: new ResetReceptionistRepository(
      database.url,
      database.serviceRoleKey,
    ),
  };
}

function failureCode(error: unknown): string {
  if (error instanceof ResetDraftValidationError) {
    return "bounded_validation_failed";
  }

  const diagnostic = resetProviderFailureDiagnostic(error);
  const providerSignal = `${diagnostic.providerErrorType ?? ""} ${diagnostic.providerErrorCode ?? ""}`;
  if (/insufficient_quota|insufficient_funds|billing|credit/i.test(providerSignal)) {
    return "openai_billing_required";
  }
  if (diagnostic.statusCode === 401 || diagnostic.statusCode === 403) {
    return "openai_authentication_failed";
  }
  if (diagnostic.statusCode === 404) {
    return "openai_model_unavailable";
  }
  if (diagnostic.statusCode === 408) {
    return "openai_timeout";
  }
  if (diagnostic.statusCode === 429) {
    return "openai_rate_limited";
  }
  if (diagnostic.statusCode !== null && diagnostic.statusCode >= 500) {
    return "openai_service_unavailable";
  }

  const name = error instanceof Error && error.name
    ? error.name
    : "draft_generation_failed";
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|aborted|abort/i.test(`${name} ${message}`)) {
    return "openai_timeout";
  }
  if (/rate.?limit|429/i.test(`${name} ${message}`)) {
    return "openai_rate_limited";
  }
  if (/no output|empty output/i.test(`${name} ${message}`)) {
    return "openai_empty_output";
  }
  if (/credential|api.?key|authentication/i.test(`${name} ${message}`)) {
    return "openai_authentication_failed";
  }
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "draft_generation_failed";
}

function failureMessage(error: unknown): string {
  if (error instanceof ResetDraftValidationError) {
    return `The AI prepared a reply, but it did not pass the final safety check: ${error.issues.join(" ")}`
      .replace(/\s+/g, " ")
      .slice(0, 500);
  }
  const name = failureCode(error);
  if (name === "openai_timeout") {
    return "OpenAI took too long to prepare the reply. Retry once or write the reply manually.";
  }
  if (name === "openai_rate_limited") {
    return "OpenAI is temporarily busy. Retry once in a moment or write the reply manually.";
  }
  if (name === "openai_empty_output") {
    return "OpenAI did not return a usable reply. Retry once or write the reply manually.";
  }
  if (name === "openai_authentication_failed") {
    return "OpenAI authentication is unavailable in this Preview. Write the reply manually while the connection is repaired.";
  }
  if (name === "openai_billing_required") {
    return "OpenAI billing is unavailable for this Preview. Write the reply manually while the connection is repaired.";
  }
  if (name === "openai_model_unavailable") {
    return "GPT‑5.6 Sol is unavailable to this Preview. Write the reply manually while the connection is repaired.";
  }
  if (name === "openai_service_unavailable") {
    return "OpenAI is temporarily unavailable. Retry once or write the reply manually.";
  }
  return "The AI could not prepare this reply. Retry once or write the reply manually.";
}

async function processResetTurnJob(
  runtime: ResetWorkerRuntime,
  job: ClaimedResetTurnJob,
): Promise<"ready" | "failed" | "superseded"> {
  const startedAt = Date.now();
  try {
    const [contact, recentConversation] = await Promise.all([
      runtime.repository.getContact(job.contactId),
      runtime.repository.getRecentConversation({
        conversationId: job.conversationId,
        throughCreatedAt: new Date(Date.now() + 60_000).toISOString(),
        limit: 20,
      }),
    ]);
    const evidence = await buildResetEvidenceBundle({
      repository: runtime.repository.knowledgeRepository,
      job,
      contact,
      recentConversation,
    });
    const result = await generateResetDraft({
      evidence,
      modelFactory: runtime.modelFactory,
    });
    const persisted = await runtime.repository.finishReady({ job, result });

    logOperationalEvent(
      "info",
      persisted.state === "ready"
        ? "reset_v3_draft_ready"
        : "reset_v3_draft_superseded",
      {
        jobId: job.jobId,
        turnId: job.turnId,
        conversationId: job.conversationId,
        turnVersion: job.version,
        candidateId: persisted.candidateId,
        modelId: result.modelId,
        modelAttempts: result.modelAttempts,
        transportRetriesAllowedPerCall: RESET_MAX_TRANSPORT_RETRIES,
        latencyMs: Date.now() - startedAt,
        providerSendCalls: 0,
        timelyWriteCalls: 0,
      },
    );
    return persisted.state;
  } catch (error) {
    const modelAttempts = error instanceof ResetDraftValidationError
      ? error.modelAttempts
      : 0;
    const code = failureCode(error);
    const message = failureMessage(error);
    const providerDiagnostic = resetProviderFailureDiagnostic(error);
    await runtime.repository.finishFailed({
      job,
      error,
      modelAttempts,
      failureCode: code,
      failureMessage: message,
    });
    logOperationalEvent("error", "reset_v3_draft_failed_visible", {
      jobId: job.jobId,
      turnId: job.turnId,
      conversationId: job.conversationId,
      turnVersion: job.version,
      failureCode: code,
      failureMessage: message,
      modelAttempts,
      transportRetriesAllowedPerCall: RESET_MAX_TRANSPORT_RETRIES,
      providerErrorName: providerDiagnostic.name,
      providerErrorStatus: providerDiagnostic.statusCode,
      providerErrorRetryable: providerDiagnostic.retryable,
      providerErrorType: providerDiagnostic.providerErrorType,
      providerErrorCode: providerDiagnostic.providerErrorCode,
      providerRequestId: providerDiagnostic.requestId,
      latencyMs: Date.now() - startedAt,
      providerSendCalls: 0,
      timelyWriteCalls: 0,
      ...safeErrorFields(error),
    });
    return "failed";
  }
}

export async function drainResetTurnJobs(input: {
  runtime?: ResetWorkerRuntime;
  turnIds?: string[];
  limit?: number;
  workerId?: string;
} = {}): Promise<ResetDrainSummary> {
  const runtime = input.runtime ?? createResetWorkerRuntime();
  const workerId = input.workerId ?? `reset-v3-${randomUUID()}`;
  const jobs = await runtime.repository.claimTurnJobs({
    workerId,
    limit: input.limit ?? 5,
    turnIds: input.turnIds,
  });

  let jobsReady = 0;
  let jobsFailed = 0;
  let jobsSuperseded = 0;
  for (const job of jobs) {
    const outcome = await processResetTurnJob(runtime, job);
    if (outcome === "ready") jobsReady += 1;
    else if (outcome === "failed") jobsFailed += 1;
    else jobsSuperseded += 1;
  }

  return {
    jobsClaimed: jobs.length,
    jobsReady,
    jobsFailed,
    jobsSuperseded,
    providerSendCalls: 0,
    timelyWriteCalls: 0,
  };
}
