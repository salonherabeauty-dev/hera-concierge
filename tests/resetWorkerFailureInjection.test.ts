import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import {
  HERA_RESET_MODEL_ID,
} from "../src/reset/config.js";
import type {
  ResetDraftContext,
  ResetEvidencePacket,
  ResetMaterializedTurn,
  ResetModelCallResult,
  ResetModelDraft,
} from "../src/reset/types.js";
import {
  processResetDraft,
  resetSafeFailure,
  type ResetWorkerRuntime,
} from "../src/reset/worker.js";

const claimed = {
  draftRunId: "11111111-1111-4111-8111-111111111111",
  turnId: "22222222-2222-4222-8222-222222222222",
};

function context(overrides: Partial<ResetDraftContext> = {}): ResetDraftContext {
  const base: ResetDraftContext = {
    draft: {
      id: claimed.draftRunId,
      turnId: claimed.turnId,
      generation: 1,
      status: "processing",
      origin: "ai",
      candidateText: null,
      candidateHash: null,
      replyRequired: null,
      modelId: null,
      modelCalls: 0,
      rewriteUsed: false,
      evidence: [],
      validationIssues: [],
      modelMetadata: {},
      failureCode: null,
      failureMessage: null,
      processAttempts: 1,
      availableAt: "2026-08-30T00:00:00.000Z",
      lockedAt: "2026-08-30T00:00:01.000Z",
      completedAt: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:01.000Z",
    },
    turn: {
      id: claimed.turnId,
      conversationId: "33333333-3333-4333-8333-333333333333",
      contactId: "44444444-4444-4444-8444-444444444444",
      version: 1,
      status: "processing",
      deliveryControl: "human_only",
      fragmentIds: ["55555555-5555-4555-8555-555555555555"],
      assembledText: "Hello",
      attachments: [],
      firstFragmentAt: "2026-08-30T00:00:00.000Z",
      lastFragmentAt: "2026-08-30T00:00:00.000Z",
      settleAt: "2026-08-30T00:00:08.000Z",
      supersededByTurnId: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:01.000Z",
    },
    contact: {
      id: "44444444-4444-4444-8444-444444444444",
      waId: "6591234567",
      profileName: "Test Client",
      preferredLanguage: "English",
    },
    conversation: {
      id: "33333333-3333-4333-8333-333333333333",
      operatingMode: "management",
      currentRisk: "green",
      lastMessageAt: "2026-08-30T00:00:00.000Z",
    },
    fragments: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        conversationId: "33333333-3333-4333-8333-333333333333",
        contactId: "44444444-4444-4444-8444-444444444444",
        providerMessageId: "wamid-test",
        direction: "inbound",
        kind: "text",
        text: "Hello",
        media: null,
        providerTimestamp: "2026-08-30T00:00:00.000Z",
        createdAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    history: [],
  };
  return { ...base, ...overrides };
}

function materialized(text = "Hello"): ResetMaterializedTurn {
  return { text, attachments: [], warnings: [], transcriptionCount: 0 };
}

function evidence(): ResetEvidencePacket {
  return {
    queries: ["Hera services"],
    knowledge: [],
    bookings: [],
    tanglinOnly: true,
    liveAvailabilityVerified: false,
    retrievalWarnings: [],
  };
}

function modelDraft(finalReply = "Hello. How may we help you today?"): ResetModelDraft {
  return {
    replyRequired: true,
    finalReply,
    intent: "greeting",
    currentEmergency: false,
    reviewPriority: "normal",
    requestedAction: null,
    factsStillMissing: [],
    usedEvidenceIds: [],
  };
}

function modelResult(finalReply?: string): ResetModelCallResult {
  return {
    output: modelDraft(finalReply),
    modelId: HERA_RESET_MODEL_ID,
    usage: { inputTokens: 10, outputTokens: 8 },
    latencyMs: 50,
  };
}

function runtime(input: {
  load?: () => Promise<ResetDraftContext>;
  draft?: () => Promise<ResetModelCallResult>;
  rewrite?: () => Promise<ResetModelCallResult>;
  validations?: Array<{ passed: boolean; issues: string[] }>;
}) {
  const ready: unknown[] = [];
  const failed: unknown[] = [];
  const claimFailed: unknown[] = [];
  let validationIndex = 0;
  let draftCalls = 0;
  let rewriteCalls = 0;

  const value: ResetWorkerRuntime = {
    repository: {
      claimDrafts: async () => [],
      loadDraftContext: input.load ?? (async () => context()),
      markReady: async (record) => {
        ready.push(record);
        return { ok: true, state: "ready" };
      },
      markFailed: async (record) => {
        failed.push(record);
        return { ok: true, state: "failed" };
      },
    },
    markClaimFailed: async (record) => {
      claimFailed.push(record);
      return { ok: true, state: "failed" };
    },
    knowledgeRepository: {} as ReceptionistRepository,
    mediaDownloader: {
      downloadMedia: async () => ({
        data: new Uint8Array(),
        mimeType: "application/octet-stream",
      }),
    },
    transcriptionModel: "openai/gpt-4o-transcribe",
    materializeTurn: async () => materialized(),
    buildEvidence: async () => evidence(),
    draftReply: async () => {
      draftCalls += 1;
      return input.draft ? input.draft() : modelResult();
    },
    rewriteReply: async () => {
      rewriteCalls += 1;
      return input.rewrite ? input.rewrite() : modelResult("Corrected safe reply.");
    },
    validateDraft: () =>
      input.validations?.[validationIndex++] ?? { passed: true, issues: [] },
  };

  return {
    value,
    ready,
    failed,
    claimFailed,
    counts: () => ({ draftCalls, rewriteCalls }),
  };
}

