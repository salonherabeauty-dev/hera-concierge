import assert from "node:assert/strict";
import test from "node:test";
import { parseWhatsAppWebhook } from "../src/whatsapp/webhookPayload.js";

const textMessage = {
  from: "6591112222",
  id: "wamid.text-1",
  timestamp: "1787280000",
  type: "text",
  text: { body: "How much is balayage?" },
};

test("normalizes Meta text, voice, image and status events", () => {
  const parsed = parseWhatsAppWebhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              contacts: [{ wa_id: "6591112222", profile: { name: "A Client" } }],
              messages: [
                textMessage,
                {
                  from: "6591112222",
                  id: "wamid.audio-1",
                  timestamp: "1787280001",
                  type: "audio",
                  audio: { id: "media-audio", mime_type: "audio/ogg", voice: true },
                },
                {
                  from: "6591112222",
                  id: "wamid.image-1",
                  timestamp: "1787280002",
                  type: "image",
                  image: { id: "media-image", mime_type: "image/jpeg", caption: "My hair" },
                },
              ],
              statuses: [
                {
                  id: "wamid.out-1",
                  recipient_id: "6591112222",
                  status: "delivered",
                  timestamp: "1787280003",
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.inbound.length, 3);
  assert.deepEqual(parsed.inbound[0], {
    providerMessageId: "wamid.text-1",
    fromWaId: "6591112222",
    profileName: "A Client",
    phoneNumberId: "phone-1",
    businessAccountId: "waba-1",
    kind: "text",
    text: "How much is balayage?",
    media: undefined,
    contextMessageId: undefined,
    providerTimestamp: "2026-08-21T02:40:00.000Z",
    raw: textMessage,
  });
  assert.equal(parsed.inbound[1]?.media?.voice, true);
  assert.equal(parsed.inbound[1]?.text, "[Voice message received]");
  assert.equal(parsed.inbound[2]?.media?.caption, "My hair");
  assert.equal(parsed.statuses[0]?.status, "delivered");
});

test("deduplicates repeated provider message and status ids in one webhook", () => {
  const value = {
    metadata: { phone_number_id: "phone-1" },
    contacts: [{ wa_id: "6591112222", profile: { name: "A Client" } }],
    messages: [textMessage, textMessage],
    statuses: [
      { id: "out-1", status: "read", timestamp: "1787280004" },
      { id: "out-1", status: "read", timestamp: "1787280004" },
    ],
  };
  const parsed = parseWhatsAppWebhook({
    entry: [{ id: "waba-1", changes: [{ value }, { value }] }],
  });
  assert.equal(parsed.inbound.length, 1);
  assert.equal(parsed.statuses.length, 1);
});

test("ignores malformed entries rather than creating synthetic messages", () => {
  const parsed = parseWhatsAppWebhook({
    entry: [{ changes: [{ value: { messages: [{ id: "missing-from" }] } }] }],
  });
  assert.deepEqual(parsed, { inbound: [], statuses: [] });
});
