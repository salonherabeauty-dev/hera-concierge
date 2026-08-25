import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260825000001_certify_knowledge_action_authority.sql",
  import.meta.url,
);
const contractsUrl = new URL(
  "../governance/action-authority-contracts.json",
  import.meta.url,
);
const claimsUrl = new URL(
  "../governance/knowledge-authority-catalog.json",
  import.meta.url,
);

test("Stage 2 migration creates service-role-only authority registries", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /create table if not exists public\.ai_action_authority_contracts/i);
  assert.match(sql, /create table if not exists public\.ai_knowledge_claim_registry/i);
  assert.match(sql, /force row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_action_authority_contracts from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on table public\.ai_knowledge_claim_registry from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant select, insert, update, delete on table public\.ai_action_authority_contracts to service_role/i,
  );
  assert.match(sql, /ai_get_action_authority_contract/i);
  assert.match(sql, /ai_stage2_authority_health/i);
  assert.match(sql, /unknown|prohibited|human_required/i);
});

test("machine action catalogue and database migration remain in exact action-key coverage", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const catalogue = JSON.parse(await readFile(contractsUrl, "utf8")) as {
    contracts: Array<{ actionKey: string }>;
  };

  assert.ok(catalogue.contracts.length >= 24);
  for (const contract of catalogue.contracts) {
    assert.match(sql, new RegExp(`'${contract.actionKey}'`));
  }
});

test("canonical knowledge claims are persisted with the approved constitution authority", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const catalogue = JSON.parse(await readFile(claimsUrl, "utf8")) as {
    constitutionVersion: string;
    canonicalClaims: Array<{ claimKey: string }>;
  };

  assert.ok(catalogue.canonicalClaims.length >= 9);
  assert.match(sql, new RegExp(catalogue.constitutionVersion));
  for (const claim of catalogue.canonicalClaims) {
    assert.match(sql, new RegExp(`'${claim.claimKey}'`));
  }
  assert.match(sql, /approved_legacy_window_conflicts/i);
  assert.match(sql, /lower\(body\) like '%7 working days%'/i);
});

test("external mutation contracts require full transaction controls", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(sql, /not external_mutation[\s\S]*idempotency_required[\s\S]*provider_confirmation_required[\s\S]*before_after_audit_required[\s\S]*reconciliation_required/i);
  for (const action of [
    "approve_refund",
    "approve_voucher",
    "approve_compensation",
    "send_ai_generated_whatsapp_reply",
  ]) {
    const start = sql.indexOf(`'${action}'`);
    assert.ok(start >= 0, `missing ${action}`);
    const window = sql.slice(start, start + 1800);
    assert.match(window, /true, true, true, true, true, 'approved'/i);
  }
});
