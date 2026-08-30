import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const migrationUrl = new URL(
  "../supabase/migrations/20260829000013_enable_human_review_shadow_drafting.sql",
  import.meta.url,
);
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const previewIngestUrl = new URL(
  "../src/db/previewHumanReviewIngest.ts",
  import.meta.url,
);
const draftApiUrl = new URL(
  "../api/command-centre/receptionist-draft.ts",
  import.meta.url,
);
const draftRepositoryUrl = new URL(
  "../src/command-centre/receptionistDraftRepository.ts",
  import.meta.url,
);
const conversationApiUrl = new URL(
  "../api/command-centre/conversations.ts",
  import.meta.url,
);
const patchCssUrl = new URL(
  "../public/command-centre/receptionist-emergency-fix.css",
  import.meta.url,
);
const patchJsUrl = new URL(
  "../public/command-centre/receptionist-emergency-fix.js",
  import.meta.url,
);
const legacyReceptionUrl = new URL(
  "../public/command-centre/reception.html",
  import.meta.url,
);
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("human handling preserves control while Preview still creates a shadow AI draft", async () => {
  const [migration, webhook, previewIngest] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(webhookUrl, "utf8"),
    readFile(previewIngestUrl, "utf8"),
  ]);

  assert.doesNotThrow(() => parse(migration));
  assert.match(migration, /ai_ingest_whatsapp_message_human_review/i);
  assert.match(migration, /public\.ai_ingest_whatsapp_message\(/i);
  assert.match(migration, /humanReviewOnly/i);
  assert.match(migration, /automaticDeliveryAllowed', false/i);
  assert.match(migration, /p_kind not in \('reaction', 'system'\)/i);
  assert.match(migration, /to service_role/i);

  assert.match(webhook, /usePreviewHumanReviewIngest/);
  assert.match(webhook, /ingestPreviewHumanReviewMessage/);
  assert.match(webhook, /humanReviewDrafting/);
  assert.match(previewIngest, /VERCEL_ENV === "preview"/);
  assert.match(previewIngest, /HERA_INTERNAL_PILOT_BRANCH/);
  assert.match(previewIngest, /WHATSAPP_SEND_MODE === "shadow"/);
  assert.match(previewIngest, /ai_ingest_whatsapp_message_human_review/);
  assert.doesNotMatch(previewIngest, /sendText|D360_API_KEY/);
});

test("Create AI Reply is atomic, latest-message-bound and cannot send by itself", async () => {
  const [migration, endpoint, repository] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(draftApiUrl, "utf8"),
    readFile(draftRepositoryUrl, "utf8"),
  ]);

  assert.match(migration, /ai_cc_request_receptionist_draft/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /source_message_not_latest/i);
  assert.match(migration, /customer_service_window_expired/i);
  assert.match(migration, /human_reply_already_recorded/i);
  assert.match(migration, /recipient_mismatch/i);
  assert.match(migration, /front-desk-draft:/i);
  assert.match(migration, /max_attempts[\s\S]*1/i);

  assert.match(endpoint, /authenticateCommandCentre/);
  assert.match(endpoint, /requireSameOrigin/);
  assert.match(endpoint, /requireCommandCentreCsrf/);
  assert.match(endpoint, /requireReceptionistWorkspacePreview/);
  assert.match(endpoint, /runtime\.sendMode !== "shadow"/);
  assert.match(endpoint, /waitUntil/);
  assert.match(endpoint, /drainReceptionistForJobs/);
  assert.match(endpoint, /draft_ready/);
  assert.match(endpoint, /draft_pending/);
  assert.doesNotMatch(endpoint, /sendText|D360WhatsAppClient|Timely/i);
  assert.match(repository, /ai_cc_request_receptionist_draft/);
});

test("front desk panes are bounded and independently scrollable", async () => {
  const css = await readFile(patchCssUrl, "utf8");
  assert.match(css, /\.fd-shell[\s\S]*height:\s*100dvh/i);
  assert.match(css, /\.fd-layout[\s\S]*min-height:\s*0/i);
  assert.match(css, /\.fd-thread[\s\S]*overflow-y:\s*auto/i);
  assert.match(css, /\.fd-conversation-list[\s\S]*overflow-y:\s*auto/i);
  assert.match(css, /scrollbar-gutter:\s*stable/i);
  assert.match(css, /touch-action:\s*pan-y/i);
  assert.match(css, /\.fd-tabs[\s\S]*display:\s*grid/i);
  assert.match(css, /\.fd-tab:last-child[\s\S]*grid-column:\s*1 \/ -1/i);
});

test("the explicit legacy front desk preserves its Create AI Reply recovery and reading position", async () => {
  const [script, reception] = await Promise.all([
    readFile(patchJsUrl, "utf8"),
    readFile(legacyReceptionUrl, "utf8"),
  ]);

  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /Create AI Reply/);
  assert.match(script, /receptionist-draft/);
  assert.match(script, /scrollMemory/);
  assert.match(script, /Newest message/);
  assert.match(script, /sourceMessageId: latest\.id/);
  assert.match(script, /Reply window closed/);
  assert.doesNotMatch(script, /sendText|D360_API_KEY|Timely/i);
  assert.match(reception, /receptionist-emergency-fix\.css/);
  assert.match(reception, /receptionist-emergency-fix\.js/);
  assert.ok(
    reception.indexOf("receptionist-workspace.js") <
      reception.indexOf("receptionist-emergency-fix.js"),
  );
});

test("expired timed takeovers no longer mislabel ordinary conversations as held", async () => {
  const source = await readFile(conversationApiUrl, "utf8");
  assert.match(source, /normalizeExpiredHumanHandling/);
  assert.match(source, /humanTakeoverUntil/);
  assert.match(source, /operatingMode: "ai"/);
});

test("Vercel grants the plan maximum execution time to Sol Max drafting", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    functions?: Record<string, { maxDuration?: number | string }>;
  };
  assert.equal(
    config.functions?.["api/command-centre/receptionist-draft.ts"]?.maxDuration,
    "max",
  );
  assert.equal(
    config.functions?.["api/command-centre/receptionist-regenerate.ts"]?.maxDuration,
    "max",
  );
  assert.equal(config.functions?.["api/whatsapp/*.ts"]?.maxDuration, "max");
  assert.equal(config.functions?.["api/internal/drain.ts"]?.maxDuration, "max");
});
