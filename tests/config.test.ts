import assert from "node:assert/strict";
import test from "node:test";
import {
  getOperationsConfig,
  WHATSAPP_LIVE_CONFIRMATION_VALUE,
} from "../src/config.js";

const cronSecret = "cron-secret-longer-than-twenty-four-characters";

test("shadow mode remains safe without a live confirmation", () => {
  const config = getOperationsConfig({
    CRON_SECRET: cronSecret,
    WHATSAPP_SEND_MODE: "shadow",
  });
  assert.equal(config.sendMode, "shadow");
});

test("live mode refuses to start without the independent confirmation", () => {
  assert.throws(
    () =>
      getOperationsConfig({
        CRON_SECRET: cronSecret,
        WHATSAPP_SEND_MODE: "live",
      }),
    /WHATSAPP_LIVE_CONFIRMATION/,
  );
});

test("live mode refuses an incorrect confirmation", () => {
  assert.throws(
    () =>
      getOperationsConfig({
        CRON_SECRET: cronSecret,
        WHATSAPP_SEND_MODE: "live",
        WHATSAPP_LIVE_CONFIRMATION: "yes",
      }),
    /WHATSAPP_LIVE_CONFIRMATION/,
  );
});

test("even both live controls remain locked while certification is incomplete", () => {
  assert.throws(
    () =>
      getOperationsConfig({
        CRON_SECRET: cronSecret,
        WHATSAPP_SEND_MODE: "live",
        WHATSAPP_LIVE_CONFIRMATION: WHATSAPP_LIVE_CONFIRMATION_VALUE,
      }),
    /pre_production_certification_incomplete/,
  );
});
