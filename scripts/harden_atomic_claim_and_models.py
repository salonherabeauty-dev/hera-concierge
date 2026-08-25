from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if before not in source:
        raise RuntimeError(f"Missing patch anchor in {path}")
    updated = source.replace(before, after, 1)
    if updated == source:
        raise RuntimeError(f"No change made to {path}")
    file_path.write_text(updated, encoding="utf-8")


old_claim = r'''  async claimJobsByIds(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]> {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);
    if (uniqueJobIds.length === 0) return [];
    const { data, error } = await this.database.rpc("ai_claim_jobs_by_ids", {
      p_worker_id: workerId,
      p_job_ids: uniqueJobIds,
    });
    const values = requireData(data, error, "claim targeted jobs") as unknown[];
    return values.map((value) => {
      const item = row(value);
      return {
        id: requiredString(item.id, "id"),
        kind: "process_inbound",
        sourceMessageId: requiredString(item.source_message_id, "source_message_id"),
        payload: (item.payload ?? {}) as JsonValue,
        attempts: Number(item.attempts),
        maxAttempts: Number(item.max_attempts),
      };
    });
  }
'''

new_claim = r'''  async claimJobsByIds(workerId: string, jobIds: string[]): Promise<ReceptionistJob[]> {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))].slice(0, 25);
    if (uniqueJobIds.length === 0) return [];

    const { data, error } = await this.database
      .from("ai_jobs")
      .select("*")
      .in("id", uniqueJobIds);
    const values = requireData(data, error, "load targeted jobs") as unknown[];
    const jobsById = new Map(
      values.map((value) => {
        const item = row(value);
        return [requiredString(item.id, "id"), item] as const;
      }),
    );
    const claimed: ReceptionistJob[] = [];
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBefore = now.getTime() - 5 * 60 * 1000;

    for (const jobId of uniqueJobIds) {
      const item = jobsById.get(jobId);
      if (!item) continue;
      const status = requiredString(item.status, "status");
      const attempts = Number(item.attempts);
      const updatedAt = requiredString(item.updated_at, "updated_at");
      const availableAt = Date.parse(requiredString(item.available_at, "available_at"));
      const lockedAt =
        typeof item.locked_at === "string" ? Date.parse(item.locked_at) : Number.NaN;
      const eligible =
        ((status === "pending" || status === "retry") &&
          Number.isFinite(availableAt) &&
          availableAt <= now.getTime()) ||
        (status === "processing" &&
          Number.isFinite(lockedAt) &&
          lockedAt < staleBefore);
      if (!eligible) continue;

      const sourceMessageId = requiredString(
        item.source_message_id,
        "source_message_id",
      );
      if (await this.isInboundSuperseded(sourceMessageId)) {
        const { data: suppressed, error: suppressError } = await this.database
          .from("ai_jobs")
          .update({
            status: "completed",
            completed_at: nowIso,
            locked_at: null,
            locked_by: null,
            last_error: "superseded_by_newer_inbound",
            updated_at: nowIso,
          })
          .eq("id", jobId)
          .eq("status", status)
          .eq("attempts", attempts)
          .eq("updated_at", updatedAt)
          .select("id")
          .maybeSingle();
        if (suppressError) {
          throw new Error(
            "suppress targeted superseded job: " + suppressError.message,
          );
        }
        if (suppressed) {
          await this.audit(
            "out_of_order_inbound_suppressed",
            "message",
            sourceMessageId,
            {
              suppressionStage: "targeted_job_claim",
              jobId,
              reason: "newer_inbound_recorded_before_targeted_processing",
            },
          );
        }
        continue;
      }

      const { data: claimedRow, error: claimError } = await this.database
        .from("ai_jobs")
        .update({
          status: "processing",
          attempts: attempts + 1,
          locked_at: nowIso,
          locked_by: workerId.trim() || null,
          updated_at: nowIso,
        })
        .eq("id", jobId)
        .eq("status", status)
        .eq("attempts", attempts)
        .eq("updated_at", updatedAt)
        .select("*")
        .maybeSingle();
      if (claimError) {
        throw new Error("claim targeted job: " + claimError.message);
      }
      if (!claimedRow) continue;
      const claimedItem = row(claimedRow);
      claimed.push({
        id: requiredString(claimedItem.id, "id"),
        kind: "process_inbound",
        sourceMessageId: requiredString(
          claimedItem.source_message_id,
          "source_message_id",
        ),
        payload: (claimedItem.payload ?? {}) as JsonValue,
        attempts: Number(claimedItem.attempts),
        maxAttempts: Number(claimedItem.max_attempts),
      });
    }

    return claimed;
  }
'''
replace_once("src/db/repository.ts", old_claim, new_claim)

