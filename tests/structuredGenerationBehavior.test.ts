import assert from "node:assert/strict";
import test from "node:test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import {
  generateReceptionistDecision,
  RESPONSE_AGENT_MAX_STEPS,
  type AiRuntimeConfig,
} from "../src/ai/receptionist.js";
import type {
  GenerationAttemptCompletion,
  GenerationAttemptFailure,
  GenerationAttemptLedger,
  GenerationAttemptStart,
} from "../src/ai/generationAttempts.js";
import type { ReceptionistRepository } from "../src/db/repository.js";
import type { JobContext } from "../src/types.js";

const reportedUsage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 20,
    text: 20,
    reasoning: undefined,
  },
};

const decision = {
  reply: "I can help with that.",
  intent: "service_advice",
  risk: "green",
  confidence: 0.95,
  language: "English",
  sources: [],
  factualBasis: ["no_factual_claim"],
  proposedActions: [],
  requiresManagementNotification: false,
  handoff: {
    required: false,
    taskType: null,
    scope: null,
    priority: null,
    assignedRole: null,
    assignedOutlet: null,
    summary: null,
    requestedAction: null,
    collectedFacts: {
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
    },
    missingFacts: [],
    clientAcknowledgement: null,
  },
  rationale: "No salon-specific factual claim was required.",
} as const;

function response(input: {
  content: LanguageModelV4GenerateResult["content"];
  finishReason: "stop" | "tool-calls" | "length";
  modelId: string;
}): LanguageModelV4GenerateResult {
  return {
    content: input.content,
    finishReason: { unified: input.finishReason, raw: undefined },
    usage: reportedUsage,
    warnings: [],
    response: { modelId: input.modelId },
  };
}

function finalResponse(modelId: string): LanguageModelV4GenerateResult {
  return response({
    content: [{ type: "text", text: JSON.stringify(decision) }],
    finishReason: "stop",
    modelId,
  });
}

function invalidStructuredResponse(modelId: string): LanguageModelV4GenerateResult {
  return response({
    content: [{ type: "text", text: JSON.stringify({ reply: "incomplete" }) }],
    finishReason: "stop",
    modelId,
  });
}

function toolResponse(modelId: string, index: number): LanguageModelV4GenerateResult {
  return response({
    content: [
      {
        type: "tool-call",
        toolCallId: `gst-${index}`,
        toolName: "calculateGst",
        input: JSON.stringify({ amountBeforeGst: 100 + index }),
      },
    ],
    finishReason: "tool-calls",
    modelId,
  });
}

class RecordingLedger implements GenerationAttemptLedger {
  readonly starts: GenerationAttemptStart[] = [];
  readonly completions: GenerationAttemptCompletion[] = [];
  readonly failures: GenerationAttemptFailure[] = [];
  completePriced = true;
  failPriced = false;
  startLimit: number | null = null;

  async start(input: GenerationAttemptStart): Promise<string> {
    if (this.startLimit !== null && this.starts.length >= this.startLimit) {
      throw new Error("stage3r_model_attempt_cap_reached");
    }
    this.starts.push(input);
    return `attempt-${this.starts.length}`;
  }

  async complete(input: GenerationAttemptCompletion) {
    this.completions.push(input);
    return { priced: this.completePriced };
  }

  async fail(input: GenerationAttemptFailure) {
    this.failures.push(input);
    return { priced: this.failPriced };
  }
}

function jobContext(): JobContext {
  const createdAt = "2026-08-28T00:00:00.000Z";
  return {
    job: {
      id: "job-offline",
      kind: "process_inbound",
      sourceMessageId: "message-offline",
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    },
    message: {
      id: "message-offline",
      conversationId: "conversation-offline",
      contactId: "contact-offline",
      providerMessageId: "wamid.offline",
      direction: "inbound",
      kind: "text",
      text: "Please explain the GST total.",
      media: null,
      providerTimestamp: createdAt,
      createdAt,
    },
    contact: {
      id: "contact-offline",
      waId: "6599999999",
      profileName: "Offline Test",
      preferredLanguage: "English",
    },
    conversationRisk: "green",
  };
}

const repository = {
  searchApprovedKnowledge: async () => [],
  lookupBookingsByWaId: async () => [],
} as unknown as ReceptionistRepository;

function config(input: {
  primary: string;
  verifier?: string;
  fallback?: string[];
  ledger: GenerationAttemptLedger;
  models: Map<string, MockLanguageModelV4>;
}): AiRuntimeConfig {
  return {
    primaryModel: input.primary,
    verifierModel: input.verifier ?? input.primary,
    fallbackModels: input.fallback ?? [],
    transcriptionModel: "offline/transcription",
    generationAttemptLedger: input.ledger,
    modelFactory: (modelId) => {
      const model = input.models.get(modelId);
      if (!model) throw new Error(`missing offline model: ${modelId}`);
      return model;
    },
  };
}

async function generate(ai: AiRuntimeConfig) {
  const context = jobContext();
  return generateReceptionistDecision({
    repository,
    context,
    history: [
      {
        id: context.message.id,
        direction: "inbound",
        kind: "text",
        text: context.message.text,
        createdAt: context.message.createdAt,
      },
    ],
    interpreted: { text: context.message.text },
    config: ai,
  });
}

