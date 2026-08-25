import assert from "node:assert/strict";
import test from "node:test";
import {
  searchStaticKnowledge,
  splitApprovedKnowledge,
} from "../src/knowledge/search.js";

test("splits the existing approved Hera knowledge into retrievable sections", () => {
  const sections = splitApprovedKnowledge();
  assert.ok(sections.length > 15);
  assert.ok(sections.some((section) => section.title.includes("PRICE")));
});

test("retrieves Hera pricing and location evidence without a model call", () => {
  const pricing = searchStaticKnowledge("balayage price long hair", 5);
  assert.ok(pricing.length > 0);
  assert.ok(pricing.some((result) => /balayage/i.test(result.excerpt)));

  const location = searchStaticKnowledge("Tanglin Mall address opening hours", 3);
  assert.ok(location.some((result) => /163 Tanglin Road/.test(result.excerpt)));

  const waitPolicy = searchStaticKnowledge("waited more than 10 minutes discount", 3);
  assert.ok(waitPolicy.some((result) => /10% discount/.test(result.excerpt)));

  const strandTest = searchStaticKnowledge("strand test failed bleach", 3);
  assert.ok(strandTest.some((result) => /do not proceed with bleach/i.test(result.excerpt)));
});

test("retrieves the operator-approved curly service and specialist matrix", () => {
  const service = searchStaticKnowledge(
    "Does Hera offer curly haircuts at Tanglin Mall?",
    3,
  );
  assert.ok(
    service.some(
      (result) =>
        result.version === "hera-operator-policy-v3" &&
        /both Tanglin Mall and Quayside Isle/i.test(result.excerpt),
    ),
  );

  const specialist = searchStaticKnowledge("Who is your curly specialist?", 3);
  assert.ok(
    specialist.some(
      (result) =>
        /Alina is Rëzocut-certified/i.test(result.excerpt) &&
        /Phoeve is REZO Cut and Cadō Academy certified/i.test(result.excerpt) &&
        /Irene is known for precision cutting and curl transformations/i.test(
          result.excerpt,
        ),
    ),
  );
});

test("retrieves the owner-approved service concern and authority rules", () => {
  const concern = searchStaticKnowledge(
    "How long do I have to raise a service concern and who approves a refinement?",
    5,
  );
  assert.ok(
    concern.some(
      (result) =>
        result.version === "hera-operator-policy-v3" &&
        /seven calendar days/i.test(result.excerpt) &&
        /salon manager may authorise/i.test(result.excerpt),
    ),
  );
  assert.ok(
    concern.every((result) => !/7 working days/i.test(result.excerpt)),
  );

  const booking = searchStaticKnowledge(
    "Can the AI confirm my Timely booking?",
    5,
  );
  assert.ok(
    booking.some(
      (result) =>
        /Timely is the booking source of truth/i.test(result.excerpt) &&
        /must never claim that an appointment was created/i.test(result.excerpt),
    ),
  );

  const consent = searchStaticKnowledge(
    "Can Hera publish my photo without separate consent?",
    5,
  );
  assert.ok(
    consent.some(
      (result) =>
        /Separate explicit consent is required/i.test(result.excerpt) &&
        /privacy-officer review/i.test(result.excerpt),
    ),
  );
});
