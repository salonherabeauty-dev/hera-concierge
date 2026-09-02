import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";
import {
  requireWebsiteConciergePreview,
  useWebsiteConciergePreview,
  WEBSITE_CONCIERGE_PREVIEW_BRANCH,
} from "../src/website-concierge/boundary.js";
import {
  detectWebsiteOutlet,
  outletClarificationIsRelevant,
  websiteEvidenceQueries,
} from "../src/website-concierge/evidence.js";
import {
  WEBSITE_CONCIERGE_MAX_MODEL_CALLS,
  WEBSITE_CONCIERGE_MODEL_ID,
  WEBSITE_CONCIERGE_REASONING_EFFORT,
} from "../src/website-concierge/engine.js";
import type {
  WebsiteConciergeDecision,
  WebsiteConciergeEvidenceBundle,
} from "../src/website-concierge/types.js";
import { validateWebsiteConciergeDecision } from "../src/website-concierge/validator.js";

const migrationUrl = new URL(
  "../supabase/migrations/20260902090000_create_website_concierge_staging_v1.sql",
  import.meta.url,
);
const messageApiUrl = new URL(
  "../api/website-concierge/message.ts",
  import.meta.url,
);
const engineUrl = new URL("../src/website-concierge/engine.ts", import.meta.url);
const previewHtmlUrl = new URL(
  "../public/website-concierge-preview/index.html",
  import.meta.url,
);
const previewJsUrl = new URL(
  "../public/website-concierge-preview/widget.js",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

function evidence(message: string): WebsiteConciergeEvidenceBundle {
  return {
    channel: "Hera public website",
    visitorOutlet: "unspecified",
    outletClarificationOperationallyRelevant: false,
    visitorMessage: message,
    history: [],
    knowledge: [
      {
        id: "approved-price",
        title: "Hera official price — Curly Haircut",
        excerpt: "Approved price evidence.",
        sourceUrl: null,
        version: "test",
        score: 1,
        category: "price",
        outletScope: "either",
      },
    ],
    authorityBoundaries: {
      mayAnswerDirectly: true,
      maySendWhatsApp: false,
      mayWriteTimely: false,
      mayConfirmLiveAvailability: false,
      mayConfirmBookingOrAppointmentChange: false,
      mayApproveRefundOrCompensation: false,
      mayDiagnoseMedicalCondition: false,
    },
    contactOptions: {
      bookingUrl: "https://bookings.gettimely.com/herabeauty1/bb/book",
      tanglinPhone: "+65 6732 1206",
      tanglinWhatsAppUrl: "https://api.whatsapp.com/send?phone=6592371254",
      sentosaPhone: "+65 6268 8949",
    },
  };
}

function decision(reply: string): WebsiteConciergeDecision {
  return {
    reply,
    intent: "service_information",
    resolvedOutlet: "unspecified",
    needsOutletClarification: false,
    suggestedActions: ["none"],
    verifiedFactsUsed: [],
    factsStillMissing: [],
    rationaleSummary: "Test response.",
  };
}

test("the website adapter is restricted to its own private Preview branch", () => {
  assert.equal(WEBSITE_CONCIERGE_PREVIEW_BRANCH, "website/concierge-staging-adapter");
  assert.equal(
    useWebsiteConciergePreview({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: WEBSITE_CONCIERGE_PREVIEW_BRANCH,
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    useWebsiteConciergePreview({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    } as NodeJS.ProcessEnv),
    false,
  );
  assert.throws(() =>
    requireWebsiteConciergePreview({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    } as NodeJS.ProcessEnv),
  );
});

test("the website adapter keeps the Sol Max brain but cannot import delivery paths", async () => {
  const [engine, api] = await Promise.all([
    readFile(engineUrl, "utf8"),
    readFile(messageApiUrl, "utf8"),
  ]);
  assert.equal(WEBSITE_CONCIERGE_MODEL_ID, "openai/gpt-5.6-sol");
  assert.equal(WEBSITE_CONCIERGE_REASONING_EFFORT, "max");
  assert.equal(WEBSITE_CONCIERGE_MAX_MODEL_CALLS, 2);
  assert.match(engine, /generateText/);
  assert.match(engine, /submitWebsiteConciergeReply/);
  assert.match(engine, /callNumber:\s*1/);
  assert.match(engine, /callNumber:\s*2/);
  assert.doesNotMatch(engine, /callNumber:\s*3/);
  for (const source of [engine, api]) {
    assert.doesNotMatch(source, /D360WhatsAppClient|MetaWhatsAppClient|sendText/);
    assert.doesNotMatch(source, /createTimely|updateTimely|cancelTimely|rescheduleTimely/i);
  }
  assert.match(api, /text\/event-stream/);
  assert.match(api, /automaticWhatsAppSendAllowed:\s*false/);
  assert.match(api, /timelyWriteAllowed:\s*false/);
});

test("website sessions are stored separately from WhatsApp contacts and messages", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_website_concierge_sessions_v1/);
  assert.match(sql, /ai_website_concierge_messages_v1/);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /ai_consume_website_concierge_quota_v1/);
  assert.match(sql, /message_count between 0 and 40/i);
  assert.doesNotMatch(sql, /insert into public\.ai_contacts/i);
  assert.doesNotMatch(sql, /insert into public\.ai_conversations/i);
  assert.doesNotMatch(sql, /insert into public\.ai_messages\b/i);
  assert.doesNotMatch(sql, /ai_outbox|ai_human_send_reservations_v3/i);
});

