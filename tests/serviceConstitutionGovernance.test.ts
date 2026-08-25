import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const constitutionUrl = new URL(
  "../governance/hera-service-constitution.draft.json",
  import.meta.url,
);
const gateRegisterUrl = new URL(
  "../governance/pre-production-gates.json",
  import.meta.url,
);

type Constitution = {
  status: string;
  effectiveDate: string | null;
  approvedBy: string | null;
  approvalRecordedAt: string | null;
  liveUseAllowed: boolean;
  confirmedPolicies: Array<{
    id: string;
    rule: string;
    aiAuthority: string;
    source: string;
  }>;
  authorityMatrix: Array<{
    action: string;
    authority: string;
    confirmationRequired: boolean;
  }>;
  unresolvedPolicies: Array<{
    id: string;
    launchBlocker: boolean;
    question: string;
    safeInterimBehaviour: string;
    source: string;
  }>;
};

type GateRegister = {
  liveProductionApproved: boolean;
  shadowModeRequired: boolean;
  gates: Array<{
    id: string;
    status: string;
    requiredForLive: boolean;
    blockers: string[];
  }>;
};

async function loadJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

test("draft constitution is explicitly blocked from runtime authority", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);

  assert.equal(constitution.status, "draft_not_runtime_authoritative");
  assert.equal(constitution.liveUseAllowed, false);
  assert.equal(constitution.effectiveDate, null);
  assert.equal(constitution.approvedBy, null);
  assert.equal(constitution.approvalRecordedAt, null);
  assert.ok(constitution.unresolvedPolicies.length > 0);
  assert.ok(
    constitution.unresolvedPolicies.every(
      (policy) =>
        policy.launchBlocker &&
        policy.question.trim().length > 0 &&
        policy.safeInterimBehaviour.trim().length > 0 &&
        policy.source.trim().length > 0,
    ),
  );
});

test("every confirmed policy is sourced and authority-bounded", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);

  assert.ok(constitution.confirmedPolicies.length >= 6);
  for (const policy of constitution.confirmedPolicies) {
    assert.ok(policy.id.trim().length > 0);
    assert.ok(policy.rule.trim().length > 0);
    assert.ok(policy.aiAuthority.trim().length > 0);
    assert.match(policy.source, /^docs\//);
  }
});

test("transactional, financial, medical and legal actions are not broadly delegated to AI", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);
  const matrix = new Map(
    constitution.authorityMatrix.map((item) => [item.action, item]),
  );

  for (const action of [
    "create_confirm_reschedule_or_cancel_booking",
    "quote_live_availability",
    "apply_refund_discount_compensation_or_free_service",
    "admit_liability_or_diagnose_damage_or_medical_condition",
    "complete_privacy_deletion_or_legal_determination",
  ]) {
    const item = matrix.get(action);
    assert.ok(item, `missing authority rule for ${action}`);
    assert.equal(item.confirmationRequired, true);
    assert.doesNotMatch(item.authority, /^ai_allowed/);
  }
});

test("the gate register keeps live production locked while any required gate is incomplete", async () => {
  const register = await loadJson<GateRegister>(gateRegisterUrl);
  const incompleteRequired = register.gates.filter(
    (gate) => gate.requiredForLive && gate.status !== "passed",
  );

  assert.equal(register.liveProductionApproved, false);
  assert.equal(register.shadowModeRequired, true);
  assert.ok(incompleteRequired.length > 0);
  assert.ok(
    incompleteRequired.every(
      (gate) => gate.blockers.length > 0 || gate.status === "locked",
    ),
  );
  assert.equal(
    register.gates.find((gate) => gate.id === "stage_0_baseline_lock")?.status,
    "passed",
  );
  assert.equal(
    register.gates.find((gate) => gate.id === "stage_1_service_constitution")?.status,
    "in_progress",
  );
});