replace_once(
    "src/ai/receptionist.ts",
    'import type { InterpretedInbound } from "../whatsapp/media.js";\n',
    'import type { InterpretedInbound } from "../whatsapp/media.js";\n'
    'import { logOperationalEvent, safeErrorFields } from "../observability/log.js";\n',
)

replace_once(
    "src/ai/receptionist.ts",
    r'''function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function historyMessages(
''',
    r'''function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function retryableStructuredGenerationError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return /NoObjectGenerated|NoOutputGenerated|APICall|RateLimit|Timeout|Schema|JSON|parse/i.test(
    name + " " + message,
  );
}

function distinctModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))].slice(0, 2);
}

async function generateWithStructuredFallback<T>(input: {
  stage: "response" | "verification" | "final_verification";
  models: string[];
  run: (modelId: string, remainingModels: string[]) => Promise<T>;
}): Promise<T> {
  const models = distinctModels(input.models);
  if (models.length === 0) throw new Error("No AI model is configured");
  let lastError: unknown = new Error("Structured generation did not run");

  for (let index = 0; index < models.length; index += 1) {
    const modelId = models[index];
    try {
      return await input.run(modelId, models.slice(index + 1));
    } catch (error) {
      lastError = error;
      const canRetry =
        index < models.length - 1 && retryableStructuredGenerationError(error);
      logOperationalEvent(canRetry ? "warn" : "error", "structured_generation_failed", {
        stage: input.stage,
        attemptedModel: modelId,
        fallbackModel: canRetry ? models[index + 1] : null,
        retrying: canRetry,
        ...safeErrorFields(error),
      });
      if (!canRetry) throw error;
    }
  }

  throw lastError;
}

function historyMessages(
''',
)

old_response = r'''  const agent = new ToolLoopAgent({
    id: "hera-whatsapp-receptionist",
    model: gateway(input.config.primaryModel),
    instructions: RESPONSE_INSTRUCTIONS,
    tools: {
      searchHeraKnowledge: searchKnowledge,
      lookupAppointments,
      calculateGst,
      getHeraDigitalTools,
    },
    output: Output.object({ schema: agentDecisionSchema }),
    stopWhen: isStepCount(6),
    maxOutputTokens: 1800,
    temperature: 0.1,
    reasoning: "high",
    providerOptions: {
      gateway: {
        models: input.config.fallbackModels,
        tags: ["hera", "whatsapp", "receptionist", "response"],
        user: userId,
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  const start = Date.now();
  const result = await agent.generate({
    messages: historyMessages(
      input.history,
      input.context.message.id,
      input.interpreted,
    ),
    timeout: 90_000,
  });
'''
new_response = r'''  const start = Date.now();
  const result = await generateWithStructuredFallback({
    stage: "response",
    models: [
      input.config.primaryModel,
      input.config.verifierModel,
      ...input.config.fallbackModels,
    ],
    run: async (modelId, remainingModels) => {
      const agent = new ToolLoopAgent({
        id: "hera-whatsapp-receptionist",
        model: gateway(modelId),
        instructions: RESPONSE_INSTRUCTIONS,
        tools: {
          searchHeraKnowledge: searchKnowledge,
          lookupAppointments,
          calculateGst,
          getHeraDigitalTools,
        },
        output: Output.object({ schema: agentDecisionSchema }),
        stopWhen: isStepCount(6),
        maxOutputTokens: 1800,
        temperature: 0.1,
        reasoning: "high",
        providerOptions: {
          gateway: {
            ...(remainingModels.length ? { models: remainingModels } : {}),
            tags: ["hera", "whatsapp", "receptionist", "response"],
            user: userId,
            serviceTier: "priority",
            disallowPromptTraining: true,
          },
        },
      });
      return agent.generate({
        messages: historyMessages(
          input.history,
          input.context.message.id,
          input.interpreted,
        ),
        timeout: 75_000,
      });
    },
  });
'''
replace_once("src/ai/receptionist.ts", old_response, new_response)

