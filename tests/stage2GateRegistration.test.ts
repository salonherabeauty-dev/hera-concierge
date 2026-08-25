import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessReleaseMode,
  LIVE_PRODUCTION_APPROVED,
  PASSED_PRE_PRODUCTION_GATES,
  PRE_PRODUCTION_GATE_REGISTER_VERSION,
  SHADOW_MODE_REQUIRED,
} from "../src/governance/preProduction.js";

const gateRegisterUrl = new URL(
  "../governance/pre-production-gates.json",
  import.meta.url,
);

interface GateRegister {
  version: string;
  liveProductionApproved: boolean;
  shadowModeRequired: boolean;
  gates: Array<{
    id: string;
    status: string;
    evidence: Record<string, unknown>;
    blockers: string[];
  }>;
}

test("the machine register records the verified Stage 2 gate", async () => {
  const register = JSON.parse(
    await readFile(gateRegisterUrl, "utf8"),
  ) as GateRegister;
  const stageTwo = register.gates.find(
    (gate) => gate.id === "stage_2_knowledge_and_action_authority",
  );

  assert.equal(register.version, PRE_PRODUCTION_GATE_REGISTER_VERSION);
  assert.equal(register.liveProductionApproved, false);
  assert.equal(register.shadowModeRequired, true);
  assert.equal(stageTwo?.status, "passed");
  assert.deepEqual(stageTwo?.blockers, []);
  assert.equal(stageTwo?.evidence.approvedActionContracts, 25);
  assert.equal(stageTwo?.evidence.canonicalClaims, 9);
  assert.equal(
    stageTwo?.evidence.mergeCommit,
    "709a83bf0c5cde8d08a11ef0d9528916b942b836",
  );
  assert.equal(
    stageTwo?.evidence.mergedPreviewDeploymentState,
    "READY",
  );
  assert.equal(stageTwo?.evidence.providerSendAttempted, false);
  assert.equal(stageTwo?.evidence.productionTouched, false);
  assert.ok(
    PASSED_PRE_PRODUCTION_GATES.includes(
      "stage_2_knowledge_and_action_authority",
    ),
  );
});

test("shadow remains allowed while all live paths fail closed", () => {
  assert.equal(LIVE_PRODUCTION_APPROVED, false);
  assert.equal(SHADOW_MODE_REQUIRED, true);

  assert.equal(
    assessReleaseMode("shadow", undefined, "ENABLE").allowed,
    true,
  );
  assert.equal(
    assessReleaseMode("live", undefined, "ENABLE").reason,
    "live_confirmation_missing_or_incorrect",
  );
  assert.equal(
    assessReleaseMode("live", "ENABLE", "ENABLE").reason,
    "pre_production_certification_incomplete",
  );
});
