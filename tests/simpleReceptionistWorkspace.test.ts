import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "libpg-query";

const indexUrl = new URL(
  "../public/command-centre/index.html",
  import.meta.url,
);
const advancedUrl = new URL(
  "../public/command-centre/advanced.html",
  import.meta.url,
);
const uiUrl = new URL(
  "../public/command-centre/receptionist-workspace.js",
  import.meta.url,
);
const cssUrl = new URL(
  "../public/command-centre/receptionist-workspace.css",
  import.meta.url,
);
const queueApiUrl = new URL(
  "../api/command-centre/receptionist-queue.ts",
  import.meta.url,
);
const messageApiUrl = new URL(
  "../api/command-centre/receptionist-message.ts",
  import.meta.url,
);
const regenerateApiUrl = new URL(
  "../api/command-centre/receptionist-regenerate.ts",
  import.meta.url,
);
const conversationsApiUrl = new URL(
  "../api/command-centre/conversations.ts",
  import.meta.url,
);
const clientContextApiUrl = new URL(
  "../api/command-centre/client-context.ts",
  import.meta.url,
);
const frontDeskRepositoryUrl = new URL(
  "../src/command-centre/frontDeskRepository.ts",
  import.meta.url,
);
const repositoryUrl = new URL(
  "../src/command-centre/receptionistWorkspaceRepository.ts",
  import.meta.url,
);
const boundaryUrl = new URL(
  "../src/command-centre/receptionistWorkspaceBoundary.ts",
  import.meta.url,
);
const migrationUrls = [
  "20260829000008_simple_receptionist_schema_queue.sql",
  "20260829000009_simple_receptionist_send_reserve.sql",
  "20260829000010_simple_receptionist_send_completion.sql",
  "20260829000011_simple_receptionist_regeneration.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));

async function migrationSql(): Promise<string> {
  return (await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}
const vercelUrl = new URL("../vercel.json", import.meta.url);

test("the default Command Centre is the professional receptionist workspace", async () => {
  const [index, advanced, ui, css] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(advancedUrl, "utf8"),
    readFile(uiUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.match(index, /Hera Reception/);
  assert.match(index, /receptionist-workspace\.css/);
  assert.match(index, /receptionist-workspace\.js/);
  assert.doesNotMatch(index, /human-delivery-gate\.js/);
  assert.doesNotMatch(index, /assets\/app\.js/);
  assert.match(advanced, /human-delivery-gate\.js/);
  assert.match(advanced, /assets\/app\.js/);
  assert.doesNotThrow(() => new Function(ui));
  assert.match(css, /grid-template-columns:\s*minmax\(292px, 330px\)[\s\S]*minmax\(270px, 310px\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
});

test("front desk sees a complete inbox and the approved working actions", async () => {
  const ui = await readFile(uiUrl, "utf8");
  assert.equal((ui.match(/<textarea/g) ?? []).length, 2);
  assert.match(ui, /Hera Reception Desk/);
  assert.match(ui, /Needs reply/);
  assert.match(ui, /Waiting for client/);
  assert.match(ui, /Answered today/);
  assert.match(ui, /On hold/);
  assert.match(ui, /All conversations/);
  assert.match(ui, /Search client, last 4 digits or message/);
  assert.match(ui, /Reply to client/);
  assert.match(ui, /Send to Client/);
  assert.match(ui, /Regenerate/);
  assert.match(ui, /Take Over \/ Hold/);
  assert.match(ui, /Sent only from Tanglin WhatsApp/);
  assert.match(ui, /messageText: state\.draft/);
  assert.match(ui, /conversations\?limit=300/);
  assert.match(ui, /receptionist-queue\?limit=100/);
  assert.match(ui, /client-context\?id=/);
  assert.match(ui, /Internal notes/);
  assert.match(ui, /action: "add_note"/);
  assert.doesNotMatch(ui, /Escalate/i);
  assert.doesNotMatch(ui, /final response quality/i);
  assert.doesNotMatch(ui, /response hash/i);
  assert.doesNotMatch(ui, /modelId/i);
});

test("complete inbox and client context remain authenticated and bounded", async () => {
  const [conversationsApi, contextApi, frontDeskRepository] = await Promise.all([
    readFile(conversationsApiUrl, "utf8"),
    readFile(clientContextApiUrl, "utf8"),
    readFile(frontDeskRepositoryUrl, "utf8"),
  ]);
  assert.match(conversationsApi, /authenticateCommandCentre/);
  assert.match(conversationsApi, /Math\.min\(Number\(value\), 300\)/);
  assert.match(conversationsApi, /createFrontDeskRepository/);
  assert.match(contextApi, /authenticateCommandCentre/);
  assert.match(contextApi, /ai_lookup_bookings_by_mobile|createFrontDeskRepository/);
  assert.match(contextApi, /Timely must be checked/);
  assert.match(frontDeskRepository, /Math\.min\(input\.limit \?\? 250, 300\)/);
  assert.match(frontDeskRepository, /ai_lookup_bookings_by_mobile/);
  assert.match(frontDeskRepository, /provider_timestamp/);
  assert.doesNotMatch(frontDeskRepository, /NEXT_PUBLIC/);
});

test("edited or unchanged replies use only the Tanglin 360dialog route", async () => {
  const [queueApi, messageApi, boundary, repository] = await Promise.all([
    readFile(queueApiUrl, "utf8"),
    readFile(messageApiUrl, "utf8"),
    readFile(boundaryUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);

  for (const source of [queueApi, messageApi]) {
    assert.match(source, /authenticateCommandCentre/);
  }
  assert.match(messageApi, /requireSameOrigin/);
  assert.match(messageApi, /requireCommandCentreCsrf/);
  assert.match(messageApi, /D360WhatsAppClient/);
  assert.match(messageApi, /whatsapp\.sendText/);
  assert.match(messageApi, /finalMessageText: body\.messageText/);
  assert.doesNotMatch(messageApi, /MetaWhatsAppClient/);
  assert.doesNotMatch(messageApi, /drainOutbox/);
  assert.doesNotMatch(messageApi, /Timely/i);
  assert.match(boundary, /provider === "360dialog"/);
  assert.match(boundary, /HERA_TANGLIN_WHATSAPP_CHANNEL/);
  assert.match(repository, /ai_cc_reserve_receptionist_send/);
  assert.match(repository, /ai_cc_preflight_receptionist_send/);
  assert.match(repository, /ai_cc_complete_receptionist_send/);
});

test("regenerate creates one fresh shadow draft and never sends it", async () => {
  const source = await readFile(regenerateApiUrl, "utf8");
  assert.match(source, /drainReceptionistForJobs/);
  assert.match(source, /runtime\.sendMode !== "shadow"/);
  assert.match(source, /requestRegeneration/);
  assert.match(source, /recoverRegeneration/);
  assert.doesNotMatch(source, /sendText/);
  assert.doesNotMatch(source, /D360WhatsAppClient/);
  assert.doesNotMatch(source, /Timely/i);
});

test("database contract accepts edited sends and preserves exact audit evidence", async () => {
  const sql = await migrationSql();
  assert.doesNotThrow(() => parse(sql));
  assert.match(sql, /ai_cc_list_receptionist_queue/i);
  assert.match(sql, /ai_cc_receptionist_candidate_block_reason/i);
  assert.match(sql, /final_response_hash/i);
  assert.match(sql, /edited_by_human/i);
  assert.match(sql, /candidate_hash_changed/i);
  assert.match(sql, /final_message_changed/i);
  assert.match(sql, /recipient_mismatch/i);
  assert.match(sql, /recipient_display_changed/i);
  assert.match(sql, /candidate_not_latest/i);
  assert.match(sql, /human_reply_already_recorded/i);
  assert.match(sql, /customer_service_window_expired/i);
  assert.match(sql, /human-receptionist:/i);
  assert.match(sql, /send_authorization,[\s\S]*'management'/i);
  assert.match(sql, /receptionist_message_sent/i);
  assert.match(sql, /tanglin_whatsapp_360dialog/i);
  assert.match(sql, /set ai_generated = false/i);
});

test("complaints remain receptionist-sendable while freshness and quality still fail closed", async () => {
  const sql = await migrationSql();
  const start = sql.indexOf(
    "create or replace function public.ai_cc_receptionist_candidate_block_reason",
  );
  const end = sql.indexOf(
    "create or replace function public.ai_cc_list_receptionist_queue",
  );
  const guard = sql.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(guard, /'receptionist'/);
  assert.match(guard, /quality_evidence_failed/);
  assert.match(guard, /candidate_text_mismatch/);
  assert.doesNotMatch(guard, /risk_requires_specialist/);
  assert.doesNotMatch(guard, /operating_mode/);
  assert.doesNotMatch(guard, /role_not_authorized_for_open_task/);
});

test("regeneration is reversible, bounded and service-role only", async () => {
  const sql = await migrationSql();
  assert.match(sql, /ai_receptionist_regeneration_history/);
  assert.match(sql, /previous_candidate_body/);
  assert.match(sql, /previous_decisions/);
  assert.match(sql, /ai_cc_request_receptionist_regeneration/);
  assert.match(sql, /ai_cc_recover_receptionist_regeneration/);
  assert.match(sql, /'human-regenerate:'/);
  assert.match(sql, /'pending',[\s\S]*0,[\s\S]*1,[\s\S]*now\(\)/i);
  assert.match(sql, /regeneration_failed_original_restored/);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /force row level security/i);
  assert.match(
    sql,
    /revoke all on table public\.ai_receptionist_regeneration_history[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.ai_cc_reserve_receptionist_send/i,
  );
  assert.match(sql, /to service_role/i);
});

test("Vercel gives send and regeneration endpoints bounded execution time", async () => {
  const config = JSON.parse(await readFile(vercelUrl, "utf8")) as {
    functions?: Record<string, { maxDuration?: number | string }>;
  };
  assert.equal(
    config.functions?.["api/command-centre/receptionist-message.ts"]?.maxDuration,
    60,
  );
  assert.equal(
    config.functions?.["api/command-centre/receptionist-regenerate.ts"]?.maxDuration,
    300,
  );
});
