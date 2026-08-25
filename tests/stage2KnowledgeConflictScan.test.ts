import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const conciergeUrl = new URL("../api/concierge.js", import.meta.url);
const knowledgeUrl = new URL("../src/knowledge/search.ts", import.meta.url);
const constitutionUrl = new URL(
  "../docs/HERA_SERVICE_CONSTITUTION.md",
  import.meta.url,
);
const sourceRegisterUrl = new URL("../docs/SOURCE_OF_TRUTH.md", import.meta.url);
const catalogueUrl = new URL(
  "../governance/knowledge-authority-catalog.json",
  import.meta.url,
);

test("runtime business sources contain no superseded seven-working-day rule", async () => {
  const sources = await Promise.all(
    [conciergeUrl, knowledgeUrl, constitutionUrl, sourceRegisterUrl].map((url) =>
      readFile(url, "utf8"),
    ),
  );
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /service concerns?[^\n]{0,180}7 working days/i);
  assert.match(combined, /seven calendar days/i);
  assert.match(combined, /appointment completion/i);
});

test("the approved policy keeps booking, financial and consent completion claims authority bounded", async () => {
  const combined = [
    await readFile(conciergeUrl, "utf8"),
    await readFile(knowledgeUrl, "utf8"),
    await readFile(constitutionUrl, "utf8"),
  ].join("\n");

  assert.match(combined, /Timely remains Hera.?s booking source of truth/i);
  assert.match(combined, /must not claim[^\n]{0,220}(created|changed|cancelled|confirmed)/i);
  assert.match(combined, /no (?:authority|refund or compensation authority)/i);
  assert.match(combined, /separate explicit consent/i);
  assert.match(combined, /captur(?:e|ing)[^\n]{0,220}publish/i);
});

test("the source catalogue documents a complete precedence without duplicate ranks", async () => {
  const catalogue = JSON.parse(await readFile(catalogueUrl, "utf8")) as {
    sourcePrecedence: Array<{
      rank: number;
      sourceClass: string;
      runtimeEligible: boolean;
      conflictRule: string;
    }>;
  };

  const ranks = catalogue.sourcePrecedence.map((source) => source.rank);
  const classes = catalogue.sourcePrecedence.map((source) => source.sourceClass);
  assert.equal(new Set(ranks).size, ranks.length);
  assert.equal(new Set(classes).size, classes.length);
  assert.deepEqual(ranks, [...ranks].sort((left, right) => left - right));
  assert.equal(catalogue.sourcePrecedence[0]?.sourceClass, "deterministic_safety_legal");
  assert.equal(catalogue.sourcePrecedence[1]?.sourceClass, "approved_service_constitution");
  assert.ok(
    catalogue.sourcePrecedence.every(
      (source) => source.runtimeEligible && source.conflictRule.length > 0,
    ),
  );
});
