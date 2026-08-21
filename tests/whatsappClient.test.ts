import assert from "node:assert/strict";
import test from "node:test";
import {
  MetaWhatsAppClient,
  WhatsAppApiError,
} from "../src/whatsapp/client.js";

const config = {
  graphApiVersion: "v99.0",
  accessToken: "test-access-token-that-is-never-logged",
  phoneNumberId: "phone-123",
};

test("sends the supported Cloud API text payload and returns Meta's id", async () => {
  let requestBody: unknown;
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://graph.facebook.com/v99.0/phone-123/messages");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, `Bearer ${config.accessToken}`);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.sent-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const client = new MetaWhatsAppClient(config, request);
  const result = await client.sendText("6591112222", "Hello from Hera");
  assert.equal(result.providerMessageId, "wamid.sent-1");
  assert.deepEqual(requestBody, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "6591112222",
    type: "text",
    text: { preview_url: false, body: "Hello from Hera" },
  });
});

test("never includes the access token in a Meta API error message", async () => {
  const request = (async () =>
    new Response(JSON.stringify({ error: { message: "bad request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const client = new MetaWhatsAppClient(config, request);

  await assert.rejects(
    client.sendText("6591112222", "Hello"),
    (error: unknown) => {
      assert.ok(error instanceof WhatsAppApiError);
      assert.doesNotMatch(error.message, new RegExp(config.accessToken));
      return true;
    },
  );
});
