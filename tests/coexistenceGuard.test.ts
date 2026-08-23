import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import type { OutboxItem } from "../src/types.js";
import { drainOutbox } from "../src/worker.js";
import type { WhatsAppTransport } from "../src/whatsapp/client.js";

function item(): OutboxItem {
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
  };
}

function fakeRepository() {
  const state = {
    retried: [] as Array<{ id: string; retryable: boolean }>,
  };
  const repository = {
    claimOutbox: async () => [item()],
    getSourceMessageProviderTimestamp: async () => new Date().toISOString(),
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

test("a manual WhatsApp Business App takeover suppresses the AI send", async () => {
  const { repository } = fakeRepository();
  let sends = 0;
  const transport: WhatsAppTransport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "must-not-send" };
    },
    downloadMedia: async () => ({
      data: new Uint8Array(),
      mimeType: "application/octet-stream",
    }),
  };

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
    authorizeOutbound: async () => "shadowed",
  });

  assert.equal(sends, 0);
  assert.equal(result.outboxShadowed, 1);
  assert.equal(result.outboxSent, 0);
});

test("a fail-closed coexistence guard can dead-letter an invalid outbox item", async () => {
  const { repository } = fakeRepository();
  const result = await drainOutbox({
    repository,
    sendMode: "live",
    workerId: "test-worker",
    authorizeOutbound: async () => "dead",
  });
  assert.equal(result.outboxDead, 1);
  assert.equal(result.outboxSent, 0);
});

test("a temporary coexistence database failure retries without contacting 360dialog", async () => {
  const { repository, state } = fakeRepository();
  let sends = 0;
  const transport: WhatsAppTransport = {
    sendText: async () => {
      sends += 1;
      return { providerMessageId: "must-not-send" };
    },
    downloadMedia: async () => ({
      data: new Uint8Array(),
      mimeType: "application/octet-stream",
    }),
  };

  const result = await drainOutbox({
    repository,
    whatsapp: transport,
    sendMode: "live",
    workerId: "test-worker",
    authorizeOutbound: async () => {
      throw new Error("temporary database failure");
    },
  });

  assert.equal(sends, 0);
  assert.deepEqual(state.retried, [{ id: "outbox-1", retryable: true }]);
  assert.equal(result.outboxRetried, 1);
});
