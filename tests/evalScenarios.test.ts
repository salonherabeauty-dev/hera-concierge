import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { detectSupportedClientLocale } from "../src/policy/locale.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
  isOptOutRequest,
  SAFE_CONCERN_REPLY,
  SAFE_MEDICAL_CONCERN_REPLY,
  SAFE_OPT_OUT_REPLY,
  SAFE_PRIVACY_LEGAL_REPLY,
  SAFE_STRAND_TEST_REPLY,
  URGENT_SAFETY_REPLY,
} from "../src/policy/risk.js";
import type { AgentDecision, RiskLevel } from "../src/types.js";

type Containment =
  | "concern"
  | "medical"
  | "opt_out"
  | "privacy_legal"
  | "strand_test"
  | "urgent";

interface HistoryTurn {
  direction: "inbound" | "outbound";
  text: string;
}

interface Scenario {
  id: string;
  category: string;
  message: string;
  minimumRisk: RiskLevel;
  securityFlag?: string;
  expectedContainment?: Containment;
  intents?: string[];
  history?: HistoryTurn[];
  priorRisk?: RiskLevel;
}

interface TaxonomyItem {
  id: string;
  name: string;
  mode:
    | "answer"
    | "answer_with_boundaries"
    | "contain_and_continue"
    | "contain_and_notify";
  baselineRisk: RiskLevel;
}

const ranks: Record<RiskLevel, number> = {
  green: 0,
  amber: 1,
  red: 2,
  black: 3,
};

async function loadJson<T>(filename: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`../evals/${filename}`, import.meta.url), "utf8"),
  ) as T;
}

async function loadScenarios(): Promise<Scenario[]> {
  const [baseline, expanded] = await Promise.all([
    loadJson<Scenario[]>("scenarios.json"),
    loadJson<Scenario[]>("scenarios-expanded.json"),
  ]);
  return [...baseline, ...expanded];
}

function neutralDecision(): AgentDecision {
  return {
    reply: "I can help with that.",
    intent: "other",
    risk: "green",
    confidence: 0.8,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    rationale: "Evaluation fixture.",
  };
}

test("the receptionist taxonomy contains exactly 40 covered message families", async () => {
  const [taxonomy, scenarios] = await Promise.all([
    loadJson<TaxonomyItem[]>("taxonomy.json"),
    loadScenarios(),
  ]);
  const taxonomyIds = new Set(taxonomy.map((item) => item.id));
  const coveredIds = new Set(
    scenarios.flatMap((scenario) => [scenario.category, ...(scenario.intents ?? [])]),
  );

  assert.equal(taxonomy.length, 40);
  assert.equal(taxonomyIds.size, taxonomy.length, "taxonomy IDs must be unique");
  assert.deepEqual(coveredIds, taxonomyIds);
  assert.ok(taxonomy.every((item) => item.name.trim().length > 0));
  assert.ok(taxonomy.every((item) => Object.hasOwn(ranks, item.baselineRisk)));

  for (const scenario of scenarios) {
    assert.ok(taxonomyIds.has(scenario.category), `${scenario.id} has an unknown category`);
    for (const intent of scenario.intents ?? []) {
      assert.ok(taxonomyIds.has(intent), `${scenario.id} has an unknown intent ${intent}`);
    }
  }
});

test("the executable corpus covers risk, multi-intent, multilingual and sequence cases", async () => {
  const scenarios = await loadScenarios();
  const multiIntent = scenarios.filter((scenario) => (scenario.intents?.length ?? 0) > 1);
  const highRiskMultiIntent = multiIntent.filter((scenario) =>
    ["red", "black"].includes(scenario.minimumRisk),
  );
  const sequences = scenarios.filter((scenario) => (scenario.history?.length ?? 0) > 0);
  const optOuts = scenarios.filter(
    (scenario) => scenario.expectedContainment === "opt_out",
  );

  assert.ok(scenarios.length >= 119);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  assert.deepEqual(
    new Set(scenarios.map((scenario) => scenario.minimumRisk)),
    new Set(["green", "amber", "red", "black"]),
  );
  assert.ok(multiIntent.length >= 40);
  assert.ok(highRiskMultiIntent.length >= 15);
  assert.ok(sequences.length >= 8);
  assert.ok(optOuts.length >= 5);

  for (const scenario of scenarios) {
    const deterministic = classifyDeterministicRisk(scenario.message);
    const effectiveRisk = highestRisk(
      deterministic.risk,
      scenario.priorRisk ?? "green",
    );
    assert.ok(
      ranks[effectiveRisk] >= ranks[scenario.minimumRisk],
      `${scenario.id} effective risk ${effectiveRisk} is below ${scenario.minimumRisk}`,
    );
    if (scenario.securityFlag) {
      assert.ok(deterministic.securityFlags.includes(scenario.securityFlag));
    }
  }
});

test("high-consequence scenarios receive deterministic containment", async () => {
  const scenarios = await loadScenarios();
  const englishReplies: Record<Containment, string> = {
    concern: SAFE_CONCERN_REPLY,
    medical: SAFE_MEDICAL_CONCERN_REPLY,
    opt_out: SAFE_OPT_OUT_REPLY,
    privacy_legal: SAFE_PRIVACY_LEGAL_REPLY,
    strand_test: SAFE_STRAND_TEST_REPLY,
    urgent: URGENT_SAFETY_REPLY,
  };

  for (const scenario of scenarios.filter((item) => item.expectedContainment)) {
    const assessment = assessPolicy(
      scenario.message,
      neutralDecision(),
      scenario.priorRisk ?? "green",
    );
    assert.ok(assessment.replyOverride, `${scenario.id} has no containment reply`);
    assert.equal(assessment.canAutoSend, true);

    if (detectSupportedClientLocale(scenario.message) === "en") {
      assert.equal(
        assessment.replyOverride,
        englishReplies[scenario.expectedContainment!],
        `${scenario.id} received the wrong deterministic containment`,
      );
    }
    if (scenario.expectedContainment === "opt_out") {
      assert.ok(isOptOutRequest(scenario.message), `${scenario.id} was not detected as opt-out`);
      assert.equal(assessment.risk, "red");
      assert.equal(assessment.requiresManagementNotification, true);
    }
    if (scenario.expectedContainment === "urgent") {
      assert.equal(assessment.risk, "black");
    }
  }
});

test("conversation risk cannot silently downgrade on a later harmless message", async () => {
  const scenarios = (await loadScenarios()).filter(
    (scenario) => (scenario.history?.length ?? 0) > 0,
  );

  for (const scenario of scenarios) {
    const assessment = assessPolicy(
      scenario.message,
      neutralDecision(),
      scenario.priorRisk ?? "green",
    );
    assert.ok(
      ranks[assessment.risk] >= ranks[scenario.priorRisk ?? "green"],
      `${scenario.id} downgraded ${scenario.priorRisk} to ${assessment.risk}`,
    );
  }
});