test("the final receptionist step disables tools and produces structured output offline", async () => {
  const modelId = "openai/gpt-5.6-sol";
  let calls = 0;
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId,
    doGenerate: async () => {
      calls += 1;
      return calls < RESPONSE_AGENT_MAX_STEPS
        ? toolResponse(modelId, calls)
        : finalResponse(modelId);
    },
  });
  const ledger = new RecordingLedger();

  const result = await generate(
    config({ primary: modelId, ledger, models: new Map([[modelId, model]]) }),
  );

  assert.equal(result.decision.reply, decision.reply);
  assert.equal(model.doGenerateCalls.length, RESPONSE_AGENT_MAX_STEPS);
  assert.deepEqual(
    model.doGenerateCalls.at(-1)?.toolChoice,
    { type: "none" },
  );
  assert.equal(ledger.starts.length, RESPONSE_AGENT_MAX_STEPS);
  assert.equal(ledger.completions.length, RESPONSE_AGENT_MAX_STEPS);
  assert.equal(ledger.failures.length, 0);
});

test("a non-stop finish reason is preserved instead of becoming an unexplained failure", async () => {
  const modelId = "openai/gpt-5.6-sol";
  const fallbackId = "anthropic/claude-opus-5";
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId,
    doGenerate: async () =>
      response({
        content: [{ type: "text", text: JSON.stringify(decision) }],
        finishReason: "length",
        modelId,
      }),
  });
  const fallback = new MockLanguageModelV4({
    provider: "offline",
    modelId: fallbackId,
    doGenerate: async () => finalResponse(fallbackId),
  });
  const ledger = new RecordingLedger();

  await assert.rejects(
    generate(
      config({
        primary: modelId,
        verifier: fallbackId,
        ledger,
        models: new Map([
          [modelId, model],
          [fallbackId, fallback],
        ]),
      }),
    ),
    (error: unknown) => {
      const diagnostic = error as Error & {
        generationFinishReason?: unknown;
        generationStepCount?: unknown;
        generationModelId?: unknown;
      };
      assert.equal(diagnostic.name, "AI_NoOutputGeneratedError");
      assert.equal(diagnostic.generationFinishReason, "length");
      assert.equal(diagnostic.generationStepCount, 1);
      assert.equal(diagnostic.generationModelId, modelId);
      return true;
    },
  );
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(fallback.doGenerateCalls.length, 0);
  assert.equal(ledger.completions[0]?.finishReason, "length");
});

test("schema fallback is one explicit application layer with no hidden Gateway model list", async () => {
  const firstId = "openai/gpt-5.6-sol";
  const secondId = "anthropic/claude-opus-5";
  const first = new MockLanguageModelV4({
    provider: "offline",
    modelId: firstId,
    doGenerate: async () => invalidStructuredResponse(firstId),
  });
  const second = new MockLanguageModelV4({
    provider: "offline",
    modelId: secondId,
    doGenerate: async () => finalResponse(secondId),
  });
  const ledger = new RecordingLedger();

  const result = await generate(
    config({
      primary: firstId,
      verifier: secondId,
      ledger,
      models: new Map([
        [firstId, first],
        [secondId, second],
      ]),
    }),
  );

  assert.equal(result.modelId, secondId);
  assert.equal(first.doGenerateCalls.length, 1);
  assert.equal(second.doGenerateCalls.length, 1);
  for (const call of [...first.doGenerateCalls, ...second.doGenerateCalls]) {
    const gatewayOptions = (
      call as LanguageModelV4CallOptions & {
        providerOptions?: { gateway?: Record<string, unknown> };
      }
    ).providerOptions?.gateway;
    assert.equal(gatewayOptions?.models, undefined);
  }
});

test("unpriced usage stops before an application fallback can spend again", async () => {
  const firstId = "openai/gpt-5.6-sol";
  const secondId = "anthropic/claude-opus-5";
  const first = new MockLanguageModelV4({
    provider: "offline",
    modelId: firstId,
    doGenerate: async () => finalResponse(firstId),
  });
  const second = new MockLanguageModelV4({
    provider: "offline",
    modelId: secondId,
    doGenerate: async () => finalResponse(secondId),
  });
  const ledger = new RecordingLedger();
  ledger.completePriced = false;

  await assert.rejects(
    generate(
      config({
        primary: firstId,
        verifier: secondId,
        ledger,
        models: new Map([
          [firstId, first],
          [secondId, second],
        ]),
      }),
    ),
    /stage3r_generation_usage_unpriced/,
  );
  assert.equal(first.doGenerateCalls.length, 1);
  assert.equal(second.doGenerateCalls.length, 0);
});

test("the attempt cap blocks a second provider step before it starts", async () => {
  const modelId = "openai/gpt-5.6-sol";
  let calls = 0;
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId,
    doGenerate: async () => {
      calls += 1;
      return calls === 1 ? toolResponse(modelId, calls) : finalResponse(modelId);
    },
  });
  const ledger = new RecordingLedger();
  ledger.startLimit = 1;

  await assert.rejects(
    generate(config({ primary: modelId, ledger, models: new Map([[modelId, model]]) })),
    /stage3r_model_attempt_cap_reached/,
  );
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(ledger.starts.length, 1);
  assert.equal(ledger.completions.length, 1);
});
