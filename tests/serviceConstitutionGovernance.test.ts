import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const constitutionUrl = new URL(
  "../governance/hera-service-constitution.json",
  import.meta.url,
);
const draftConstitutionUrl = new URL(
  "../governance/hera-service-constitution.draft.json",
  import.meta.url,
);
const gateRegisterUrl = new URL(
  "../governance/pre-production-gates.json",
  import.meta.url,
);
const migrationUrl = new URL(
  "../supabase/migrations/20260825000000_approve_hera_service_constitution.sql",
  import.meta.url,
);

type Constitution = {
  version: string;
  status: string;
  effectiveDate: string;
  approvedBy: {
    name: string;
    role: string;
    approvalMethod: string;
  };
  approvalRecordedAt: string;
  runtimeAuthoritative: boolean;
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
    authorisedRoles?: string[];
  }>;
  resolvedOwnerDecisions: Array<{
    id: string;
    decision: string;
    approvedAt: string;
  }>;
  unresolvedPolicies: unknown[];
};

type GateRegister = {
  liveProductionApproved: boolean;
  shadowModeRequired: boolean;
  gates: Array<{
    id: string;
    status: string;
    requiredForLive: boolean;
    evidence: Record<string, unknown>;
    blockers: string[];
  }>;
};

async function loadJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

test("the approved constitution has complete owner authority and no unresolved policy", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);

  assert.equal(constitution.version, "hera-service-constitution-2026-08-25.1");
  assert.equal(constitution.status, "approved_runtime_authoritative");
  assert.equal(constitution.effectiveDate, "2026-08-25");
  assert.equal(constitution.approvedBy.name, "Neo Chin Chuan");
  assert.equal(constitution.approvedBy.role, "Owner");
  assert.equal(
    constitution.approvedBy.approvalMethod,
    "explicit_owner_approval_in_project_conversation",
  );
  assert.equal(
    constitution.approvalRecordedAt,
    "2026-08-25T21:38:30+08:00",
  );
  assert.equal(constitution.runtimeAuthoritative, true);
  assert.equal(constitution.liveUseAllowed, false);
  assert.deepEqual(constitution.unresolvedPolicies, []);
  assert.deepEqual(
    new Set(constitution.resolvedOwnerDecisions.map((item) => item.id)),
    new Set([
      "service_concern_and_refinement_window",
      "refinement_remedy_scope",
      "refinement_exception_authority",
      "booking_write_authority",
      "financial_authority_thresholds",
      "photo_video_consent_proof",
    ]),
  );
});

test("the superseded draft cannot remain as an alternative authority", async () => {
  await assert.rejects(access(draftConstitutionUrl));
});

test("every confirmed policy is sourced and authority-bounded", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);

  assert.ok(constitution.confirmedPolicies.length >= 12);
  for (const policy of constitution.confirmedPolicies) {
    assert.ok(policy.id.trim().length > 0);
    assert.ok(policy.rule.trim().length > 0);
    assert.ok(policy.aiAuthority.trim().length > 0);
    assert.match(policy.source, /^docs\//);
  }

  const policies = new Map(
    constitution.confirmedPolicies.map((policy) => [policy.id, policy.rule]),
  );
  assert.match(
    policies.get("service_concern_refinement_window") ?? "",
    /seven calendar days from completion of the appointment/i,
  );
  assert.match(
    policies.get("complimentary_refinement_scope") ?? "",
    /salon manager confirms.*original service.*corrected safely/i,
  );
  assert.match(
    policies.get("timely_booking_authority") ?? "",
    /Timely remains the booking source of truth/i,
  );
  assert.match(
    policies.get("financial_authority") ?? "",
    /AI and receptionist have no refund or compensation authority/i,
  );
  assert.match(
    policies.get("photo_video_consent") ?? "",
    /Separate explicit consent is required.*capturing.*publishing/is,
  );
});

test("transactional, financial, medical and legal actions are not broadly delegated to AI", async () => {
  const constitution = await loadJson<Constitution>(constitutionUrl);
  const matrix = new Map(
    constitution.authorityMatrix.map((item) => [item.action, item]),
  );

  for (const action of [
    "create_confirm_reschedule_or_cancel_booking",
    "quote_live_availability",
    "authorise_policy_based_complimentary_refinement",
    "approve_refund_voucher_compensation_or_outside_policy_exception",
    "admit_liability_or_diagnose_damage_or_medical_condition",
    "complete_privacy_deletion_or_legal_determination",
    "verify_photo_video_consent_or_withdrawal",
  ]) {
    const item = matrix.get(action);
    assert.ok(item, `missing authority rule for ${action}`);
    assert.equal(item.confirmationRequired, true);
    assert.doesNotMatch(item.authority, /^ai_allowed/);
  }

  assert.deepEqual(
    matrix.get("authorise_policy_based_complimentary_refinement")
      ?.authorisedRoles,
    ["salon_manager"],
  );
  assert.deepEqual(
    matrix.get("approve_refund_voucher_compensation_or_outside_policy_exception")
      ?.authorisedRoles,
    ["managing_director", "owner"],
  );
});

test("the constitution is loaded through an idempotent approved knowledge migration", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /hera-service-constitution-2026-08-25\.1/);
  assert.match(migration, /status\s*=\s*'approved'|\b'approved'\b/i);
  assert.match(migration, /on conflict \(document_key\) do update/i);
  assert.match(migration, /a71e2cab56b9668542917bc1e2d495e27ae134129769ae2ebdefb3c642125555/);
  assert.match(migration, /service_constitution_approved/i);
});

test("the gate register passes Stage 1 while keeping live Production locked", async () => {
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
  const stageOne = register.gates.find(
    (gate) => gate.id === "stage_1_service_constitution",
  );
  assert.equal(stageOne?.status, "passed");
  assert.deepEqual(stageOne?.blockers, []);
  assert.equal(
    stageOne?.evidence.approvedVersion,
    "hera-service-constitution-2026-08-25.1",
  );
  assert.equal(stageOne?.evidence.runtimeAuthoritative, true);
  assert.equal(stageOne?.evidence.liveUseAllowed, false);
});
