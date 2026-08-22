import assert from "node:assert/strict";
import test from "node:test";
import {
  assessGrounding,
  canonicalizeSources,
} from "../src/policy/grounding.js";
import type { AgentDecision } from "../src/types.js";

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "I can help with that.",
    intent: "other",
    risk: "green",
    confidence: 0.9,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    rationale: "Evaluation fixture.",
    ...overrides,
  };
}

test("canonicalizes, deduplicates and filters model-proposed sources", () => {
  const approved = new Map([
    ["hera-hours", "Official Hera opening hours"],
    ["hera-pricing", "Approved Hera service guide"],
  ]);
  assert.deepEqual(
    canonicalizeSources(
      [
        { id: "hera-hours", title: "Invented model title" },
        { id: "unknown", title: "Unknown" },
        { id: "hera-hours", title: "Duplicate" },
        { id: "hera-pricing", title: "Another invented title" },
      ],
      approved,
    ),
    [
      { id: "hera-hours", title: "Official Hera opening hours" },
      { id: "hera-pricing", title: "Approved Hera service guide" },
    ],
  );
});

test("blocks Hera pricing and operating answers without approved evidence", () => {
  const pricing = assessGrounding(
    "How much is balayage?",
    decision({
      intent: "pricing",
      reply: "Balayage is $300.",
      factualBasis: ["approved_hera_source"],
    }),
  );
  assert.equal(pricing.grounded, false);
  assert.ok(pricing.flags.includes("hera_fact_without_approved_source"));
  assert.ok(pricing.flags.includes("pricing_answer_without_approved_source"));
  assert.equal(pricing.confidenceCap, 0.35);

  const hours = assessGrounding(
    "What time do you open?",
    decision({ intent: "location_hours", factualBasis: ["no_factual_claim"] }),
  );
  assert.equal(hours.grounded, false);
  assert.ok(hours.flags.includes("hera_operational_answer_without_approved_source"));
});

test("accepts booking guidance and zero-result appointment lookups with tool evidence", () => {
  const booking = assessGrounding(
    "Can I book online?",
    decision({
      intent: "booking",
      sources: [{ id: "hera-digital-tools", title: "Hera official digital tools" }],
      factualBasis: ["approved_hera_source"],
    }),
  );
  assert.equal(booking.grounded, true);

  const lookup = assessGrounding(
    "Do I have an appointment?",
    decision({
      intent: "appointment_lookup",
      sources: [
        {
          id: "booking:current-client-lookup",
          title: "Current client appointment lookup",
        },
      ],
      factualBasis: ["current_client_record"],
    }),
  );
  assert.equal(lookup.grounded, true);
});

test("requires deterministic calculation evidence but permits general education", () => {
  const calculation = assessGrounding(
    "What is 9% GST on $300?",
    decision({
      intent: "pricing",
      sources: [{ id: "calculation:gst-9", title: "GST calculation" }],
      factualBasis: ["client_provided_fact", "deterministic_calculation"],
    }),
  );
  assert.equal(calculation.grounded, true);

  const education = assessGrounding(
    "Why can bleach make hair feel dry?",
    decision({
      intent: "service_advice",
      factualBasis: ["general_hairdressing_knowledge"],
    }),
  );
  assert.equal(education.required, false);
  assert.equal(education.grounded, true);
});

test("uses reviewed localized containment when grounding fails", () => {
  const result = assessGrounding(
    "请问你们几点开门？",
    decision({ intent: "location_hours", factualBasis: ["no_factual_claim"] }),
  );
  assert.equal(result.grounded, false);
  assert.match(result.replyOverride ?? "", /未经核实|无法/);
});
