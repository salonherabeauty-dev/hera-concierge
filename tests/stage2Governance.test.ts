import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const repoFile = (path: string) => new URL(`../${path}`, import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(repoFile(path), "utf8");
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await text(path)) as T;
}

test("runtime knowledge excludes the superseded seven-working-day policy", async () => {
  const [concierge, search, constitution] = await Promise.all([
    text("api/concierge.js"),
    text("src/knowledge/search.ts"),
    text("governance/hera-service-constitution.json"),
  ]);

  assert.doesNotMatch(concierge, /7\s+working\s+days?/i);
  assert.doesNotMatch(search, /7\s+working\s+days?/i);
  assert.doesNotMatch(constitution, /7\s+working\s+days?/i);
  assert.match(concierge, /7 calendar days from completion of the appointment/i);
  assert.match(search, /seven calendar days from completion of the appointment/i);
});

test("dynamic knowledge retrieval is approved, effective and unexpired only", async () => {
  const migration = await text(
    "supabase/migrations/20260821000000_create_hera_ai_receptionist.sql",
  );
  const functionStart = migration.indexOf(
    "create or replace function public.ai_search_knowledge",
  );
  assert.ok(functionStart >= 0);
  const functionText = migration.slice(functionStart, functionStart + 5000);

  assert.match(functionText, /document\.status = 'approved'/);
  assert.match(
    functionText,
    /document\.valid_from is null or document\.valid_from <= now\(\)/,
  );
  assert.match(
    functionText,
    /document\.valid_until is null or document\.valid_until > now\(\)/,
  );
});

test("the model has no booking, availability, financial, consent or privacy write tool", async () => {
  const receptionist = await text("src/ai/receptionist.ts");

  for (const forbiddenTool of [
    "create_booking",
    "reschedule_booking",
    "cancel_booking",
    "confirm_live_availability",
    "issue_refund",
    "apply_discount",
    "approve_compensation",
    "record_media_consent",
    "withdraw_media_consent",
    "delete_client_data",
  ]) {
    assert.doesNotMatch(
      receptionist,
      new RegExp(`\\b${forbiddenTool}\\s*:\\s*tool\\s*\\(`),
      forbiddenTool,
    );
  }

  assert.match(receptionist, /lookup_current_client_booking\s*:\s*tool\s*\(/);
  assert.match(receptionist, /get_hera_digital_tools\s*:\s*tool\s*\(/);
  assert.match(receptionist, /calculate_gst\s*:\s*tool\s*\(/);
});

test("the exact final reply and dead-letter fallback are action-authority gated", async () => {
  const worker = await text("src/worker.ts");

  assert.match(worker, /const draftActionAuthority = assessActionAuthority/);
  assert.match(worker, /const finalActionAuthority = assessActionAuthority/);
  assert.match(
    worker,
    /const deliveryEligible =\s*finalQuality\.passed &&\s*finalVerification\.approved &&\s*finalActionAuthority\.passed;/,
  );
  assert.match(worker, /fallbackActionAuthority = assessActionAuthority/);
  assert.match(worker, /actionAuthorityPolicyVersion/);
  assert.match(worker, /actionAuthorityIssues/);
});

test("live mode is locked by certification independently of the environment switches", async () => {
  const [config, release] = await Promise.all([
    text("src/config.ts"),
    text("src/governance/preProduction.ts"),
  ]);

  assert.match(config, /PRE_PRODUCTION_CERTIFICATION/);
  assert.match(release, /LIVE_PRODUCTION_APPROVED = false/);
  assert.match(release, /SHADOW_MODE_REQUIRED = true/);
  assert.match(release, /pre_production_certification_incomplete/);
});

test("knowledge and action registries are complete, versioned and release-locked", async () => {
  const knowledge = await json<{
    version: string;
    approvedConstitutionVersion: string;
    sourceClasses: Array<{ id: string; authorityRank: number }>;
    supersededClaims: Array<{ id: string; runtimeDisposition: string }>;
    controlledDiscrepancies: Array<{
      id: string;
      automaticResolution: string;
    }>;
  }>("governance/knowledge-source-registry.json");
  const authority = await json<{
    version: string;
    approvedConstitutionVersion: string;
    actions: Array<{
      id: string;
      authorityClass: string;
      runtimeStatus: string;
      requiredEvidence: string[];
      auditRequirement: string;
    }>;
    releaseDeclaration: {
      liveProductionApproved: boolean;
      shadowModeRequired: boolean;
    };
  }>("governance/action-authority-registry.json");

  assert.match(knowledge.version, /^hera-knowledge-source-registry-/);
  assert.match(authority.version, /^hera-action-authority-registry-/);
  assert.equal(
    knowledge.approvedConstitutionVersion,
    "hera-service-constitution-2026-08-25.1",
  );
  assert.equal(
    authority.approvedConstitutionVersion,
    "hera-service-constitution-2026-08-25.1",
  );
  assert.ok(knowledge.sourceClasses.length >= 9);
  assert.ok(
    knowledge.supersededClaims.some(
      (claim) =>
        claim.id === "seven_working_day_concern_window" &&
        claim.runtimeDisposition === "exclude",
    ),
  );
  assert.ok(
    knowledge.controlledDiscrepancies.some(
      (item) =>
        item.id === "nanosmooth_price_references" &&
        item.automaticResolution === "prohibited",
    ),
  );

  const actionIds = new Set(authority.actions.map((action) => action.id));
  for (const required of [
    "answer_grounded_hera_information",
    "read_current_client_booking_record",
    "create_human_action_task",
    "create_booking",
    "reschedule_booking",
    "cancel_booking",
    "confirm_live_availability",
    "approve_refund_voucher_or_compensation",
    "confirm_capture_consent",
    "confirm_publication_consent",
    "complete_consent_withdrawal",
    "complete_privacy_deletion_or_legal_determination",
    "admit_liability",
    "diagnose_medical_condition_or_chemical_damage",
    "send_ai_generated_client_reply",
  ]) {
    assert.ok(actionIds.has(required), required);
  }
  assert.ok(
    authority.actions.every(
      (action) =>
        action.authorityClass.trim().length > 0 &&
        action.runtimeStatus.trim().length > 0 &&
        action.requiredEvidence.length > 0 &&
        action.auditRequirement.trim().length > 0,
    ),
  );
  assert.equal(authority.releaseDeclaration.liveProductionApproved, false);
  assert.equal(authority.releaseDeclaration.shadowModeRequired, true);
});

test("no one-time Stage 2 workflow or runtime audit tool remains", async () => {
  const workflows = await readdir(repoFile(".github/workflows/"));
  const tools = await readdir(repoFile("tools/")).catch(() => [] as string[]);

  assert.equal(
    workflows.some((name) => /stage2|stage-2|apply-stage2/i.test(name)),
    false,
  );
  assert.equal(
    tools.some((name) => /stage2|stage-2|knowledge-authority-audit/i.test(name)),
    false,
  );
});
