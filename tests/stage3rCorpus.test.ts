import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildStage3rCorpus,
  stage3rCorpusQuotas,
} from "../src/certification/stage3r/corpus.js";
import {
  buildStage3rJudgeExecutionPlan,
  getStage3rJudgeConfigurations,
} from "../src/certification/stage3r/judge.js";
import type {
  Stage3rCaseType,
  Stage3rGoldCase,
  Stage3rSeedScenario,
} from "../src/certification/stage3r/types.js";

const scenariosUrl = new URL("../evals/scenarios.json", import.meta.url);
const expandedUrl = new URL(
  "../evals/scenarios-expanded.json",
  import.meta.url,
);
const goldUrl = new URL(
  "../evals/stage3r-gold-cases.json",
  import.meta.url,
);

async function json<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function corpus() {
  const [scenarios, expanded, goldCases] = await Promise.all([
    json<Stage3rSeedScenario[]>(scenariosUrl),
    json<Stage3rSeedScenario[]>(expandedUrl),
    json<Stage3rGoldCase[]>(goldUrl),
  ]);
  return buildStage3rCorpus({
    seeds: [...scenarios, ...expanded],
    goldCases,
  });
}

test("the Stage 3-R corpus deterministically contains 2,010 exact-response cases", async () => {
  const cases = await corpus();
  const quotas = stage3rCorpusQuotas();
  const expectedTotal = Object.values(quotas).reduce(
    (sum, value) => sum + value,
    0,
  );

  assert.equal(expectedTotal, 2010);
  assert.equal(cases.length, 2010);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.equal(new Set(cases.map((item) => item.family)).size, 40);
  assert.ok(cases.every((item) => item.message.trim().length > 0));
});

test("the corrected corpus execution plan has exactly 16,848 minimum model calls", async () => {
  const cases = await corpus();
  const configurations = getStage3rJudgeConfigurations();
  const pipelineCalls = cases.reduce(
    (sum, item) => sum + (item.minimumRisk === "black" ? 1 : 3),
    0,
  );
  const judgeCalls = cases.reduce(
    (sum, item) =>
      sum + buildStage3rJudgeExecutionPlan(item, configurations).length,
    0,
  );

  assert.equal(pipelineCalls, 5772);
  assert.equal(judgeCalls, 11076);
  assert.equal(pipelineCalls + judgeCalls, 16848);
});

test("the Stage 3-R corpus meets every approved case-class quota", async () => {
  const cases = await corpus();
  const quotas = stage3rCorpusQuotas();
  const caseTypes = Object.keys(quotas) as Stage3rCaseType[];

  for (const caseType of caseTypes) {
    assert.equal(
      cases.filter((item) => item.caseType === caseType).length,
      quotas[caseType],
      `unexpected ${caseType} count`,
    );
  }
  assert.equal(cases.filter((item) => item.caseType === "hera_gold").length, 360);
  assert.equal(
    cases.filter((item) => item.caseType === "singapore_salon_pattern").length,
    350,
  );
  assert.equal(
    cases.filter((item) => item.caseType === "international_salon_pattern").length,
    400,
  );
});

test("the corpus covers all supported languages, high-consequence and multi-intent pressure", async () => {
  const cases = await corpus();
  const languages = new Set(cases.map((item) => item.language));

  assert.deepEqual(languages, new Set(["en", "zh", "ms", "ta"]));
  assert.ok(
    cases.filter(
      (item) => item.caseType === "multilingual_singapore_english",
    ).length >= 100,
  );
  assert.ok(cases.filter((item) => item.highConsequence).length >= 500);
  assert.ok(cases.filter((item) => item.multiIntent).length >= 100);
  assert.ok(cases.filter((item) => item.adversarial).length >= 20);
  assert.ok(
    cases.some(
      (item) =>
        item.minimumRisk === "black" &&
        item.requiredElements.some((element) => /emergency/i.test(element)),
    ),
  );
});

test("gold cases retain reference, requirement and prohibited-claim contracts", async () => {
  const cases = await corpus();
  const gold = cases.filter((item) => item.caseType === "hera_gold");

  assert.equal(gold.length, 360);
  assert.ok(gold.every((item) => Boolean(item.referenceResponse?.trim())));
  assert.ok(gold.every((item) => item.requiredElements.length > 0));
  assert.ok(gold.every((item) => item.forbiddenClaims.length > 0));
  assert.ok(
    gold.some(
      (item) =>
        item.language === "zh" &&
        /沙龙经理|经理/u.test(item.referenceResponse ?? ""),
    ),
  );
  assert.ok(
    gold.some(
      (item) =>
        item.language === "ms" &&
        /995/.test(item.referenceResponse ?? ""),
    ),
  );
  assert.ok(
    gold.some(
      (item) =>
        item.language === "ta" &&
        /தனியுரிமை/u.test(item.referenceResponse ?? ""),
    ),
  );
});

test("the corpus contains no direct client identifiers or raw review attribution", async () => {
  const cases = await corpus();
  const directIdentifier =
    /(?:\b[STFG]\d{7}[A-Z]\b|\b\+?65\s?[689]\d{3}\s?\d{4}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu;

  for (const item of cases) {
    assert.doesNotMatch(item.message, directIdentifier, item.id);
    assert.doesNotMatch(item.message, /Yelp reviewer|Google reviewer|reviewer named/i);
    assert.ok(item.sourceSeedId.trim().length > 0);
    assert.ok(item.variation.trim().length > 0);
  }
});

test("corpus construction is stable across repeated builds", async () => {
  const [first, second] = await Promise.all([corpus(), corpus()]);

  assert.deepEqual(
    first.map((item) => [item.id, item.message, item.caseType]),
    second.map((item) => [item.id, item.message, item.caseType]),
  );
});
