import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrls = [
  "20260829000000_prepare_human_delivery_reviews.sql",
  "20260829000001_human_delivery_review_queue.sql",
  "20260829000002_human_delivery_reserve.sql",
  "20260829000003_human_delivery_preflight_completion.sql",
  "20260829000004_human_delivery_reject_escalate.sql",
  "20260829000005_human_delivery_function_permissions.sql",
].map((name) =>
  new URL(`../supabase/migrations/${name}`, import.meta.url),
);

async function migrationSql(): Promise<string> {
  return (await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}
const apiUrl = new URL(
  "../api/command-centre/human-delivery.ts",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/command-centre/humanDeliveryRepository.ts",
  import.meta.url,
);
const permissionsUrl = new URL(
  "../src/command-centre/permissions.ts",
  import.meta.url,
);
const validationUrl = new URL(
  "../src/command-centre/validation.ts",
  import.meta.url,
);
const uiUrl = new URL(
  "../public/command-centre/human-delivery-gate.js",
  import.meta.url,
);
const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);

test("PostgreSQL accepts the human-approved delivery migration", async () => {
  const sql = await migrationSql();
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_human_delivery_reviews/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_human_delivery_reviews[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /grant select, insert, update[\s\S]*to service_role/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.ai_cc_reserve_human_delivery_send/i,
  );
  assert.match(sql, /to service_role/i);
});

test("database approval is exact, latest, recipient-matched and duplicate-safe", async () => {
  const sql = await migrationSql();
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /candidate_response_hash/i);
  assert.match(sql, /candidate_hash_changed/i);
  assert.match(sql, /recipient_mismatch/i);
  assert.match(sql, /recipient_display_changed/i);
  assert.match(sql, /candidate_not_latest/i);
  assert.match(sql, /human_reply_already_recorded/i);
  assert.match(sql, /candidate_already_reviewed/i);
  assert.match(sql, /unique[\s\S]*candidate_outbox_id/i);
  assert.match(sql, /unique[\s\S]*source_message_id/i);
  assert.match(sql, /human-approved:/i);
  assert.match(sql, /status = 'processing'/i);
  assert.match(sql, /send_authorization[\s\S]*'management'/i);
  assert.match(sql, /max_attempts[\s\S]*1/i);
});

test("database requires quality evidence and preserves role authority", async () => {
  const sql = await migrationSql();
  assert.match(sql, /quality_evidence_missing/i);
  assert.match(sql, /quality_evidence_failed/i);
  assert.match(sql, /finalQuality/i);
  assert.match(sql, /finalVerification/i);
  assert.match(sql, /deliveryEligible/i);
  assert.match(sql, /risk_requires_specialist/i);
  assert.match(sql, /role_not_authorized_for_open_task/i);
  assert.match(sql, /technical_review/i);
  assert.match(sql, /refund_finance/i);
  assert.match(sql, /privacy_legal/i);
});

test("database implements approve, reject, escalation and named audit evidence", async () => {
  const sql = await migrationSql();
  assert.match(sql, /ai_cc_reserve_human_delivery_send/i);
  assert.match(sql, /ai_cc_preflight_human_delivery_send/i);
  assert.match(sql, /ai_cc_complete_human_delivery_send/i);
  assert.match(sql, /ai_cc_fail_human_delivery_send/i);
  assert.match(sql, /ai_cc_reject_human_delivery_candidate/i);
  assert.match(sql, /ai_cc_escalate_human_delivery_candidate/i);
  assert.match(sql, /reviewer_user_id/i);
  assert.match(sql, /reviewer_role/i);
  assert.match(sql, /human_delivery_send_reserved/i);
  assert.match(sql, /human_delivery_sent/i);
  assert.match(sql, /human_delivery_rejected/i);
  assert.match(sql, /human_delivery_escalated/i);
  assert.match(sql, /ai_handoff_tasks/i);
  assert.match(sql, /ai_cc_set_conversation_mode/i);
});

