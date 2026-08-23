import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import type { OutboxItem } from "../src/types.js";
import { drainOutbox, isReplyWorthyMessage } from "../src/worker.js";
import {
  WhatsAppApiError,
  type WhatsAppTransport,
} from "../src/whatsapp/client.js";

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: "outbox-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    toWaId: "6591112222",
    targetType: "client",
    body: "A safe reply",
    dedupeKey: "client-reply:message-1",
    authorization: "auto",
    attempts: 1,
    maxAttempts: 8,
    ...overrides,
  };
}

function fakeRepository(
  values: OutboxItem[],
  options: {
    sourceTimestamp?: string | null;
    sourceTimestampError?: Error;
  } = {},
) {
  const state = {
    shadowed: [] as string[],
    sent: [] as string[],
    retried: [] as Array<{ id: string; retryable: boolean }>,
    timestampReads: [] as string[],
  };
  const repository = {
    claimOutbox: async () => values,
    getSourceMessageProviderTimestamp: async (messageId: string) => {
      state.timestampReads.push(messageId);
      if (options.sourceTimestampError) throw options.sourceTimestampError;
      return options.sourceTimestamp === undefined
        ? new Date().toISOString()
        : options.sourceTimestamp;
    },
    markOutboxShadowed: async (id: string) => void state.shadowed.push(id),
    markOutboxSent: async (id: string) => void state.sent.push(id),
    retryOutbox: async (
      value: OutboxItem,
      _error: unknown,
      retryable = true,
    ) => {
      state.retried.push({ id: value.id, retryable });
      return retryable ? ("retry" as const) : ("dead" as const);
    },
  } as unknown as ReceptionistRepository;
  return { repository, state };
}

test("shadow mode never calls Meta and records the candidate reply", async () => {
  const { repository, state } = fakeRepository([item()]);
  let sends = 0;
  const transport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "should-not-send" };
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "shadow",
    workerId: "test-worker",
  });
  assert.equal(sends, 0);
  assert.deepEqual(state.shadowed, ["outbox-1"]);
  assert.equal(result.outboxShadowed, 1);
});

test("live mode sends an auto-authorised item exactly once", async () => {
  const { repository, state } = fakeRepository([item()]);
  let sends = 0;
  const transport = {
    sendText: async (toWaId: string, body: string) => {
      sends += 1;
      assert.equal(toWaId, "6591112222");
      assert.equal(body, "A safe reply");
      return { providerMessageId: "wamid.sent-1" };
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.equal(sends, 1);
  assert.deepEqual(state.sent, ["outbox-1"]);
  assert.equal(result.outboxSent, 1);
});

test("live mode refuses an item that lacks automatic authorisation", async () => {
  const { repository, state } = fakeRepository([
    item({ authorization: "management" }),
  ]);
  const result = await drainOutbox({
    repository,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.deepEqual(state.shadowed, ["outbox-1"]);
  assert.equal(result.outboxSent, 0);
});

test("live mode dead-letters a permanent Meta rejection without retrying it", async () => {
  const { repository, state } = fakeRepository([item()]);
  const transport = {
    sendText: async () => {
      throw new WhatsAppApiError("Meta rejected the outbound message", 400);
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: false }]);
  assert.equal(result.outboxRetried, 0);
  assert.equal(result.outboxDead, 1);
});

test("live mode retries a transient Meta rejection", async () => {
  const { repository, state } = fakeRepository([item()]);
  const transport = {
    sendText: async () => {
      throw new WhatsAppApiError("Meta is temporarily unavailable", 503);
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: true }]);
  assert.equal(result.outboxRetried, 1);
  assert.equal(result.outboxDead, 0);
});

test("live mode permanently blocks a stale free-form reply before calling Meta", async () => {
  const staleTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { repository, state } = fakeRepository([item()], {
    sourceTimestamp: staleTimestamp,
  });
  let sends = 0;
  const transport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "must-not-send" };
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.equal(sends, 0);
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: false }]);
  assert.equal(result.outboxDead, 1);
});

test("live mode fails closed when a free-form reply has no source message", async () => {
  const { repository, state } = fakeRepository([
    item({ sourceMessageId: null }),
  ]);
  let sends = 0;
  const transport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "must-not-send" };
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.equal(sends, 0);
  assert.deepEqual(state.timestampReads, []);
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: false }]);
  assert.equal(result.outboxDead, 1);
});

test("a source timestamp lookup failure is retried without calling Meta", async () => {
  const { repository, state } = fakeRepository([item()], {
    sourceTimestampError: new Error("temporary database failure"),
  });
  let sends = 0;
  const transport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "must-not-send" };
    },
  } as unknown as WhatsAppTransport;

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
  });
  assert.equal(sends, 0);
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: true }]);
  assert.equal(result.outboxRetried, 1);
});

test("reaction and system events are recorded without creating chatty replies", () => {
  assert.equal(isReplyWorthyMessage("reaction"), false);
  assert.equal(isReplyWorthyMessage("system"), false);
  assert.equal(isReplyWorthyMessage("text"), true);
  assert.equal(isReplyWorthyMessage("image"), true);
});
