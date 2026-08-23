import assert from "node:assert/strict";
import test from "node:test";
import {
  getD360Config,
  getWhatsAppProviderConfig,
} from "../src/config.js";

const apiKey = "d360-number-api-key-longer-than-twenty";
const webhookPassword = "webhook-password-longer-than-twenty-four";

test("Meta remains the default provider so Production cannot switch accidentally", () => {
  assert.equal(getWhatsAppProviderConfig({}).provider, "meta");
  assert.equal(
    getWhatsAppProviderConfig({ WHATSAPP_PROVIDER: "360dialog" }).provider,
    "360dialog",
  );
});

test("360dialog configuration uses only the official Direct API hosts", () => {
  const config = getD360Config({
    D360_API_KEY: apiKey,
    D360_WEBHOOK_PASSWORD: webhookPassword,
  });
  assert.equal(config.baseUrl, "https://waba-v2.360dialog.io");
  assert.equal(config.webhookUsername, "hera-receptionist");
  assert.equal(config.humanTakeoverMinutes, 120);

  assert.throws(
    () =>
      getD360Config({
        D360_API_KEY: apiKey,
        D360_API_BASE_URL: "https://example.com",
        D360_WEBHOOK_PASSWORD: webhookPassword,
      }),
    /D360_API_BASE_URL/,
  );
});

test("360dialog configuration rejects weak webhook credentials and unsafe takeover windows", () => {
  assert.throws(
    () =>
      getD360Config({
        D360_API_KEY: apiKey,
        D360_WEBHOOK_PASSWORD: "too-short",
      }),
    /360dialog configuration/,
  );
  assert.throws(
    () =>
      getD360Config({
        D360_API_KEY: apiKey,
        D360_WEBHOOK_PASSWORD: webhookPassword,
        D360_HUMAN_TAKEOVER_MINUTES: "2",
      }),
    /D360_HUMAN_TAKEOVER_MINUTES/,
  );
});
