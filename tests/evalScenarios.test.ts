import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyDeterministicRisk } from "../src/policy/risk.js";
import type { RiskLevel } from "../src/types.js";

interface Scenario {
  id: string;
  message: string;
  minimumRisk: RiskLevel;
  securityFlag?: string;
}

const ranks: Record<RiskLevel, number> = { green: 0, amber: 1, red: 2, black: 3 };

test("the launch evaluation corpus covers routine through emergency risk", async () => {
  const scenarios = JSON.parse(
    await readFile(new URL("../evals/scenarios.json", import.meta.url), "utf8"),
  ) as Scenario[];
  assert.ok(scenarios.length >= 30);
  assert.deepEqual(new Set(scenarios.map((scenario) => scenario.minimumRisk)), new Set([
    "green",
    "amber",
    "red",
    "black",
  ]));

  for (const scenario of scenarios) {
    const deterministic = classifyDeterministicRisk(scenario.message);
    assert.ok(
      ranks[deterministic.risk] >= ranks[scenario.minimumRisk],
      `${scenario.id} deterministic risk ${deterministic.risk} is below ${scenario.minimumRisk}`,
    );
    if (scenario.securityFlag) {
      assert.ok(deterministic.securityFlags.includes(scenario.securityFlag));
    }
  }
});