old_verifier = r'''  const verifier = new ToolLoopAgent({
    id: "hera-whatsapp-verifier",
    model: gateway(input.config.verifierModel),
    instructions: VERIFIER_INSTRUCTIONS,
    tools: {},
    output: Output.object({ schema: verificationSchema }),
    stopWhen: isStepCount(2),
    maxOutputTokens: 1200,
    temperature: 0,
    reasoning: "high",
    providerOptions: {
      gateway: {
        models: [input.config.primaryModel],
        tags: ["hera", "whatsapp", "receptionist", "verification"],
        user: anonymousUserId(input.contactId),
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  const start = Date.now();
  const result = await verifier.generate({
    prompt: JSON.stringify({
      conversationHistory: input.history.map((message) => ({
        direction: message.direction,
        text: message.text.slice(0, 5000),
        createdAt: message.createdAt,
      })),
      clientMessage: input.originalMessage,
      proposedDecision: input.decision,
      approvedEvidence: input.evidence,
    }),
    timeout: 60_000,
  });
'''
new_verifier = r'''  const start = Date.now();
  const result = await generateWithStructuredFallback({
    stage: "verification",
    models: [
      input.config.verifierModel,
      input.config.primaryModel,
      ...input.config.fallbackModels,
    ],
    run: async (modelId, remainingModels) => {
      const verifier = new ToolLoopAgent({
        id: "hera-whatsapp-verifier",
        model: gateway(modelId),
        instructions: VERIFIER_INSTRUCTIONS,
        tools: {},
        output: Output.object({ schema: verificationSchema }),
        stopWhen: isStepCount(2),
        maxOutputTokens: 1200,
        temperature: 0,
        reasoning: "high",
        providerOptions: {
          gateway: {
            ...(remainingModels.length ? { models: remainingModels } : {}),
            tags: ["hera", "whatsapp", "receptionist", "verification"],
            user: anonymousUserId(input.contactId),
            serviceTier: "priority",
            disallowPromptTraining: true,
          },
        },
      });
      return verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
        }),
        timeout: 50_000,
      });
    },
  });
'''
replace_once("src/ai/receptionist.ts", old_verifier, new_verifier)

old_final = r'''  const verifier = new ToolLoopAgent({
    id: "hera-whatsapp-final-response-verifier",
    model: gateway(input.config.verifierModel),
    instructions: FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
    tools: {},
    output: Output.object({ schema: finalResponseVerificationSchema }),
    stopWhen: isStepCount(2),
    maxOutputTokens: 1400,
    temperature: 0,
    reasoning: "high",
    providerOptions: {
      gateway: {
        models: [input.config.primaryModel, ...input.config.fallbackModels],
        tags: ["hera", "whatsapp", "final-response-quality"],
        user: anonymousUserId(input.contactId),
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  const start = Date.now();
  const result = await verifier.generate({
    prompt: JSON.stringify({
      conversationHistory: input.history.map((message) => ({
        direction: message.direction,
        text: message.text.slice(0, 5000),
        createdAt: message.createdAt,
      })),
      clientMessage: input.originalMessage,
      proposedDecision: input.decision,
      approvedEvidence: input.evidence,
      deterministicPolicy: input.policy,
      finalHandoffAssessment: input.handoff,
      exactPostPolicyDraft: input.draftReply,
      deterministicDraftQuality: input.deterministicDraftQuality,
    }),
    timeout: 60_000,
  });
'''
new_final = r'''  const start = Date.now();
  const result = await generateWithStructuredFallback({
    stage: "final_verification",
    models: [
      input.config.verifierModel,
      input.config.primaryModel,
      ...input.config.fallbackModels,
    ],
    run: async (modelId, remainingModels) => {
      const verifier = new ToolLoopAgent({
        id: "hera-whatsapp-final-response-verifier",
        model: gateway(modelId),
        instructions: FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
        tools: {},
        output: Output.object({ schema: finalResponseVerificationSchema }),
        stopWhen: isStepCount(2),
        maxOutputTokens: 1400,
        temperature: 0,
        reasoning: "high",
        providerOptions: {
          gateway: {
            ...(remainingModels.length ? { models: remainingModels } : {}),
            tags: ["hera", "whatsapp", "final-response-quality"],
            user: anonymousUserId(input.contactId),
            serviceTier: "priority",
            disallowPromptTraining: true,
          },
        },
      });
      return verifier.generate({
        prompt: JSON.stringify({
          conversationHistory: input.history.map((message) => ({
            direction: message.direction,
            text: message.text.slice(0, 5000),
            createdAt: message.createdAt,
          })),
          clientMessage: input.originalMessage,
          proposedDecision: input.decision,
          approvedEvidence: input.evidence,
          deterministicPolicy: input.policy,
          finalHandoffAssessment: input.handoff,
          exactPostPolicyDraft: input.draftReply,
          deterministicDraftQuality: input.deterministicDraftQuality,
        }),
        timeout: 50_000,
      });
    },
  });
'''
replace_once("src/ai/receptionist.ts", old_final, new_final)

