import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppApiError } from "../src/whatsapp/client.js";
import { D360WhatsAppClient } from "../src/whatsapp/d360Client.js";

const apiKey = "d360-number-api-key-longer-than-twenty";

function client(request: typeof fetch) {
  return new D360WhatsAppClient(
    { apiKey, baseUrl: "https://waba-v2.360dialog.io" },
    request,
  );
}

test("360dialog transport sends through the Direct API with the Number API Key", async () => {
  let calls = 0;
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    assert.equal(String(input), "https://waba-v2.360dialog.io/messages");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("D360-API-KEY"), apiKey);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.to, "6591112222");
    assert.equal(body.type, "text");
    return new Response(JSON.stringify({ messages: [{ id: "wamid.d360-1" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const result = await client(request).sendText("6591112222", "Hello from Hera");
  assert.equal(calls, 1);
  assert.equal(result.providerMessageId, "wamid.d360-1");
});

test("360dialog media download rewrites the lookaside path through the API host", async () => {
  const urls: string[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    assert.equal(new Headers(init?.headers).get("D360-API-KEY"), apiKey);
    if (urls.length === 1) {
      return new Response(
        JSON.stringify({
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=456&hash=abc",
          mime_type: "image/jpeg",
          sha256: "sha-value",
          file_size: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Content-Length": "3" },
    });
  }) as typeof fetch;

  const media = await client(request).downloadMedia("media-123");
  assert.deepEqual(urls, [
    "https://waba-v2.360dialog.io/media-123",
    "https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=123&ext=456&hash=abc",
  ]);
  assert.deepEqual([...media.data], [1, 2, 3]);
  assert.equal(media.mimeType, "image/jpeg");
  assert.equal(media.sha256, "sha-value");
});

test("360dialog transport rejects untrusted media hosts and permanent API errors", async () => {
  const untrusted = (async () =>
    new Response(
      JSON.stringify({ url: "https://evil.example/file", mime_type: "image/jpeg" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    () => client(untrusted).downloadMedia("media-123"),
    /untrusted media URL/,
  );

  const rejected = (async () =>
    new Response(JSON.stringify({ error: "invalid request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    () => client(rejected).sendText("6591112222", "Hello"),
    (error: unknown) => error instanceof WhatsAppApiError && error.status === 400,
  );
});
