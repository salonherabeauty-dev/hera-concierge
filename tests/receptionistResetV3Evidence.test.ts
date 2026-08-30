import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import {
  buildResetEvidenceBundle,
  consolidatedTurnText,
  needsResetAppointmentLookup,
  resetEvidenceQueries,
} from "../src/reset/evidence.js";
import type {
  ClaimedResetTurnJob,
  ResetTurnContact,
} from "../src/reset/types.js";
import type { KnowledgeResult } from "../src/types.js";

function job(overrides: Partial<ClaimedResetTurnJob> = {}): ClaimedResetTurnJob {
  return {
    jobId: "job-test",
    turnId: "turn-test",
    conversationId: "conversation-test",
    contactId: "contact-test",
    version: 1,
    sourceMessageId: "message-2",
    lastFragmentMessageId: "message-2",
    consolidatedText: "",
    fragments: [],
    firstFragmentAt: "2026-08-30T01:00:00.000Z",
    lastFragmentAt: "2026-08-30T01:00:05.000Z",
    attempts: 1,
    ...overrides,
  };
}

const contact: ResetTurnContact = {
  id: "contact-test",
  waId: "6599992052",
  profileName: "Neo",
  preferredLanguage: "English",
};

test("explicit stylist names and commercial evidence outrank a broad multi-topic turn", () => {
  const queries = resetEvidenceQueries(
    "Could Monica advise on blonde balayage and how much would it cost? I also need curl hydration and extensions information.",
  );
  const monica = queries.findIndex((item) => item.query === "Monica");
  const authority = queries.findIndex((item) => /service constitution/i.test(item.query));
  const price = queries.findIndex((item) => item.category === "price");

  assert.ok(authority >= 0);
  assert.ok(monica >= 0);
  assert.ok(price >= 0);
  assert.ok(monciaBeforeBroad(queries, monica));
  assert.ok(queries.length <= 16);
});

function monciaBeforeBroad(
  queries: ReturnType<typeof resetEvidenceQueries>,
  monicaIndex: number,
): boolean {
  const broadIndex = queries.findIndex(
    (item) => item.query.startsWith("Could Monica advise"),
  );
  return broadIndex < 0 || monicaIndex < broadIndex;
}

test("appointment lookup is conditional rather than running for every salon question", () => {
  assert.equal(
    needsResetAppointmentLookup("Which stylist is best for beige blonde and what is the price?"),
    false,
  );
  assert.equal(
    needsResetAppointmentLookup("Can I move my appointment to Saturday at 3 pm?"),
    true,
  );
});

test("out-of-order fragments are assembled by provider chronology and unreadable attachments stay inside the same turn", () => {
  const text = consolidatedTurnText(
    job({
      fragments: [
        {
          messageId: "message-3",
          kind: "unknown",
          text: null,
          media: { filename: "evidence.heic" },
          providerTimestamp: "2026-08-30T01:00:06.000Z",
          readable: false,
          rawType: "unsupported",
        },
        {
          messageId: "message-2",
          kind: "text",
          text: "and I would like to know the estimated price.",
          media: null,
          providerTimestamp: "2026-08-30T01:00:05.000Z",
          readable: true,
          rawType: "text",
        },
        {
          messageId: "message-1",
          kind: "text",
          text: "Hi, I need advice on blonde balayage",
          media: null,
          providerTimestamp: "2026-08-30T01:00:00.000Z",
          readable: true,
          rawType: "text",
        },
      ],
    }),
  );

  assert.ok(text.indexOf("Hi, I need advice") < text.indexOf("estimated price"));
  assert.match(text, /could not be interpreted/i);
  assert.doesNotMatch(text, /^\[Unsupported WhatsApp message received\]$/i);
});

test("the evidence bundle preserves actual staff and price document classes and skips unnecessary appointment lookup", async () => {
  let appointmentLookups = 0;
  const repository = {
    async searchApprovedKnowledge(query: string): Promise<KnowledgeResult[]> {
      const results: KnowledgeResult[] = [];
      if (/Monica/i.test(query)) {
        results.push({
          id: "staff-monica",
          title: "Hera current team expertise — Monica Babchina",
          excerpt:
            "Staff: Monica Babchina. Primary approved specialties: Blonding; dimensional colour; sun-kissed colour.",
          sourceUrl: null,
          version: "owner-master-test",
          score: 1,
        });
      }
      if (/price|balayage/i.test(query)) {
        results.push({
          id: "price-balayage",
          title: "Hera official price — Balayage Full Head — Both",
          excerpt: "Approved balayage price guidance for both outlets.",
          sourceUrl: null,
          version: "owner-master-test",
          score: 0.8,
        });
      }
      return results;
    },
    async lookupBookingsByWaId() {
      appointmentLookups += 1;
      return [];
    },
  } as unknown as ReceptionistRepository;

  const bundle = await buildResetEvidenceBundle({
    repository,
    job: job({
      consolidatedText: "Is Monica suitable for blonde balayage and what is the estimated price?",
      fragments: [
        {
          messageId: "message-1",
          kind: "text",
          text: "Is Monica suitable for blonde balayage and what is the estimated price?",
          media: null,
          providerTimestamp: "2026-08-30T01:00:00.000Z",
          readable: true,
          rawType: "text",
        },
      ],
    }),
    contact,
    recentConversation: [],
  });

  assert.equal(appointmentLookups, 0);
  assert.ok(
    bundle.knowledge.some(
      (item) => item.id === "staff-monica" && item.category === "staff",
    ),
  );
  assert.ok(
    bundle.knowledge.some(
      (item) => item.id === "price-balayage" && item.category === "price",
    ),
  );
  assert.equal(bundle.channel, "Tanglin Mall WhatsApp");
  assert.equal(bundle.authorityBoundaries.maySendAutomatically, false);
});