migration = Path("supabase/migrations/20260825000000_prioritize_fresh_inbound_jobs.sql")
if migration.exists():
    migration.unlink()

Path("tests/freshInboundPriority.test.ts").write_text(
    r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryUrl = new URL("../src/db/repository.ts", import.meta.url);
const workerUrl = new URL("../src/worker.ts", import.meta.url);
const d360Url = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const metaUrl = new URL("../api/whatsapp/webhook.ts", import.meta.url);

test("the repository atomically claims exact webhook-created jobs without DDL", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /claimJobsByIds\?/);
  assert.match(source, /from\("ai_jobs"\)[\s\S]*\.in\("id", uniqueJobIds\)/);
  assert.match(source, /\.eq\("status", status\)/);
  assert.match(source, /\.eq\("attempts", attempts\)/);
  assert.match(source, /\.eq\("updated_at", updatedAt\)/);
  assert.match(source, /attempts: attempts \+ 1/);
  assert.match(source, /superseded_by_newer_inbound/);
  assert.doesNotMatch(source, /ai_claim_jobs_by_ids/);
});

test("both WhatsApp adapters prioritize the jobs they just created", async () => {
  for (const url of [d360Url, metaUrl]) {
    const source = await readFile(url, "utf8");
    assert.match(source, /const wakeableJobIds: string\[\] = \[\]/);
    assert.match(source, /wakeableJobIds\.push\(result\.jobId\)/);
    assert.match(source, /drainReceptionistForJobs/);
  }
});

test("the worker processes targeted jobs before unrelated backlog", async () => {
  const source = await readFile(workerUrl, "utf8");
  assert.match(source, /export async function drainReceptionistForJobs/);
  assert.match(source, /const targetedJobs = await runtime\.repository\.claimJobsByIds/);
  assert.match(source, /const backlogJobs = remainingCapacity > 0/);
  assert.match(source, /\.\.\.targetedJobs,[\s\S]*\.\.\.backlogJobs\.filter/);
});

test("supersession is rechecked before every irreversible side effect", async () => {
  const source = await readFile(workerUrl, "utf8");
  for (const stage of [
    "before_context_load",
    "after_primary_and_first_verifier",
    "after_final_response_verifier",
    "before_operational_side_effects",
    "before_handoff_persistence",
    "before_client_candidate_persistence",
  ]) assert.match(source, new RegExp(stage));
  const guard = source.indexOf('"before_operational_side_effects"');
  const riskUpdate = source.indexOf("updateConversationRisk(context.message.conversationId");
  assert.ok(guard >= 0 && riskUpdate > guard);
  assert.match(source, /dead_letter_fallback_suppressed/);
});
''',
    encoding="utf-8",
)

Path("tests/structuredModelFallback.test.ts").write_text(
    r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/ai/receptionist.ts", import.meta.url);

test("structured generation retries once with an independent model", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /generateWithStructuredFallback/);
  assert.match(source, /NoObjectGenerated\|NoOutputGenerated/);
  assert.match(source, /distinctModels[\s\S]*slice\(0, 2\)/);
  assert.match(source, /structured_generation_failed/);
  assert.match(source, /stage: "response"/);
  assert.match(source, /stage: "verification"/);
  assert.match(source, /stage: "final_verification"/);
});

test("model fallback remains bounded and fail-closed", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /if \(!canRetry\) throw error/);
  assert.match(source, /throw lastError/);
  assert.match(source, /disallowPromptTraining: true/g);
});
''',
    encoding="utf-8",
)
