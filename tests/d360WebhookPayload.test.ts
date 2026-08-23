import assert from "node:assert/strict";
import test from "node:test";
import { parseD360Webhook } from "../src/whatsapp/d360WebhookPayload.js";

const timestamp = "1787548800";

test("360dialog normal messages remain compatible with the hardened Meta parser", () => {
  const parsed = parseD360Webhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              contacts: [{ wa_id: "6591112222", profile: { name: "Client" } }],
              messages: [
                {
                  id: "wamid.inbound-1",
                  from: "6591112222",
                  timestamp,
                  type: "text",
                  text: { body: "Can I book a consultation?" },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.inbound.length, 1);
  assert.equal(parsed.inbound[0]?.providerMessageId, "wamid.inbound-1");
  assert.equal(parsed.humanEchoes.length, 0);
});

test("Coexistence staff echoes are isolated from inbound AI jobs", () => {
  const echo = {
    id: "wamid.human-1",
    from: "6581111562",
    to: "6591112222",
    timestamp,
    type: "text",
    text: { body: "I am checking this personally for you now." },
  };
  const parsed = parseD360Webhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              metadata: { phone_number_id: "phone-1" },
              message_echoes: [echo, echo],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.inbound.length, 0);
  assert.equal(parsed.humanEchoes.length, 1);
  assert.equal(parsed.humanEchoes[0]?.providerMessageId, "wamid.human-1");
  assert.equal(parsed.humanEchoes[0]?.toWaId, "6591112222");
  assert.equal(parsed.humanEchoes[0]?.fromWaId, "6581111562");
  assert.equal(
    parsed.humanEchoes[0]?.text,
    "I am checking this personally for you now.",
  );
});

test("Coexistence history and app-state events are counted but never treated as new clients", () => {
  const parsed = parseD360Webhook({
    event: "history",
    entry: [
      {
        id: "waba-1",
        changes: [
          { field: "history", value: {} },
          { field: "smb_app_state_sync", value: {} },
        ],
      },
    ],
  });
  assert.deepEqual(parsed.ignored, { history: 2, appStateSync: 1 });
  assert.equal(parsed.inbound.length, 0);
  assert.equal(parsed.humanEchoes.length, 0);
});

test("malformed Coexistence echoes fail closed instead of targeting an invalid number", () => {
  const parsed = parseD360Webhook({
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              message_echoes: [
                {
                  id: "wamid.invalid",
                  to: "not-a-number",
                  timestamp,
                  type: "text",
                  text: { body: "ignore" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.equal(parsed.humanEchoes.length, 0);
});
