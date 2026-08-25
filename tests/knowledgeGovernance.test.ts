import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessKnowledgeSource,
  governKnowledgeResults,
  knowledgeContentFingerprint,
  KNOWLEDGE_GOVERNANCE_VERSION,
} from "../src/knowledge/governance.js";
import {
  searchStaticKnowledge,
  splitApprovedKnowledge,
  HERA_OPERATOR_POLICIES,
} from "../src/knowledge/search.js";
import type { KnowledgeResult } from "../src/types.js";

const registryUrl = new URL(
  "../governance/knowledge-source-registry.json",
  import.meta.url,
);

function result(overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Approved Hera policy",
    excerpt: "A service concern should be raised within seven calendar days.",
    sourceUrl: null,
    version: "internal-policy-v1",
    score: 1,
    ...overrides,
  };
}

test("static source identities distinguish operator policy from embedded v4 knowledge", () => {
  const operator = splitApprovedKnowledge(
    HERA_OPERATOR_POLICIES,
    "hera-operator-v3",
  );
  const embedded = splitApprovedKnowledge();

  assert.ok(operator.length >= 3);
  assert.ok(operator.every((section) => section.id.startsWith("hera-operator-v3:")));
  assert.ok(embedded.every((section) => section.id.startsWith("hera-kb-v4:")));
});

test("superseded seven-working-day policy cannot enter governed retrieval", () => {
  const legacy = result({
    id: "22222222-2222-4222-8222-222222222222",
    excerpt: "Service concerns should be raised within 7 working days.",
  });
  const current = result();

  const governed = governKnowledgeResults(
    "service concern refinement days",
    [legacy, current],
    5,
  );

  assert.deepEqual(governed.map((item) => item.id), [current.id]);
  assert.deepEqual(assessKnowledgeSource(legacy).reasons, [
    "superseded_policy_claim",
  ]);
});

test("untrusted hosts and malformed source identities fail closed", () => {
  const untrusted = result({
    id: "website-1",
    sourceUrl: "https://example.com/prices",
    version: "website-1",
  });
  const malformed = result({
    id: "internal-unknown",
    sourceUrl: null,
    version: "unknown",
  });

  assert.equal(assessKnowledgeSource(untrusted).allowed, false);
  assert.ok(assessKnowledgeSource(untrusted).reasons.includes("untrusted_source_host"));
  assert.equal(assessKnowledgeSource(malformed).allowed, false);
  assert.ok(assessKnowledgeSource(malformed).reasons.includes("unknown_source_class"));
});

test("query relevance is established before authority breaks a tie", () => {
  const constitution = result({
    id: "hera-service-constitution-2026-08-25.1",
    title: "HERA SERVICE CONSTITUTION — OWNER APPROVED",
    excerpt:
      "Refunds and compensation require the managing director or owner. Curly services are subject to consultation.",
    version: "hera-service-constitution-2026-08-25.1",
  });
  const curly = result({
    id: "hera-operator-v3:curly-matrix",
    title: "HERA OPERATOR-APPROVED CURL SERVICE MATRIX",
    excerpt:
      "Hera offers specialist curly haircuts at Tanglin Mall and Quayside Isle for waves, curls and coils.",
    version: "hera-operator-policy-v3",
  });

  const curlyResults = governKnowledgeResults(
    "curly haircut Tanglin Mall",
    [constitution, curly],
    5,
  );
  assert.equal(curlyResults[0]?.id, curly.id);

  const policyResults = governKnowledgeResults(
    "refund compensation authority",
    [curly, constitution],
    5,
  );
  assert.equal(policyResults[0]?.id, constitution.id);
});

test("static retrieval preserves relevant specialist answers without legacy policy text", () => {
  const curly = searchStaticKnowledge("Who is your curly specialist?", 5);
  assert.ok(curly.some((item) => item.id.startsWith("hera-operator-v3:")));
  assert.ok(curly.some((item) => /Alina is Rëzocut-certified/i.test(item.excerpt)));

  const concern = searchStaticKnowledge(
    "service concern refinement seven calendar days",
    8,
  );
  assert.ok(concern.some((item) => /seven calendar days/i.test(item.excerpt)));
  assert.equal(concern.some((item) => /7 working days/i.test(item.excerpt)), false);
});

test("knowledge fingerprints are stable and the registry records the controlled discrepancy", async () => {
  const sample = result();
  assert.equal(
    knowledgeContentFingerprint(sample),
    knowledgeContentFingerprint({ ...sample }),
  );
  assert.match(KNOWLEDGE_GOVERNANCE_VERSION, /^hera-knowledge-governance-/);

  const registry = JSON.parse(await readFile(registryUrl, "utf8")) as {
    allowedSourceHosts: string[];
    supersededClaims: Array<{ id: string; runtimeDisposition: string }>;
    controlledDiscrepancies: Array<{ id: string; automaticResolution: string }>;
  };
  assert.deepEqual(registry.allowedSourceHosts.sort(), [
    "herabeauty.sg",
    "www.herabeauty.sg",
  ]);
  assert.ok(
    registry.supersededClaims.some(
      (item) =>
        item.id === "seven_working_day_concern_window" &&
        item.runtimeDisposition === "exclude",
    ),
  );
  assert.ok(
    registry.controlledDiscrepancies.some(
      (item) =>
        item.id === "nanosmooth_price_references" &&
        item.automaticResolution === "prohibited",
    ),
  );
});