test("human handling does not suppress one-call automatic drafting", async () => {
  const controlled = runtime({});
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "ready");
  assert.equal(controlled.ready.length, 1);
  assert.equal(controlled.failed.length, 0);
  assert.deepEqual(controlled.counts(), { draftCalls: 1, rewriteCalls: 0 });
  assert.equal((controlled.ready[0] as { modelCalls: number }).modelCalls, 1);
});

test("one hard validation failure permits exactly one successful rewrite", async () => {
  const controlled = runtime({
    validations: [
      { passed: false, issues: ["false booking completion"] },
      { passed: true, issues: [] },
    ],
  });
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "ready");
  assert.deepEqual(controlled.counts(), { draftCalls: 1, rewriteCalls: 1 });
  const saved = controlled.ready[0] as {
    modelCalls: number;
    rewriteUsed: boolean;
    candidateText: string;
  };
  assert.equal(saved.modelCalls, 2);
  assert.equal(saved.rewriteUsed, true);
  assert.equal(saved.candidateText, "Corrected safe reply.");
});

test("a second hard validation failure becomes explicit failure without a third call", async () => {
  const controlled = runtime({
    validations: [
      { passed: false, issues: ["first issue"] },
      { passed: false, issues: ["still unsafe"] },
    ],
  });
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "failed");
  assert.deepEqual(controlled.counts(), { draftCalls: 1, rewriteCalls: 1 });
  assert.equal(controlled.ready.length, 0);
  const saved = controlled.failed[0] as {
    modelCalls: number;
    failureCode: string;
  };
  assert.equal(saved.modelCalls, 2);
  assert.equal(saved.failureCode, "hard_validation_failed");
});

test("OpenAI timeout and rate limit produce safe visible terminal failures", async () => {
  for (const [message, expected] of [
    ["The operation was aborted due to timeout", "openai_timeout"],
    ["429 rate limit exceeded", "openai_rate_limited"],
  ] as const) {
    const controlled = runtime({
      draft: async () => {
        throw new Error(message);
      },
    });
    const result = await processResetDraft(controlled.value, claimed);
    assert.equal(result, "failed");
    const saved = controlled.failed[0] as { failureCode: string };
    assert.equal(saved.failureCode, expected);
  }
});

test("context-load failure is persisted immediately instead of waiting for a silent timeout", async () => {
  const controlled = runtime({
    load: async () => {
      throw new Error("reset database unavailable");
    },
  });
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "failed");
  assert.equal(controlled.failed.length, 0);
  assert.equal(controlled.claimFailed.length, 1);
  assert.equal(
    (controlled.claimFailed[0] as { failureCode: string }).failureCode,
    "draft_storage_failed",
  );
});

test("a superseded client turn exits without model calls or candidate writes", async () => {
  const stale = context({
    turn: {
      ...context().turn,
      status: "superseded",
      supersededByTurnId: "66666666-6666-4666-8666-666666666666",
    },
  });
  const controlled = runtime({ load: async () => stale });
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "superseded");
  assert.deepEqual(controlled.counts(), { draftCalls: 0, rewriteCalls: 0 });
  assert.equal(controlled.ready.length, 0);
  assert.equal(controlled.failed.length, 0);
});

test("an unexpected model id fails closed and never becomes a candidate", async () => {
  const controlled = runtime({
    draft: async () => ({ ...modelResult(), modelId: "other/model" }),
  });
  const result = await processResetDraft(controlled.value, claimed);
  assert.equal(result, "failed");
  assert.equal(controlled.ready.length, 0);
  assert.equal(
    (controlled.failed[0] as { failureCode: string }).failureCode,
    "ai_draft_failed",
  );
});

test("failure-class mapping remains explicit and client-safe", () => {
  assert.equal(resetSafeFailure(new Error("attachment download failed")).code, "attachment_processing_failed");
  assert.equal(resetSafeFailure(new Error("knowledge search unavailable")).code, "evidence_retrieval_failed");
  assert.equal(resetSafeFailure(new Error("Supabase connection failed")).code, "draft_storage_failed");
  assert.equal(resetSafeFailure(new Error("unexpected model failure")).code, "ai_draft_failed");
});
