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
