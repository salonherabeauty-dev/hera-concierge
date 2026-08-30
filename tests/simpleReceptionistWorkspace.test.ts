import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const indexUrl = new URL("../public/command-centre/index.html", import.meta.url);
const receptionUrl = new URL("../public/command-centre/reception.html", import.meta.url);
const advancedUrl = new URL("../public/command-centre/advanced.html", import.meta.url);
const uiUrl = new URL("../public/command-centre/reset-workspace.js", import.meta.url);
const cssUrl = new URL("../public/command-centre/reset-workspace.css", import.meta.url);
const inboxApiUrl = new URL("../api/command-centre/reset-inbox.ts", import.meta.url);
const stateApiUrl = new URL("../api/command-centre/reset-state.ts", import.meta.url);
const messageApiUrl = new URL("../api/command-centre/reset-message.ts", import.meta.url);
const regenerateApiUrl = new URL("../api/command-centre/reset-regenerate.ts", import.meta.url);
const manualApiUrl = new URL("../api/command-centre/reset-manual.ts", import.meta.url);
const preflightUrl = new URL("../src/reset/sendPreflight.ts", import.meta.url);
const resetRepositoryUrl = new URL("../src/reset/repository.ts", import.meta.url);
const resetMigrationUrls = [
  "20260830000002_receptionist_reset_v1.sql",
  "20260830000003_receptionist_reset_integrity.sql",
  "20260830000004_receptionist_reset_supersession.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));
const vercelUrl = new URL("../vercel.json", import.meta.url);

async function resetSql(): Promise<string> {
  return (await Promise.all(resetMigrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}

test("the default Command Centre is only the simplified reset Reception Desk", async () => {
  const [index, reception, advanced, ui, css] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(receptionUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
    readFile(uiUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  for (const html of [index, reception]) {
    assert.match(html, /hera-receptionist-reset-v1/);
    assert.match(html, /reset-workspace\.css/);
    assert.match(html, /reset-workspace\.js/);
    assert.doesNotMatch(
      html,
      /receptionist-workspace|receptionist-readability|receptionist-emergency-fix|receptionist-live-recovery|receptionist-auto-draft-status|human-delivery-gate|assets\/app\.js/,
    );
  }
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
  assert.doesNotThrow(() => new Function(ui));
  assert.match(css, /grid-template-columns:\s*minmax\(300px, 355px\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.reset-thread[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.reset-conversation-list[\s\S]*overflow-y:\s*auto/);
});

test("front desk exposes one truthful automatic-draft workflow", async () => {
  const ui = await readFile(uiUrl, "utf8");
  assert.match(ui, /AI is preparing this reply automatically/);
  assert.match(ui, /No button press is required/);
  assert.match(ui, /AI draft ready/);
  assert.match(ui, /AI could not prepare this reply/);
  assert.match(ui, /Retry AI Reply/);
  assert.match(ui, /Write Manually/);
  assert.match(ui, /Send to Client/);
  assert.match(ui, /Regenerate/);
  assert.match(ui, /Take Over \/ Hold/);
  assert.match(ui, /Human handling — drafting continues/);
  assert.match(ui, /Edited by human — the exact text above will be sent/);
  assert.match(ui, /Staging ·/);
  assert.match(ui, /POLL_MS = 5_000/);
  assert.match(ui, /\/api\/command-centre\/reset-inbox/);
  assert.match(ui, /\/api\/command-centre\/reset-state/);
  assert.match(ui, /\/api\/command-centre\/reset-message/);
  assert.match(ui, /\/api\/command-centre\/reset-regenerate/);
  assert.match(ui, /\/api\/command-centre\/reset-manual/);
  assert.doesNotMatch(ui, /Create AI Reply|receptionist-draft/);
  assert.doesNotMatch(ui, /Escalate/i);
});

test("complete reset inbox and per-conversation state remain authenticated and bounded", async () => {
  const [inbox, stateApi, repository] = await Promise.all([
    readFile(inboxApiUrl, "utf8"),
    readFile(stateApiUrl, "utf8"),
    readFile(resetRepositoryUrl, "utf8"),
  ]);
  for (const source of [inbox, stateApi]) {
    assert.match(source, /authenticateCommandCentre/);
    assert.match(source, /requireResetReceptionist/);
    assert.match(source, /view_conversations/);
  }
  assert.match(inbox, /Math\.min\(Number\(value\), 300\)/);
  assert.match(inbox, /replyOwed: conversation\.lastMessageDirection === "inbound"/);
  assert.match(inbox, /Date\.parse\(right\.lastMessageAt\) - Date\.parse\(left\.lastMessageAt\)/);
  assert.match(inbox, /VERCEL_GIT_COMMIT_SHA/);
  assert.match(repository, /ai_reset_reconcile_timeouts/);
  assert.match(repository, /ai_reset_client_turns/);
  assert.match(repository, /ai_reset_draft_runs/);
  assert.doesNotMatch(repository, /NEXT_PUBLIC/);
});

test("the only reset provider-send path requires authenticated human approval and a second preflight", async () => {
  const [messageApi, preflight, repository] = await Promise.all([
    readFile(messageApiUrl, "utf8"),
    readFile(preflightUrl, "utf8"),
    readFile(resetRepositoryUrl, "utf8"),
  ]);
  assert.match(messageApi, /authenticateCommandCentre/);
  assert.match(messageApi, /requireSameOrigin/);
  assert.match(messageApi, /requireCommandCentreCsrf/);
  assert.match(messageApi, /approve_delivery/);
  assert.match(messageApi, /reserveHumanSend/);
  assert.match(messageApi, /preflights\.preflight/);
  assert.match(messageApi, /D360WhatsAppClient/);
  assert.match(messageApi, /whatsapp\.sendText/);
  assert.match(messageApi, /sent_pending_audit_reconciliation/);
  assert.doesNotMatch(messageApi, /MetaWhatsAppClient|drainOutbox|Timely/i);
  assert.match(preflight, /ai_reset_preflight_human_send/);
  assert.match(repository, /ai_reset_reserve_human_send/);
  assert.match(repository, /ai_reset_complete_human_send/);
  assert.match(repository, /ai_reset_fail_human_send/);
});

test("regeneration and manual fallback never send WhatsApp themselves", async () => {
  const [regenerate, manual] = await Promise.all([
    readFile(regenerateApiUrl, "utf8"),
    readFile(manualApiUrl, "utf8"),
  ]);
  assert.match(regenerate, /requestRegeneration/);
  assert.match(regenerate, /waitUntil\(drainResetDrafts/);
  assert.match(regenerate, /automaticDeliveryAllowed: false/);
  assert.match(manual, /createManualCandidate/);
  assert.match(manual, /origin: "human_manual"/);
  for (const source of [regenerate, manual]) {
    assert.doesNotMatch(source, /sendText|D360WhatsAppClient|MetaWhatsAppClient|Timely/i);
  }
});

test("reset database makes silent terminal jobs and duplicate sends structurally impossible", async () => {
  const sql = await resetSql();
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_reset_client_turns/);
  assert.match(sql, /ai_reset_draft_runs/);
  assert.match(sql, /ai_reset_human_sends/);
  assert.match(sql, /model_calls between 0 and 2/i);
  assert.match(sql, /status in \('ready', 'held', 'sent'\)[\s\S]*candidate_text is not null[\s\S]*candidate_hash is not null/i);
  assert.match(sql, /status = 'failed'[\s\S]*failure_code is not null[\s\S]*failure_message is not null/i);
  assert.match(sql, /ai_reset_one_active_draft_per_turn/);
  assert.match(sql, /unique \(draft_run_id\)/i);
  assert.match(sql, /ai_reset_preflight_human_send/);
  assert.match(sql, /human_reply_already_recorded/);
  assert.match(sql, /customer_service_window_expired/);
  assert.match(sql, /recipient_mismatch/);
  assert.match(sql, /newer_client_turn/);
  assert.match(sql, /human send is already reserved and requires reconciliation/i);
  assert.match(sql, /automaticDeliveryAllowed', false/i);
  assert.match(sql, /delivery_control text not null default 'human_only'/i);
});

test("Vercel bounds reset processing while deployment builds remain pure", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    buildCommand?: string;
    functions?: Record<string, { maxDuration?: number | string }>;
  };
  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.functions?.["api/whatsapp/*.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/internal/drain.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/command-centre/reset-regenerate.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/command-centre/reset-message.ts"]?.maxDuration, 60);
});
