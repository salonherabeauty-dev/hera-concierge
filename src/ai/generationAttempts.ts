import { randomUUID } from "node:crypto";
import type {
  GenerateTextStepEndEvent,
  LanguageModel,
} from "ai";

export interface GenerationAttemptStart {
  stage: string;
  configuredModelId: string;
  callId: string;
  stepNumber: number;
  modelId: string;
}

export interface GenerationAttemptCompletion {
  attemptId: string;
  configuredModelId: string;
  modelId: string;
  finishReason: string;
  rawFinishReason: string | null;
  usage: unknown;
  latencyMs: number;
}

export interface GenerationAttemptFailure {
  attemptId: string;
  configuredModelId: string;
  modelId: string;
  finishReason: string | null;
  usage: unknown;
  latencyMs: number;
  errorCode: string;
}

export interface GenerationAttemptOutcome {
  priced: boolean;
}

export interface GenerationAttemptLedger {
  start(input: GenerationAttemptStart): Promise<string>;
  complete(input: GenerationAttemptCompletion): Promise<GenerationAttemptOutcome>;
  fail(input: GenerationAttemptFailure): Promise<GenerationAttemptOutcome>;
}

interface OpenAttempt {
  attemptId: string;
  configuredModelId: string;
  modelId: string;
  startedAtMs: number;
}

type AnyStepEndEvent = GenerateTextStepEndEvent<any, any>;

function modelId(model: LanguageModel, fallback: string): string {
  if (typeof model === "string") return model;
  return "modelId" in model && typeof model.modelId === "string"
    ? model.modelId
    : fallback;
}

function errorDiagnostic(error: unknown): {
  modelId: string | null;
  finishReason: string | null;
  usage: unknown;
  errorCode: string;
} {
  if (!(error instanceof Error)) {
    return {
      modelId: null,
      finishReason: null,
      usage: null,
      errorCode: "stage3r_unknown_generation_failure",
    };
  }
  const diagnostic = error as Error & {
    response?: { modelId?: unknown };
    finishReason?: unknown;
    generationFinishReason?: unknown;
    usage?: unknown;
  };
  const finishReason =
    diagnostic.generationFinishReason ?? diagnostic.finishReason;
  const modelId = diagnostic.response?.modelId;
  return {
    modelId: typeof modelId === "string" ? modelId : null,
    finishReason:
      typeof finishReason === "string" ? finishReason.slice(0, 40) : null,
    usage: diagnostic.usage ?? null,
    errorCode:
      error.name
        .replace(/[^a-z0-9]+/gi, "_")
        .toLowerCase()
        .slice(0, 80) || "stage3r_generation_failure",
  };
}

export function createGenerationAttemptLifecycle(input: {
  ledger: GenerationAttemptLedger | undefined;
  stage: string;
  configuredModelId: string;
}): {
  prepareStep: (event: {
    stepNumber: number;
    model: LanguageModel;
  }) => Promise<void>;
  onStepEnd: (event: AnyStepEndEvent) => Promise<void>;
  assertHealthy: () => void;
  failOpen: (error: unknown) => Promise<void>;
} {
  const generationId = randomUUID();
  const open = new Map<number, OpenAttempt>();
  let accountingError: unknown = null;

  return {
    prepareStep: async (event) => {
      if (!input.ledger) return;
      const attemptId = await input.ledger.start({
        stage: input.stage,
        configuredModelId: input.configuredModelId,
        callId: generationId,
        stepNumber: event.stepNumber,
        modelId: modelId(event.model, input.configuredModelId),
      });
      open.set(event.stepNumber, {
        attemptId,
        configuredModelId: input.configuredModelId,
        modelId: modelId(event.model, input.configuredModelId),
        startedAtMs: Date.now(),
      });
    },
    onStepEnd: async (event) => {
      if (!input.ledger) return;
      const active = open.get(event.stepNumber);
      if (!active) {
        accountingError ??= new Error("stage3r_generation_attempt_start_missing");
        return;
      }
      try {
        const outcome = await input.ledger.complete({
          attemptId: active.attemptId,
          configuredModelId: active.configuredModelId,
          modelId: event.response.modelId || active.modelId,
          finishReason: event.finishReason,
          rawFinishReason: event.rawFinishReason ?? null,
          usage: event.usage,
          latencyMs: Math.max(0, Date.now() - active.startedAtMs),
        });
        open.delete(event.stepNumber);
        if (!outcome.priced) {
          accountingError ??= new Error("stage3r_generation_usage_unpriced");
        }
      } catch (error) {
        accountingError ??= error;
      }
    },
    assertHealthy: () => {
      if (accountingError) throw accountingError;
    },
    failOpen: async (error) => {
      if (!input.ledger || open.size === 0) return;
      const diagnostic = errorDiagnostic(error);
      let unpriced = false;
      for (const [stepNumber, active] of open) {
        const outcome = await input.ledger.fail({
          attemptId: active.attemptId,
          configuredModelId: active.configuredModelId,
          modelId: diagnostic.modelId ?? active.modelId,
          finishReason: diagnostic.finishReason,
          usage: diagnostic.usage,
          latencyMs: Math.max(0, Date.now() - active.startedAtMs),
          errorCode: diagnostic.errorCode,
        });
        open.delete(stepNumber);
        unpriced ||= !outcome.priced;
      }
      if (unpriced) {
        throw new Error("stage3r_generation_failure_unpriced");
      }
    },
  };
}