test("two-outlet detection asks only when operationally relevant", () => {
  assert.equal(detectWebsiteOutlet("Can I visit Sentosa Cove?"), "sentosa");
  assert.equal(detectWebsiteOutlet("Is this available at Tanglin Mall?"), "tanglin");
  assert.equal(detectWebsiteOutlet("Either outlet is fine"), "either");
  assert.equal(outletClarificationIsRelevant("Can dark box dye be balayaged safely?"), false);
  assert.equal(outletClarificationIsRelevant("Can I book tomorrow and what is the price?"), true);
});

test("service, staff, price and authority retrieval cover broad Hera questions", () => {
  const cases = [
    "Which extension method is best for fine hair and what is the price?",
    "Can beige balayage work over dark box dye?",
    "Who specialises in grey blending at Tanglin?",
    "Can I book a curly haircut tomorrow at Sentosa?",
  ];
  const plans = cases.map((message) =>
    websiteEvidenceQueries(message, detectWebsiteOutlet(message)),
  );
  assert.ok(plans.every((plan) => plan.some((item) => item.category === "authority")));
  assert.ok(plans[0]?.some((item) => /extension/i.test(item.query)));
  assert.ok(plans[0]?.some((item) => item.category === "price"));
  assert.ok(plans[1]?.some((item) => /balayage/i.test(item.query)));
  assert.ok(plans[2]?.some((item) => item.category === "staff"));
  assert.ok(plans[3]?.some((item) => /curly/i.test(item.query)));
});

test("website validation blocks false bookings, refund promises and uncited prices", () => {
  const falseBooking = validateWebsiteConciergeDecision({
    decision: decision("We have booked your appointment for tomorrow."),
    evidence: evidence("Please book tomorrow."),
  });
  assert.equal(falseBooking.passed, false);

  const refund = validateWebsiteConciergeDecision({
    decision: decision("We will issue your refund today."),
    evidence: evidence("I want a refund."),
  });
  assert.equal(refund.passed, false);

  const price = validateWebsiteConciergeDecision({
    decision: decision("The service is S$165."),
    evidence: evidence("What is the price?"),
  });
  assert.equal(price.passed, false);
});

test("the private preview preserves the current widget design and never calls the legacy endpoint", async () => {
  const [html, javascript] = await Promise.all([
    readFile(previewHtmlUrl, "utf8"),
    readFile(previewJsUrl, "utf8"),
  ]);
  assert.match(html, /Hera Concierge/);
  assert.match(html, /Here to help/);
  assert.match(html, /Book at Hera/);
  assert.match(html, /Contact Hera/);
  assert.match(javascript, /\/api\/website-concierge\/session/);
  assert.match(javascript, /\/api\/website-concierge\/message/);
  assert.doesNotMatch(javascript, /hera-concierge\.vercel\.app\/api\/concierge/);
});

test("Vercel gives only the isolated website message route a long runtime", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    functions?: Record<string, { maxDuration?: string | number }>;
  };
  assert.equal(config.functions?.["api/website-concierge/message.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/website-concierge/session.ts"]?.maxDuration, 30);
});
