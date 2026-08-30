import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getAiConfig,
  HERA_AI_PROVIDER_POLICY_VERSION,
  HERA_OPENAI_MODEL_ID,
  HERA_OPENAI_REASONING_EFFORT,
} from "../src/config.js";
import {
  detectLuxuryClientCopyViolations,
  HERA_LUXURY_CLIENT_COPY_POLICY_VERSION,
  HERA_OPENAI_ONLY_POLICY_VERSION,
  HERA_OPENAI_STAGE_TIMEOUT_MS,
  OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS,
} from "../src/ai/receptionist.js";

const runtimeUrl = new URL("../src/ai/receptionist.ts", import.meta.url);
const configUrl = new URL("../src/config.ts", import.meta.url);
const envUrl = new URL("../.env.example", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

test("text intelligence is code-locked to OpenAI GPT-5.6 Sol with no alternate-provider fallback", () => {
  const config = getAiConfig({
    HERA_AI_PRIMARY_MODEL: "another-provider/another-model",
    HERA_AI_FALLBACK_MODELS: "another-provider/fallback",
    HERA_AI_VERIFIER_MODEL: "another-provider/verifier",
    HERA_AI_TRANSCRIPTION_MODEL: "openai/gpt-4o-transcribe",
  });

  assert.equal(HERA_OPENAI_MODEL_ID, "openai/gpt-5.6-sol");
  assert.equal(HERA_OPENAI_REASONING_EFFORT, "max");
  assert.equal(HERA_AI_PROVIDER_POLICY_VERSION, "hera-openai-sol-max-only-1.1.0");
  assert.equal(config.primaryModel, HERA_OPENAI_MODEL_ID);
  assert.equal(config.verifierModel, HERA_OPENAI_MODEL_ID);
  assert.deepEqual(config.fallbackModels, []);
});

test("every text stage enforces OpenAI-only routing, native max reasoning and a real stage-wide timeout", async () => {
  const source = await readFile(runtimeUrl, "utf8");
  assert.match(source, /HERA_OPENAI_MODEL_ID = "openai\/gpt-5\.6-sol"/);
  assert.match(source, /HERA_OPENAI_REASONING_EFFORT = "max"/);
  assert.match(source, /only: \[HERA_OPENAI_PROVIDER\]/);
  assert.match(source, /order: \[HERA_OPENAI_PROVIDER\]/);
  assert.match(source, /reasoningEffort: HERA_OPENAI_REASONING_EFFORT/);
  assert.match(source, /store: false/);
  assert.match(source, /fallbackModels: \[\]/);
  assert.match(source, /AbortSignal\.timeout/);
  assert.match(source, /abortSignal: stageAbortSignal/);
  assert.match(source, /enforceOpenAiSolMax\(input\.config, "response"\)/);
  assert.match(source, /enforceOpenAiSolMax\(input\.config, "verification"\)/);
  assert.match(source, /enforceOpenAiSolMax\(input\.config, "final_verification"\)/);
  assert.deepEqual(HERA_OPENAI_STAGE_TIMEOUT_MS, {
    response: 240_000,
    verification: 240_000,
    final_verification: 240_000,
  });
  assert.doesNotMatch(source, /anthropic\//i);
});

test("runtime-facing configuration and documentation expose no alternate text model", async () => {
  const [config, env, readme] = await Promise.all([
    readFile(configUrl, "utf8"),
    readFile(envUrl, "utf8"),
    readFile(readmeUrl, "utf8"),
  ]);

  for (const source of [config, env, readme]) {
    assert.doesNotMatch(source, /anthropic\//i);
    assert.doesNotMatch(source, /claude opus/i);
  }
  assert.doesNotMatch(env, /HERA_AI_PRIMARY_MODEL|HERA_AI_FALLBACK_MODELS|HERA_AI_VERIFIER_MODEL/);
});

test("the final OpenAI client-copy controller uses individual 10-point thresholds with no averaging", () => {
  assert.equal(
    HERA_OPENAI_ONLY_POLICY_VERSION,
    "hera-openai-sol-max-only-1.1.0",
  );
  assert.equal(
    HERA_LUXURY_CLIENT_COPY_POLICY_VERSION,
    "hera-luxury-client-copy-2.1.0",
  );
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /9\/10 as the minimum/i);
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /Require 10\/10 for factuality/i);
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /No averaging can hide a weak dimension/i);
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /Tanglin Mall is already established/i);
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /natural, idiomatic English/i);
  assert.match(OPENAI_FINAL_CLIENT_RESPONSE_INSTRUCTIONS, /legal correspondence/i);
});

test("the exact bureaucratic Neo complaint wording fails the luxury client-copy contract", () => {
  const poorReply =
    "I’m very sorry to hear you are unhappy with today’s balayage at Tanglin Mall. I’ve passed this to our management team, who are authorised to review the service and your refund request, and they will verify the appointment and payment records before coming back to you with a confirmed outcome. So that the review is as accurate as possible, could you share the stylist’s name and clear photos. You will hear from us directly once the review is complete.";

  const issues = detectLuxuryClientCopyViolations(poorReply);
  assert.ok(issues.length >= 1);
  assert.ok(issues.some((issue) => /bureaucratic/i.test(issue)));
});

test("wrong-outlet routing fails independently from language quality", () => {
  const wrongChannelReply =
    "Could you confirm which Hera outlet you visited, Tanglin Mall or Sentosa, so the Sentosa team can contact you directly?";
  const issues = detectLuxuryClientCopyViolations(wrongChannelReply);
  assert.ok(issues.some((issue) => /Tanglin Mall-only WhatsApp channel/i.test(issue)));
});

test("a natural, caring and channel-consistent Hera complaint reply passes the deterministic language screen", () => {
  const strongReply =
    "Hi Neo, I’m genuinely sorry that today’s balayage has left you so unhappy, and thank you for telling us directly. We are treating your concern as a priority and will review today’s consultation and service details, including your refund request. Please send us a few clear photos in natural daylight and let us know which aspects of the colour concern you most. We will continue the review with you here and update you with the next steps.";

  assert.deepEqual(detectLuxuryClientCopyViolations(strongReply), []);
});
