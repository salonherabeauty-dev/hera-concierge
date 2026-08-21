import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import type { OutboxItem } from "../src/types.js";
import { drainOutbox, isReplyWorthyMessage } from "../src/worker.js";
import type { WhatsAppTransport } from "../src/whatsapp/client.js";

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

function fakeRepository(values: OutboxItem[]) {
  const state = { shadowed: [] as string[], sent: [] as string[], retried: [] as string[] };
  const repository = {
    claimOutbox: async () => values,
    markOutboxShadowed: async (id: string) => void state.shadowed.push(id),
    markOutboxSent: async (id: string) => void state.sent.push(id),
    retryOutbox: async (value: OutboxItem) => {
      state.retried.push(value.id);
      return "retry" as const;
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

test("reaction and system events are recorded without creating chatty replies", () => {
  assert.equal(isReplyWorthyMessage("reaction"), false);
  assert.equal(isReplyWorthyMessage("system"), false);
  assert.equal(isReplyWorthyMessage("text"), true);
  assert.equal(isReplyWorthyMessage("image"), true);
});
