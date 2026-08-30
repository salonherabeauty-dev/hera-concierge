import assert from "node:assert/strict";
import test from "node:test";
import type { ReceptionistRepository } from "../src/db/repository.js";
import type { KnowledgeResult } from "../src/types.js";
import {
  buildResetEvidencePacket,
  resetKnowledgeQueries,
} from "../src/reset/knowledge.js";

function knowledge(input: {
  id: string;
  title: string;
  excerpt: string;
  score?: number;
}): KnowledgeResult {
  return {
    id: input.id,
    title: input.title,
    excerpt: input.excerpt,
    sourceUrl: null,
    version: "hera-service-price-expertise-master-v1.2-2026-08-27",
    score: input.score ?? 1,
  };
}

test("a broad client question is split into focused knowledge searches", () => {
  const queries = resetKnowledgeQueries(
    "I have curly hair and want hydration, balayage, extensions and a price. Which stylist is suitable, perhaps Monica or Alina?",
  );
  for (const expected of [
    "Tanglin Mall WhatsApp",
    "service constitution",
    "action authority",
    "curly hair",
    "curl hydration",
    "curly specialist",
    "balayage",
    "hair extensions",
    "Monica",
    "Alina",
  ]) {
    assert.ok(queries.includes(expected), expected);
  }
  assert.ok(queries.length <= 16);
});

test("complaint, booking and strand-test questions retrieve their separate authority domains", () => {
  const queries = resetKnowledgeQueries(
    "I want a refund after a failed strand test and need to reschedule my appointment.",
  );
  assert.ok(queries.includes("service concern"));
  assert.ok(queries.includes("refund"));
  assert.ok(queries.includes("strand test"));
  assert.ok(queries.includes("bleach"));
  assert.ok(queries.includes("booking authority"));
});

test("evidence assembly preserves multiple owner-approved records and filters Sentosa-only options", async () => {
  const dynamic: KnowledgeResult[] = [
    knowledge({
      id: "staff-monica",
      title: "Hera current team expertise — Monica Babchina",
      excerpt: "Staff: Monica Babchina. Blonding and dimensional colour. Normal outlet: Reception / Timely must confirm.",
      score: 0.9,
    }),
    knowledge({
      id: "staff-alina",
      title: "Hera current team expertise — Alina Tan",
      excerpt: "Staff: Alina Tan. Rëzocut-certified curl architecture and curl hydration.",
      score: 0.8,
    }),
    knowledge({
      id: "price-curly",
      title: "Hera official price — Curly Haircut & Styling — Both",
      excerpt: "Curly Haircut & Styling, available at both outlets, published price before 9% GST.",
      score: 0.7,
    }),
    knowledge({
      id: "sentosa-only",
      title: "Hera official price — Sentosa-only service — Sentosa Cove",
      excerpt: "This service is available only at Sentosa Cove.",
      score: 1,
    }),
  ];
  const repository = {
    searchApprovedKnowledge: async (query: string) =>
      dynamic.filter((item) =>
        `${item.title} ${item.excerpt}`.toLowerCase().includes(
          query.toLowerCase().split(/\s+/)[0] ?? "",
        ),
      ),
    lookupBookingsByWaId: async () => [],
  } as unknown as ReceptionistRepository;

  const packet = await buildResetEvidencePacket({
    repository,
    clientTurnText:
      "I need a curly haircut with hydration and would like a stylist recommendation and price.",
    waId: "6591234567",
  });

  assert.equal(packet.tanglinOnly, true);
  assert.equal(packet.liveAvailabilityVerified, false);
  assert.ok(packet.knowledge.some((item) => item.id === "staff-alina"));
  assert.ok(packet.knowledge.some((item) => item.id === "price-curly"));
  assert.ok(!packet.knowledge.some((item) => item.id === "sentosa-only"));
  assert.ok(packet.knowledge.length <= 24);
});

test("current-client appointment records are looked up only for scheduling intent", async () => {
  let lookups = 0;
  const repository = {
    searchApprovedKnowledge: async () => [],
    lookupBookingsByWaId: async () => {
      lookups += 1;
      return [
        {
          id: "booking-1",
          clientName: "Neo",
          serviceName: "Balayage",
          stylistName: "Aleksandra",
          locationName: "Tanglin Mall",
          appointmentAt: "2026-09-05T05:30:00.000Z",
          bookingStatus: "confirmed",
          price: null,
          currency: "SGD",
        },
      ];
    },
  } as unknown as ReceptionistRepository;

  const information = await buildResetEvidencePacket({
    repository,
    clientTurnText: "What is balayage?",
    waId: "6591234567",
  });
  assert.equal(lookups, 0);
  assert.deepEqual(information.bookings, []);

  const scheduling = await buildResetEvidencePacket({
    repository,
    clientTurnText: "Could I reschedule my appointment to Saturday?",
    waId: "6591234567",
  });
  assert.equal(lookups, 1);
  assert.equal(scheduling.bookings.length, 1);
});

test("an explicit Sentosa information question may retrieve Sentosa facts without changing channel ownership", async () => {
  const sentosa = knowledge({
    id: "sentosa-info",
    title: "Hera service — Sentosa Cove",
    excerpt: "General information about a service at Sentosa Cove.",
  });
  const repository = {
    searchApprovedKnowledge: async () => [sentosa],
    lookupBookingsByWaId: async () => [],
  } as unknown as ReceptionistRepository;

  const packet = await buildResetEvidencePacket({
    repository,
    clientTurnText: "Does your Sentosa outlet offer this service?",
    waId: "6591234567",
  });
  assert.equal(packet.tanglinOnly, true);
  assert.ok(packet.knowledge.some((item) => item.id === "sentosa-info"));
});