test("API is authenticated, same-origin, CSRF protected and Preview-only", async () => {
  const source = await readFile(apiUrl, "utf8");
  assert.match(source, /authenticateCommandCentre/);
  assert.match(source, /requireSameOrigin/);
  assert.match(source, /requireCommandCentreCsrf/);
  assert.match(source, /VERCEL_ENV === "preview"/);
  assert.match(source, /branch !== "main"/);
  assert.match(source, /HERA_INTERNAL_PILOT_BRANCH/);
  assert.match(source, /WHATSAPP_SEND_MODE === "shadow"/);
  assert.match(source, /WHATSAPP_LIVE_CONFIRMATION/);
  assert.match(source, /getWhatsAppProviderConfig/);
  assert.match(source, /360dialog/);
  assert.doesNotMatch(source, /process\.env\.[A-Z0-9_]+\s*=/);
  assert.doesNotMatch(source, /Timely/i);
});

test("API sends only after atomic reservation and second preflight", async () => {
  const source = await readFile(apiUrl, "utf8");
  const reserve = source.indexOf("reserveApproval");
  const preflight = source.indexOf("repository.preflight");
  const send = source.indexOf("whatsapp.sendText");
  const complete = source.indexOf("completeWithOneRetry");
  assert.ok(reserve >= 0);
  assert.ok(preflight > reserve);
  assert.ok(send > preflight);
  assert.ok(complete > send);
  assert.match(source, /D360WhatsAppClient/);
  assert.match(source, /expectedSourceMessageId/);
  assert.match(source, /expectedResponseHash/);
  assert.match(source, /expectedPhoneEnding/);
  assert.match(source, /repository\.fail/);
  assert.match(source, /sent_pending_audit_reconciliation/);
  assert.doesNotMatch(source, /drainReceptionist/);
  assert.doesNotMatch(source, /authorizeInternalPilot/);
});

test("repository exposes only server-side RPC operations", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /getDatabaseConfig/);
  assert.match(source, /serviceRoleKey/);
  assert.match(source, /ai_cc_list_human_delivery_queue/);
  assert.match(source, /ai_cc_reserve_human_delivery_send/);
  assert.match(source, /ai_cc_preflight_human_delivery_send/);
  assert.match(source, /ai_cc_complete_human_delivery_send/);
  assert.match(source, /ai_cc_fail_human_delivery_send/);
  assert.match(source, /ai_cc_reject_human_delivery_candidate/);
  assert.match(source, /ai_cc_escalate_human_delivery_candidate/);
  assert.doesNotMatch(source, /NEXT_PUBLIC/);
});

test("role and request contracts include supervised delivery controls", async () => {
  const [permissions, validation] = await Promise.all([
    readFile(permissionsUrl, "utf8"),
    readFile(validationUrl, "utf8"),
  ]);
  for (const capability of [
    "review_delivery",
    "approve_delivery",
    "reject_delivery",
    "escalate_delivery",
  ]) {
    assert.match(permissions, new RegExp(capability));
  }
  assert.match(
    permissions,
    /receptionist:[\s\S]*"approve_delivery"[\s\S]*"reject_delivery"[\s\S]*"escalate_delivery"/,
  );
  assert.match(validation, /humanDeliveryActionBodySchema/);
  assert.match(validation, /expectedSourceMessageId/);
  assert.match(validation, /expectedResponseHash/);
  assert.match(validation, /expectedPhoneEnding/);
  assert.match(validation, /action: z\.literal\("approve"\)/);
  assert.match(validation, /action: z\.literal\("reject"\)/);
  assert.match(validation, /action: z\.literal\("escalate"\)/);
});

test("Command Centre presents exact approve, reject and escalation actions", async () => {
  const [ui, index] = await Promise.all([
    readFile(uiUrl, "utf8"),
    readFile(indexUrl, "utf8"),
  ]);
  assert.doesNotThrow(() => new Function(ui));
  assert.match(index, /human-delivery-gate\.css/);
  assert.match(index, /human-delivery-gate\.js/);
  assert.match(ui, /Review AI replies/);
  assert.match(ui, /Approve & Send/);
  assert.match(ui, /Reject & Take Over/);
  assert.match(ui, /Escalate/);
  assert.match(ui, /expectedSourceMessageId/);
  assert.match(ui, /expectedResponseHash/);
  assert.match(ui, /expectedPhoneEnding/);
  assert.match(ui, /Nothing is sent automatically/);
  assert.match(ui, /exact displayed AI reply/);
  assert.doesNotMatch(ui, /contenteditable/i);
  assert.doesNotMatch(ui, /D360-API-KEY/i);
  assert.doesNotMatch(ui, /waba-v2\.360dialog\.io/i);
});
