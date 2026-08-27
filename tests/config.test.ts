import assert from "node:assert/strict";
import test from "node:test";
import {
  getOperationsConfig,
  HERA_INTERNAL_PILOT_BRANCH,
  HERA_INTERNAL_PILOT_ID,
  WHATSAPP_LIVE_CONFIRMATION_VALUE,
  WHATSAPP_PILOT_CONFIRMATION_VALUE,
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

test("internal pilot mode accepts only the exact private Preview interlocks", () => {
  const config = getOperationsConfig({
    CRON_SECRET: cronSecret,
    WHATSAPP_SEND_MODE: "pilot",
    WHATSAPP_PILOT_CONFIRMATION: WHATSAPP_PILOT_CONFIRMATION_VALUE,
    HERA_INTERNAL_PILOT_ALLOWLIST: "6591112222,6593334444",
    HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS: "10",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: HERA_INTERNAL_PILOT_BRANCH,
  });

  assert.equal(config.sendMode, "pilot");
  assert.deepEqual(config.internalPilot, {
    pilotId: HERA_INTERNAL_PILOT_ID,
    allowlistedWaIds: ["6591112222", "6593334444"],
    maxSendAttempts: 10,
  });
});

test("internal pilot mode refuses Production and every other branch", () => {
  const common = {
    CRON_SECRET: cronSecret,
    WHATSAPP_SEND_MODE: "pilot",
    WHATSAPP_PILOT_CONFIRMATION: WHATSAPP_PILOT_CONFIRMATION_VALUE,
    HERA_INTERNAL_PILOT_ALLOWLIST: "6591112222",
    HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS: "10",
  };

  assert.throws(
    () =>
      getOperationsConfig({
        ...common,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: HERA_INTERNAL_PILOT_BRANCH,
      }),
    /VERCEL_ENV/,
  );
  assert.throws(
    () =>
      getOperationsConfig({
        ...common,
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "main",
      }),
    /VERCEL_GIT_COMMIT_REF/,
  );
});

test("internal pilot mode refuses unsafe allowlists, cap expansion and mixed live controls", () => {
  const common = {
    CRON_SECRET: cronSecret,
    WHATSAPP_SEND_MODE: "pilot",
    WHATSAPP_PILOT_CONFIRMATION: WHATSAPP_PILOT_CONFIRMATION_VALUE,
    HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS: "10",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: HERA_INTERNAL_PILOT_BRANCH,
  };

  for (const allowlist of ["", "+6591112222", "6591112222,6591112222"]) {
    assert.throws(
      () =>
        getOperationsConfig({
          ...common,
          HERA_INTERNAL_PILOT_ALLOWLIST: allowlist,
        }),
      /HERA_INTERNAL_PILOT_ALLOWLIST/,
    );
  }

  assert.throws(
    () =>
      getOperationsConfig({
        ...common,
        HERA_INTERNAL_PILOT_ALLOWLIST: "6591112222",
        HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS: "11",
      }),
    /HERA_INTERNAL_PILOT_MAX_SEND_ATTEMPTS/,
  );
  assert.throws(
    () =>
      getOperationsConfig({
        ...common,
        HERA_INTERNAL_PILOT_ALLOWLIST: "6591112222",
        WHATSAPP_LIVE_CONFIRMATION: WHATSAPP_LIVE_CONFIRMATION_VALUE,
      }),
    /WHATSAPP_LIVE_CONFIRMATION/,
  );
});
