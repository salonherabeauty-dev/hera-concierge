import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";
import {
  RESET_MAX_MODEL_CALLS,
  RESET_MAX_TRANSPORT_RETRIES,
  RESET_OPENAI_MODEL_ID,
  RESET_OPENAI_REASONING_EFFORT,
} from "../src/reset/engine.js";
import type {
  ResetDraftDecision,
  ResetEvidenceBundle,
} from "../src/reset/types.js";
import { validateResetDraft } from "../src/reset/validator.js";

const migrations = [
  "20260830030000_create_receptionist_reset_v3.sql",
  "20260830030001_harden_receptionist_reset_v3.sql",
  "20260830030002_complete_receptionist_reset_v3.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));
const engineUrl = new URL("../src/reset/engine.ts", import.meta.url);
const workerUrl = new URL("../src/reset/worker.ts", import.meta.url);
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const generateUrl = new URL(
  "../api/command-centre/reset-generate.ts",
  import.meta.url,
);
const uiUrl = new URL(
  "../public/command-centre/reset-workspace.js",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

function evidence(clientTurn: string): ResetEvidenceBundle {
  return {
    channel: "Tanglin Mall WhatsApp",
    outlet: "Tanglin Mall",
    turnId: "turn-test",
    turnVersion: 1,
    client: { displayName: "Neo", whatsappEnding: "2052" },
    consolidatedClientTurn: clientTurn,
    fragments: [],
    recentConversation: [],
    knowledge: [
      {
        id: "price-balayage",
        title: "Hera official price — Balayage Full Head — Tanglin Mall",
        excerpt: "Balayage price guidance at Tanglin Mall.",
        sourceUrl: null,
        version: "test",
        score: 1,
        category: "price",
      },
      {
        id: "staff-monica",
        title: "Hera current team expertise — Monica Babchina",
        excerpt: "Primary approved specialties: Blonding and dimensional colour.",
        sourceUrl: null,
        version: "test",
        score: 1,
        category: "staff",
      },
    ],
    currentClientAppointments: [],
    authorityBoundaries: {
      mayDraft: true,
      maySendAutomatically: false,
      mayWriteTimely: false,
      mayConfirmLiveAvailability: false,
      mayConfirmBookingChangeWithoutVerifiedOutcome: false,
      mayApproveRefundOrCompensation: false,
      humanApprovalRequired: true,
    },
  };
}

function decision(finalReply: string): ResetDraftDecision {
  return {
    replyRecommended: true,
    finalReply,
    intent: "complaint",
    currentEmergency: false,
    currentEmergencyReason: null,
    reviewPriority: "urgent",
    verifiedFactsUsed: [],
    factsStillMissing: [],
    rationaleSummary: "Test decision.",
  };
}

test("every reset migration is syntactically valid and enforces ready-or-failed terminal states", async () => {
  const sqlFiles = await Promise.all(migrations.map((url) => readFile(url, "utf8")));
  for (const sql of sqlFiles) assert.doesNotThrow(() => parse(sql));
  const sql = sqlFiles.join("\n");

  assert.match(sql, /ai_client_turns_v3/);
  assert.match(sql, /ai_reply_candidates_v3/);
  assert.match(sql, /ai_turn_jobs_v3/);
  assert.match(sql, /delivery_control\s+text\s+not null default 'human_only'/i);
  assert.match(sql, /status in \('collecting', 'processing', 'ready', 'failed', 'superseded'\)/i);
  assert.match(sql, /status = 'ready'[\s\S]*candidate_id is not null/i);
  assert.match(sql, /status = 'failed'[\s\S]*failure_code is not null/i);
  assert.match(sql, /model_attempts[\s\S]*between 0 and 2/i);
  assert.match(sql, /ai_reserve_human_send_v3/);
  assert.match(sql, /source_turn_not_latest/);
  assert.match(sql, /candidate_hash_mismatch/);
  assert.match(sql, /recipient_mismatch/);
  assert.match(sql, /customer_service_window_expired/);
  assert.match(sql, /ai_tanglin_whatsapp_reply_violation/);
  assert.match(sql, /ai_trim_reset_fragments_v3/);
  assert.match(sql, /stale_historical/i);
  assert.doesNotMatch(sql, /v_new_fragments,\s*\)\s*returning/i);
});

test("one Sol Max call with no provider retry is code-enforced", async () => {
  const engine = await readFile(engineUrl, "utf8");
  assert.equal(RESET_OPENAI_MODEL_ID, "openai/gpt-5.6-sol");
  assert.equal(RESET_OPENAI_REASONING_EFFORT, "max");
  assert.equal(RESET_MAX_MODEL_CALLS, 1);
  assert.match(engine, /callNumber:\s*1/);
  assert.doesNotMatch(engine, /callNumber:\s*2/);
  assert.match(engine, /if \(!firstValidation\.passed\)/);
  assert.equal(RESET_MAX_TRANSPORT_RETRIES, 0);
  assert.match(engine, /from "@ai-sdk\/openai"/);
  assert.match(engine, /createOpenAI/);
  assert.match(engine, /\.responses\(RESET_OPENAI_PROVIDER_MODEL_ID\)/);
  assert.match(engine, /process\.env\.OPENAI_API_KEY/);
  assert.match(engine, /maxRetries:\s*RESET_MAX_TRANSPORT_RETRIES/);
  assert.match(engine, /reasoningEffort:\s*RESET_OPENAI_REASONING_EFFORT/);
  assert.doesNotMatch(engine, /serviceTier:\s*"priority"/);
  assert.doesNotMatch(engine, /from "@ai-sdk\/gateway"/);
  assert.doesNotMatch(engine, /anthropic\//i);
  assert.doesNotMatch(engine, /verifyReceptionistDecision|verifyFinalClientReply|runFinalResponseGate/);
});

test("automatic drafting cannot import or call a WhatsApp sender or Timely writer", async () => {
  const [worker, engine] = await Promise.all([
    readFile(workerUrl, "utf8"),
    readFile(engineUrl, "utf8"),
  ]);
  for (const source of [worker, engine]) {
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*whatsapp\/(?:d360Client|client)\.js["']/i,
    );
    assert.doesNotMatch(source, /new\s+(?:D360WhatsAppClient|MetaWhatsAppClient)\b/);
    assert.doesNotMatch(source, /\.sendText\s*\(/);
    assert.doesNotMatch(source, /(?:create|update|cancel|reschedule).*Timely/i);
  }
  assert.match(worker, /providerSendCalls:\s*0/);
  assert.match(worker, /timelyWriteCalls:\s*0/);
});

test("360dialog stores Reset-v3 turns without starting AI and only the human endpoint drains one turn", async () => {
  const [webhook, generate] = await Promise.all([
    readFile(webhookUrl, "utf8"),
    readFile(generateUrl, "utf8"),
  ]);
  assert.match(webhook, /useReceptionistResetV3/);
  assert.match(webhook, /resetRepository\.appendFragment/);
  assert.match(webhook, /resetTurnIds\.add/);
  assert.doesNotMatch(webhook, /reset-v3-webhook-/);
  assert.match(webhook, /if \(!resetV3 && wakeableJobIds\.length > 0\)/);
  assert.match(generate, /reset-v3-human-generate-/);
  assert.match(generate, /waitUntil\([\s\S]*drainResetTurnJobs/);
  assert.match(generate, /initiatedByHuman:\s*true/);
  assert.match(generate, /automaticDeliveryAllowed:\s*false/);
});

test("the Command Centre exposes manual generation, review and send states", async () => {
  const source = await readFile(uiUrl, "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /Generate AI Reply/);
  assert.match(source, /No AI cost has been incurred/);
  assert.match(source, /AI draft ready/);
  assert.match(source, /AI could not prepare this reply/);
  assert.doesNotMatch(source, /No button press is required/);
  assert.doesNotMatch(source, /will draft automatically/);
  assert.match(source, /Send to Client/);
  assert.match(source, /Regenerate/);
  assert.match(source, /Take Over \/ Hold/);
  assert.match(source, /Date\.parse\(right\.lastMessageAt\) - Date\.parse\(left\.lastMessageAt\)/);
  assert.match(source, /state\.exactCommit/);
  assert.match(source, /retryAvailable/);
  assert.match(source, /single AI retry has already been used/i);
  assert.doesNotMatch(source, /\/api\/command-centre\/bootstrap/);
  assert.doesNotMatch(source, /Create AI Reply/);
});

test("Vercel build is offline and does not process mutable staging conversations", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    buildCommand?: string;
    rewrites?: Array<{ source: string; destination: string }>;
  };
  assert.equal(config.buildCommand, "npm run build");
  assert.ok(
    config.rewrites?.some(
      (item) => item.source === "/command-centre" &&
        item.destination === "/command-centre/reset.html",
    ),
  );
});

test("historical medical allegations in a legal letter are not forced into current-emergency guidance", () => {
  const clientTurn =
    "Subject: LETTER OF DEMAND. Our client alleges that she suffered scalp irritation after a service on 8 August 2026 and was treated by a dermatologist. She is currently seeking compensation.";
  const reply =
    "Thank you for sending the letter. We acknowledge receipt and will review the stated service details and requests carefully. We will continue the review with you here and update you on the next authorised step without prejudging the outcome.";
  const result = validateResetDraft({
    decision: decision(reply),
    evidence: evidence(clientTurn),
  });
  assert.equal(result.passed, true, result.issues.join(" | "));
});

test("a genuinely current breathing emergency requires urgent medical guidance", () => {
  const clientTurn = "I cannot breathe and my lips are swollen right now after the colour service.";
  const unsafe = decision(
    "I’m sorry you are feeling unwell. Please send us a photo and we will review this with you.",
  );
  unsafe.intent = "medical_or_scalp_concern";
  unsafe.currentEmergency = true;
  unsafe.currentEmergencyReason = "Current breathing difficulty and swelling.";
  unsafe.reviewPriority = "emergency";
  const result = validateResetDraft({
    decision: unsafe,
    evidence: evidence(clientTurn),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /urgent medical guidance/i.test(issue)));
});

test("bureaucratic complaint copy, wrong-outlet routing and unauthorised outcomes fail hard", () => {
  const poor = decision(
    "Our authorised team will verify the appointment and payment records once the review is complete. We will issue your refund and the Sentosa team will contact you directly.",
  );
  const result = validateResetDraft({
    decision: poor,
    evidence: evidence("I am unhappy with my balayage and want a refund."),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /Tanglin Mall/i.test(issue)));
  assert.ok(result.issues.some((issue) => /refund/i.test(issue)));
  assert.ok(result.issues.some((issue) => /bureaucratic/i.test(issue)));
});

test("explicit liability admissions fail without blocking ordinary service ownership", () => {
  const admitted = validateResetDraft({
    decision: decision("Hera accepts full liability for causing your injury."),
    evidence: evidence("I am making a legal claim."),
  });
  assert.equal(admitted.passed, false);
  assert.ok(admitted.issues.some((issue) => /liability/i.test(issue)));

  const ownership = validateResetDraft({
    decision: decision(
      "I’m very sorry this has happened. We will review the service details carefully and continue the conversation with you here.",
    ),
    evidence: evidence("I am unhappy with my balayage."),
  });
  assert.equal(ownership.passed, true, ownership.issues.join(" | "));
});
