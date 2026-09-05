import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { parse } from "libpg-query";
import {
  generateResetDraft,
  RESET_MAX_MODEL_CALLS,
  RESET_MAX_TRANSPORT_RETRIES,
  RESET_OPENAI_MODEL_ID,
  RESET_OPENAI_REASONING_EFFORT,
} from "../src/reset/engine.js";
import type {
  ResetDraftDecision,
  ResetEvidenceBundle,
} from "../src/reset/types.js";
import {
  selectReceptionistInboundMode,
  useReceptionistResetV3,
} from "../src/reset/boundary.js";
import { hasCapability } from "../src/command-centre/permissions.js";
import type { CommandCentreRole } from "../src/command-centre/types.js";

const uiUrl = new URL(
  "../public/command-centre/reset-workspace.js",
  import.meta.url,
);
const webhookUrl = new URL("../api/whatsapp/360dialog.ts", import.meta.url);
const metaWebhookUrl = new URL("../api/whatsapp/webhook.ts", import.meta.url);
const retryUrl = new URL(
  "../api/command-centre/reset-retry.ts",
  import.meta.url,
);
const generateUrl = new URL(
  "../api/command-centre/reset-generate.ts",
  import.meta.url,
);
const resetStateUrl = new URL(
  "../api/command-centre/reset-state.ts",
  import.meta.url,
);
const drainUrl = new URL("../api/internal/drain.ts", import.meta.url);
const syntheticProofUrl = new URL(
  "../api/internal/reset-v3-synthetic-proof.ts",
  import.meta.url,
);
const workerUrl = new URL("../src/reset/worker.ts", import.meta.url);
const engineUrl = new URL("../src/reset/engine.ts", import.meta.url);
const resetRepositoryUrl = new URL("../src/reset/repository.ts", import.meta.url);
const authorizationMigrationUrl = new URL(
  "../supabase/migrations/20260905000000_enforce_manual_ai_generation_authorization.sql",
  import.meta.url,
);
const resetV3CompletionMigrationUrl = new URL(
  "../supabase/migrations/20260830030002_complete_receptionist_reset_v3.sql",
  import.meta.url,
);

function functionSource(source: string, name: string, nextName: string): string {
  const startMatch = new RegExp(`(?:^|\\n)(?:async )?function ${name}\\(`).exec(source);
  const start = startMatch
    ? startMatch.index + (startMatch[0].startsWith("\n") ? 1 : 0)
    : -1;
  const remaining = start >= 0 ? source.slice(start + 1) : "";
  const endMatch = new RegExp(`\\n(?:async )?function ${nextName}\\(`).exec(remaining);
  const end = endMatch ? start + 1 + endMatch.index : -1;
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must be followed by ${nextName}`);
  return source.slice(start, end);
}

function sqlFunctionSource(source: string, name: string): string {
  const match = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "i",
  ).exec(source);
  assert.ok(match, `${name} must be defined`);
  return match[0];
}

function classMethodSource(
  source: string,
  name: string,
  nextName: string,
): string {
  const match = new RegExp(
    `\\n  async ${name}\\([\\s\\S]*?(?=\\n  async ${nextName}\\()`,
  ).exec(source);
  assert.ok(match, `${name} must exist before ${nextName}`);
  return match[0];
}

interface ComposerResetState {
  turnStatus: "collecting" | "processing" | "ready" | "failed";
  turnId: string;
  settleAt: string;
  candidateId?: string | null;
  candidateText?: string | null;
  candidateHash?: string | null;
  candidateModelAttempts?: number | null;
  retryAvailable?: boolean;
  generationRequestPending?: boolean;
  jobLeaseStale?: boolean;
  failureMessage?: string | null;
}

async function mapResetState(
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const source = await readFile(resetStateUrl, "utf8");
  const start = source.indexOf("function numberValue(");
  const end = source.indexOf("export default async function handler(");
  assert.ok(start >= 0 && end > start, "reset-state mapper must remain testable");
  const mapperSource = source
    .slice(start, end)
    .replace(
      "function numberValue(value: unknown): number",
      "function numberValue(value)",
    )
    .replace(
      "function mapState(value: Record<string, unknown>)",
      "function mapState(value)",
    );
  const build = new Function(
    `${mapperSource}; return mapState;`,
  ) as () => (row: Record<string, unknown>) => Record<string, unknown>;
  return build()(value);
}

async function renderComposer(
  reset: ComposerResetState,
  options: { generationAccepted?: boolean } = {},
): Promise<string> {
  const source = await readFile(uiUrl, "utf8");
  const generationRequestedSource = functionSource(
    source,
    "generationRequested",
    "primaryStatus",
  );
  const composer = functionSource(source, "composerView", "renderMain");
  const state = {
    busy: null,
    draft: reset.candidateText ?? "",
    manualMode: false,
    generationRequests: new Map<string, number>(),
  };
  if (options.generationAccepted) {
    state.generationRequests.set(reset.turnId, Date.now());
  }
  const build = new Function(
    "state",
    "resetState",
    "primaryStatus",
    "REPLY_WINDOW_MS",
    "GENERATION_REQUEST_GRACE_MS",
    "escapeHtml",
    `${generationRequestedSource}; ${composer}; return composerView;`,
  ) as (
    stateValue: typeof state,
    resetStateValue: () => ComposerResetState,
    primaryStatusValue: () => { key: string },
    replyWindowMs: number,
    generationRequestGraceMs: number,
    escapeHtmlValue: (value: unknown) => string,
  ) => (conversation: Record<string, unknown>) => string;
  const view = build(
    state,
    () => reset,
    () => ({ key: reset.turnStatus }),
    24 * 60 * 60 * 1_000,
    30_000,
    (value) => String(value ?? ""),
  );
  return view({
    id: "conversation-test",
    phoneEnding: "2052",
    lastMessageDirection: "inbound",
    lastMessageAt: new Date().toISOString(),
  });
}

function evidence(): ResetEvidenceBundle {
  return {
    channel: "Tanglin Mall WhatsApp",
    outlet: "Tanglin Mall",
    turnId: "turn-test",
    turnVersion: 1,
    client: { displayName: "Test Client", whatsappEnding: "2052" },
    consolidatedClientTurn: "Could you please help me with this?",
    fragments: [],
    recentConversation: [],
    knowledge: [],
    currentClientAppointments: [],
    authorityBoundaries: {
      mayDraft: true,
      maySendAutomatically: false,
      mayWriteTimely: false,
      mayConfirmLiveAvailability: false,
      mayConfirmBookingChangeWithoutVerifiedOutcome: false,
      mayApproveRefundOrCompensation: false,
      humanApprovalRequired: true,
    },
  };
}

const safeDecision: ResetDraftDecision = {
  replyRecommended: true,
  finalReply:
    "Thank you for your message. We can help review this with you and continue the conversation here.",
  intent: "other",
  currentEmergency: false,
  currentEmergencyReason: null,
  reviewPriority: "normal",
  verifiedFactsUsed: [],
  factsStillMissing: [],
  rationaleSummary: "A concise, safe and helpful reply is appropriate.",
};

const reportedUsage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 30,
    text: 30,
    reasoning: undefined,
  },
};

function toolResponse(): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "manual-assist-test",
        toolName: "submitReceptionistDraft",
        input: JSON.stringify(safeDecision),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: reportedUsage,
    warnings: [],
    response: { modelId: RESET_OPENAI_MODEL_ID },
  };
}

test("a settled collecting turn renders Generate AI Reply and never claims AI is preparing", async () => {
  const html = await renderComposer({
    turnStatus: "collecting",
    turnId: "turn-test",
    settleAt: new Date(Date.now() - 60_000).toISOString(),
  });

  assert.match(html, /data-action="generate"/);
  assert.match(html, />Generate AI Reply</);
  assert.match(html, /No AI cost has been incurred/i);
  assert.doesNotMatch(html, /AI is preparing your requested reply/i);
});

test("only a processing turn renders the human-requested preparing state", async () => {
  const html = await renderComposer({
    turnStatus: "processing",
    turnId: "turn-test",
    settleAt: new Date(Date.now() - 60_000).toISOString(),
  });

  assert.match(html, /AI is preparing your requested reply/i);
  assert.match(html, /started by a human/i);
  assert.doesNotMatch(html, /data-action="generate"/);
});

test("reset-state marks a processing worker stale after seven minutes and bounds retry by run count", async () => {
  const source = await readFile(resetStateUrl, "utf8");
  assert.match(source, /RESET_WORKER_LEASE_MS\s*=\s*7\s*\*\s*60\s*\*\s*1_000/);
  assert.match(
    source,
    /jobLockedAtMs\s*<=\s*Date\.now\(\)\s*-\s*RESET_WORKER_LEASE_MS/,
  );

  const base = {
    turn_status: "processing",
    job_status: "processing",
    job_locked_at: new Date(Date.now() - 8 * 60_000).toISOString(),
  };
  const retryable = await mapResetState({ ...base, generation_runs: 1 });
  assert.equal(retryable.jobLeaseStale, true);
  assert.equal(retryable.retryAvailable, true);
  assert.equal(retryable.retryUnavailableReason, null);

  const exhausted = await mapResetState({ ...base, generation_runs: 2 });
  assert.equal(exhausted.jobLeaseStale, true);
  assert.equal(exhausted.retryAvailable, false);
  assert.equal(exhausted.retryUnavailableReason, "retry_limit_reached");

  const active = await mapResetState({
    ...base,
    generation_runs: 1,
    job_locked_at: new Date(Date.now() - 6 * 60_000).toISOString(),
  });
  assert.equal(active.jobLeaseStale, false);
  assert.equal(active.retryAvailable, false);

  const completed = await mapResetState({
    turn_status: "ready",
    job_status: "ready",
    generation_runs: 1,
  });
  assert.equal(completed.jobLeaseStale, false);
  assert.equal(
    completed.retryAvailable,
    false,
    "a successful best draft must not offer another paid generation",
  );
  assert.equal(completed.retryUnavailableReason, null);
});

test("a stale worker renders a stopped state with only explicit manual recovery actions", async () => {
  const html = await renderComposer({
    turnStatus: "processing",
    turnId: "turn-test",
    settleAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    jobLeaseStale: true,
    retryAvailable: true,
  });
  const source = await readFile(uiUrl, "utf8");
  const retry = functionSource(source, "retryDraft", "generateDraft");

  assert.match(html, /The requested AI reply did not finish/);
  assert.match(html, /No automatic retry will occur/);
  assert.match(html, /data-action="manual"[^>]*>Write manually</);
  assert.match(html, /data-action="retry"[^>]*>Retry AI Reply</);
  assert.doesNotMatch(html, /rr-spinner|AI is preparing your requested reply/);

  assert.match(
    retry,
    /await request\("\/api\/command-centre\/reset-retry",\s*\{[\s\S]{0,120}method:\s*"POST"/,
  );
  assert.match(
    source,
    /action === "retry"\)\s*\{\s*void retryDraft\(\)/,
  );
  assert.equal(
    source.match(/\bretryDraft\(\)/g)?.length,
    2,
    "retryDraft must only be defined and invoked by the explicit click handler",
  );
  assert.doesNotMatch(source, /setTimeout\s*\(\s*retryDraft|setInterval\s*\(\s*retryDraft/);
});

test("an exhausted stale worker offers manual writing without another paid retry", async () => {
  const html = await renderComposer({
    turnStatus: "processing",
    turnId: "turn-test",
    settleAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    jobLeaseStale: true,
    retryAvailable: false,
  });

  assert.match(html, /data-action="manual"[^>]*>Write manually</);
  assert.match(html, /single AI retry has already been used/i);
  assert.doesNotMatch(html, /data-action="retry"|rr-spinner/);
});

test("an unsettled collecting turn waits without falsely claiming that AI is running", async () => {
  const html = await renderComposer({
    turnStatus: "collecting",
    turnId: "turn-test",
    settleAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.match(html, /data-action="generate" disabled/);
  assert.match(html, /Messages still arriving/);
  assert.match(html, /No AI cost has been incurred/i);
  assert.doesNotMatch(html, /AI is preparing your requested reply/i);
});

test("a locally accepted Generate request shows preparing during the database claim race", async () => {
  const html = await renderComposer(
    {
      turnStatus: "collecting",
      turnId: "turn-test",
      settleAt: new Date(Date.now() - 60_000).toISOString(),
    },
    { generationAccepted: true },
  );

  assert.match(html, /AI is preparing your requested reply/i);
  assert.match(html, /started by a human/i);
  assert.doesNotMatch(html, /data-action="generate"/);
});

test("the inbound webhook and scheduled/read-only endpoints have no Reset-v3 generation path", async () => {
  const [webhook, metaWebhook, drain, resetState] = await Promise.all([
    readFile(webhookUrl, "utf8"),
    readFile(metaWebhookUrl, "utf8"),
    readFile(drainUrl, "utf8"),
    readFile(resetStateUrl, "utf8"),
  ]);

  for (const inbound of [webhook, metaWebhook]) {
    assert.match(inbound, /resetRepository\.ingestInboundWithoutLegacyJob/);
    assert.doesNotMatch(inbound, /resetRepository\.appendFragment/);
    assert.match(inbound, /if \(!resetV3 && wakeableJobIds\.length > 0\)/);
    assert.doesNotMatch(inbound, /drainResetTurnJobs/);
  }
  assert.match(drain, /if \(useReceptionistResetV3\(\)\)/);
  assert.match(drain, /reset_v3_automatic_drain_suppressed/);
  assert.doesNotMatch(drain, /drainResetTurnJobs/);
  assert.doesNotMatch(resetState, /waitUntil|drainResetTurnJobs|generateResetDraft/);
});

test("feature Reset-v3 ingestion uses the no-legacy-job repository path", async () => {
  const [webhook, repository] = await Promise.all([
    readFile(webhookUrl, "utf8"),
    readFile(resetRepositoryUrl, "utf8"),
  ]);
  const ingestWithoutLegacyJob = classMethodSource(
    repository,
    "ingestInboundWithoutLegacyJob",
    "appendFragment",
  );

  assert.match(
    webhook,
    /inboundMode\s*===\s*"reset-v3-manual"\s*&&\s*resetRepository[\s\S]{0,160}resetRepository\.ingestInboundWithoutLegacyJob\(message\)/,
  );
  assert.match(
    ingestWithoutLegacyJob,
    /"ai_ingest_whatsapp_message_reset_v3"/,
  );
  assert.match(ingestWithoutLegacyJob, /jobId:\s*null/);
  assert.doesNotMatch(ingestWithoutLegacyJob, /\.rpc\("ai_ingest_whatsapp_message"/);
});

test("manual Reset-v3 ingestion wins when the legacy human-review flag is also enabled", () => {
  assert.equal(
    selectReceptionistInboundMode({
      resetV3: true,
      humanReviewDrafting: true,
    }),
    "reset-v3-manual",
  );
  assert.equal(
    selectReceptionistInboundMode({
      resetV3: false,
      humanReviewDrafting: true,
    }),
    "preview-human-review",
  );
  assert.equal(
    selectReceptionistInboundMode({
      resetV3: false,
      humanReviewDrafting: false,
    }),
    "legacy",
  );
});

test("the no-legacy-job ingest wrapper suppresses the base job atomically and is service-role only", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const wrapper = sqlFunctionSource(
    migration,
    "ai_ingest_whatsapp_message_reset_v3",
  );
  const baseIngest = wrapper.indexOf("public.ai_ingest_whatsapp_message(");
  const appendTurn = wrapper.indexOf("public.ai_append_client_turn_fragment_v3(");
  const suppressJob = wrapper.indexOf("update public.ai_jobs");
  const returnResult = wrapper.lastIndexOf("return");

  assert.ok(baseIngest >= 0, "wrapper must call the canonical base ingest");
  assert.ok(
    appendTurn > baseIngest,
    "wrapper must append the Reset-v3 turn in the same database transaction",
  );
  assert.ok(
    suppressJob > baseIngest,
    "wrapper must suppress the base ingest job in the same database function",
  );
  assert.ok(returnResult > suppressJob, "wrapper must suppress before returning");
  assert.ok(returnResult > appendTurn, "wrapper must append before returning");
  assert.match(wrapper, /update public\.ai_jobs[\s\S]*status\s*=\s*'completed'/i);
  assert.match(wrapper, /(?:'jobId'\s*,\s*null|\{jobId\}[\s\S]{0,80}'null')/i);

  const normalized = migration.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /revoke all on function public\.ai_ingest_whatsapp_message_reset_v3\s*\([\s\S]{0,900}\)\s*from public, anon, authenticated/i,
  );
  assert.match(
    normalized,
    /grant execute on function public\.ai_ingest_whatsapp_message_reset_v3\s*\([\s\S]{0,900}\)\s*to service_role/i,
  );
  assert.doesNotMatch(
    normalized,
    /grant execute on function public\.ai_ingest_whatsapp_message_reset_v3\s*\([\s\S]{0,900}\)\s*to (?:public|anon|authenticated)/i,
  );
});

test("the former synthetic proof route is disabled and cannot spend on AI", async () => {
  const source = await readFile(syntheticProofUrl, "utf8");

  assert.match(source, /response\.status\(410\)/);
  assert.doesNotMatch(
    source,
    /createClient|getDatabaseConfig|RESET_OPENAI_MODEL_ID|drainResetTurnJobs|generateResetDraft|waitUntil/,
  );
  assert.doesNotMatch(
    source,
    /D360WhatsAppClient|MetaWhatsAppClient|\.sendText\s*\(/,
  );
});

test("one explicit Generate click targets one turn and schedules one bounded worker drain", async () => {
  const source = await readFile(generateUrl, "utf8");

  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /requireSameOrigin\(request\)/);
  assert.match(source, /requireCommandCentreCsrf\(request\)/);
  assert.match(source, /state\.turnStatus !== "collecting"/);
  assert.match(source, /state\.jobStatus !== "pending"/);
  assert.match(source, /state\.turnModelAttempts !== 0/);
  assert.match(source, /state\.jobModelAttempts !== 0/);
  assert.match(source, /repository\.authorizeGeneration\(\{/);
  assert.match(source, /actorUserId:\s*session\.staff\.userId/);
  assert.match(source, /requestId:\s*randomUUID\(\)/);
  assert.equal(source.match(/\bdrainResetTurnJobs\s*\(/g)?.length, 1);
  assert.match(source, /turnId,/);
  assert.match(source, /requestId:\s*authorization\.requestId/);
  assert.match(source, /initiatedByHuman:\s*true/);
  assert.match(source, /automaticDeliveryAllowed:\s*false/);
});

test("Generate and Retry are bound to the exact client turn the staff reviewed", async () => {
  const [migration, stateSource, generate, retry, repository, ui] =
    await Promise.all([
      readFile(authorizationMigrationUrl, "utf8"),
      readFile(resetStateUrl, "utf8"),
      readFile(generateUrl, "utf8"),
      readFile(retryUrl, "utf8"),
      readFile(resetRepositoryUrl, "utf8"),
      readFile(uiUrl, "utf8"),
    ]);
  const authorize = sqlFunctionSource(
    migration,
    "ai_authorize_turn_generation_v3",
  );
  const retryAuthorize = sqlFunctionSource(
    migration,
    "ai_retry_and_authorize_turn_v3",
  );

  assert.match(migration, /turn\.last_fragment_message_id\s*,[\s\S]{0,500}as turn_content_hash/i);
  assert.match(stateSource, /lastFragmentMessageId:[\s\S]{0,180}last_fragment_message_id/i);
  assert.match(stateSource, /turnContentHash:[\s\S]{0,220}turn_content_hash/i);
  for (const endpoint of [generate, retry]) {
    assert.match(endpoint, /expectedLastFragmentMessageId:\s*z\.string\(\)\.uuid\(\)/);
    assert.match(endpoint, /expectedTurnContentHash:[\s\S]{0,100}\^\[0-9a-f\]\{64\}\$/);
    assert.match(endpoint, /expectedLastFragmentMessageId/);
    assert.match(endpoint, /expectedTurnContentHash/);
  }
  for (const authorization of [authorize, retryAuthorize]) {
    assert.match(authorization, /p_expected_last_fragment_message_id\s+uuid/i);
    assert.match(authorization, /p_expected_turn_content_hash\s+text/i);
    assert.match(
      authorization,
      /v_turn\.last_fragment_message_id[\s\S]{0,100}is distinct from p_expected_last_fragment_message_id/i,
    );
    assert.match(
      authorization,
      /v_turn_content_hash\s+is distinct from p_expected_turn_content_hash/i,
    );
    assert.match(authorization, /'reviewed_turn_content_changed'/i);
    assert.match(authorization, /firstFragmentAtEpoch/i);
    assert.match(authorization, /lastFragmentAtEpoch/i);
    assert.doesNotMatch(authorization, /'firstFragmentAt'\s*,\s*v_turn\.first_fragment_at/i);
  }
  assert.match(repository, /p_expected_last_fragment_message_id:/);
  assert.match(repository, /p_expected_turn_content_hash:/);
  assert.match(ui, /expectedLastFragmentMessageId:\s*reset\.lastFragmentMessageId/);
  assert.match(ui, /expectedTurnContentHash:\s*reset\.turnContentHash/);
});

test("only front-desk decision roles have the dedicated Generate AI Reply capability", () => {
  const allowed: CommandCentreRole[] = [
    "owner",
    "managing_director",
    "salon_manager",
    "receptionist",
  ];
  const denied: CommandCentreRole[] = [
    "technical_lead",
    "finance_admin",
    "privacy_officer",
    "auditor",
  ];

  for (const role of allowed) {
    assert.equal(
      hasCapability(role, "generate_ai_reply"),
      true,
      `${role} must be allowed to request an AI reply`,
    );
  }
  for (const role of denied) {
    assert.equal(
      hasCapability(role, "generate_ai_reply"),
      false,
      `${role} must not be allowed to spend on an AI reply`,
    );
  }
});

test("both generation endpoints require the dedicated spend capability", async () => {
  const retryUrl = new URL(
    "../api/command-centre/reset-retry.ts",
    import.meta.url,
  );
  const [generate, retry] = await Promise.all([
    readFile(generateUrl, "utf8"),
    readFile(retryUrl, "utf8"),
  ]);

  for (const source of [generate, retry]) {
    assert.match(source, /hasCapability\(session\.staff\.role, "generate_ai_reply"\)/);
  }
});

test("database authorization independently permits only the four front-desk decision roles", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const authorizationFunctions = [
    sqlFunctionSource(migration, "ai_authorize_turn_generation_v3"),
    sqlFunctionSource(migration, "ai_retry_and_authorize_turn_v3"),
  ];
  const expectedRoles = [
    "owner",
    "managing_director",
    "salon_manager",
    "receptionist",
  ];

  for (const source of authorizationFunctions) {
    assert.match(source, /v_role\s*:=\s*public\.ai_cc_staff_role\(p_actor_user_id\)/i);
    const allowlist = /v_role\s+not\s+in\s*\(([\s\S]*?)\)\s*then/i.exec(source);
    assert.ok(allowlist, "generation authorization must have a role allowlist");
    const roles = [...(allowlist?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
      (item) => item[1],
    );
    assert.deepEqual(roles, expectedRoles);
  }
});

test("the database can claim only one exact turn with a durable staff request receipt", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");

  assert.doesNotThrow(() => parse(migration));
  assert.match(migration, /generation_request_id uuid/);
  assert.match(migration, /generation_authorized_by uuid/);
  assert.match(migration, /generation_authorization_consumed_at timestamptz/);
  assert.match(migration, /generation_authorized_conversation_context jsonb/);
  assert.match(migration, /ai_authorize_turn_generation_v3/);
  assert.match(migration, /ai_retry_and_authorize_turn_v3/);
  assert.match(migration, /ai_claim_authorized_turn_job_v3/);
  assert.match(migration, /job\.turn_id = p_turn_id/);
  assert.match(migration, /job\.generation_request_id = p_request_id/);
  assert.match(migration, /job\.generation_authorization_consumed_at is null/);
  assert.match(migration, /generation_authorization_consumed_at = now\(\)/);
  assert.match(
    migration,
    /revoke all on function public\.ai_claim_turn_jobs_v3\(text, integer, uuid\[\]\)[\s\S]*service_role/,
  );
  assert.match(
    migration,
    /revoke all on function public\.ai_retry_turn_v3\(uuid\)[\s\S]*service_role/,
  );
});

test("the worker uses only the immutable click-time context and rechecks before the model call", async () => {
  const [migration, repository, worker] = await Promise.all([
    readFile(authorizationMigrationUrl, "utf8"),
    readFile(resetRepositoryUrl, "utf8"),
    readFile(workerUrl, "utf8"),
  ]);
  const authorize = sqlFunctionSource(
    migration,
    "ai_authorize_turn_generation_v3",
  );
  const retry = sqlFunctionSource(
    migration,
    "ai_retry_and_authorize_turn_v3",
  );
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );
  const preflight = sqlFunctionSource(
    migration,
    "ai_validate_authorized_turn_job_v3",
  );

  for (const authorization of [authorize, retry]) {
    assert.match(authorization, /from public\.ai_messages message/i);
    assert.match(authorization, /limit 20/i);
    assert.match(
      authorization,
      /generation_authorized_conversation_context\s*=\s*v_conversation_context/i,
    );
  }
  assert.match(
    claim,
    /generation_authorized_conversation_context\s+jsonb/i,
  );
  assert.match(
    claim,
    /v_job\.generation_authorized_conversation_context[\s\S]{0,120}v_job\.locked_by/i,
  );
  assert.match(repository, /conversationSnapshot\([\s\S]{0,120}generation_authorized_conversation_context/);
  assert.match(worker, /recentConversation:\s*job\.recentConversation/);
  assert.doesNotMatch(worker, /getRecentConversation\(/);
  const evidenceAt = worker.indexOf("const evidence = await buildResetEvidenceBundle");
  const preflightAt = worker.indexOf("validateAuthorizedTurnJob(job)");
  const modelAt = worker.indexOf("const result = await generateResetDraft");
  assert.ok(evidenceAt >= 0 && preflightAt > evidenceAt && modelAt > preflightAt);

  assert.match(preflight, /p_request_id\s+uuid/i);
  assert.match(preflight, /p_generation_run\s+integer/i);
  assert.match(preflight, /p_worker_id\s+text/i);
  assert.match(preflight, /generation_authorized_turn_content_hash/i);
  assert.match(preflight, /generation_authorized_last_fragment_message_id/i);
  assert.match(preflight, /'modelCallStarted'\s*,\s*false/i);
  assert.match(repository, /"ai_validate_authorized_turn_job_v3"/);
});

test("a human answer invalidates an unused receipt before any paid claim", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );
  const humanGuard = claim.indexOf("message.direction = 'outbound'");
  const consume = claim.indexOf("generation_authorization_consumed_at = now()");

  assert.ok(humanGuard >= 0 && consume > humanGuard);
  assert.match(
    claim,
    /message\.created_at\s*>=\s*v_job\.generation_authorized_at/i,
  );
  assert.match(claim, /'answered_by_human_before_model_call'/i);
  assert.match(claim, /'modelCallStarted'\s*,\s*false/i);
});

test("an invalidated unspent retry returns to a visible retryable failed state", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const trigger = sqlFunctionSource(
    migration,
    "ai_invalidate_generation_authorization_on_turn_change_v3",
  );
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );

  for (const invalidator of [trigger, claim]) {
    assert.match(
      invalidator,
      /generation_run\s*>=\s*1[\s\S]{0,100}'failed'/i,
    );
    assert.match(invalidator, /turn_changed_after_retry_authorization/i);
    assert.match(
      invalidator,
      /update public\.ai_client_turns_v3[\s\S]{0,220}status\s*=\s*'failed'/i,
    );
  }
});

test("initial generation authorization is exclusively run one", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const initialAuthorization = sqlFunctionSource(
    migration,
    "ai_authorize_turn_generation_v3",
  );

  assert.match(
    initialAuthorization,
    /if\s+v_turn\.generation_runs\s*(?:<>|!=)\s*0[\s\S]{0,120}\bthen\b/i,
  );
  assert.match(initialAuthorization, /v_next_run\s*:=\s*1\s*;/i);
  assert.doesNotMatch(
    initialAuthorization,
    /v_next_run\s*:=\s*v_turn\.generation_runs\s*\+\s*1/i,
  );
});

test("authorized claim is restricted to the latest conversation turn", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );

  assert.match(claim, /job\.turn_id\s*=\s*p_turn_id/i);
  assert.match(claim, /turn\.conversation_id/i);
  assert.match(
    claim,
    /(?:order by[\s\S]*version\s+desc[\s\S]*limit\s+1|newer\.version\s*>\s*turn\.version)/i,
  );
  assert.match(claim, /job\.generation_request_id\s*=\s*p_request_id/i);
});

test("a newer fragment invalidates an unconsumed generation receipt before claim", async () => {
  const [migration, completionMigration] = await Promise.all([
    readFile(authorizationMigrationUrl, "utf8"),
    readFile(resetV3CompletionMigrationUrl, "utf8"),
  ]);
  const append = sqlFunctionSource(
    completionMigration,
    "ai_append_client_turn_fragment_v3",
  );
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );
  const invalidation = claim.indexOf("reset_v3_generation_authorization_invalidated");
  const processing = claim.indexOf("set status = 'processing'");

  assert.match(
    append,
    /settle_at\s*=\s*greatest\(v_settle_at,\s*turn\.settle_at\)/i,
  );
  assert.match(
    append,
    /available_at\s*=\s*greatest\(v_settle_at,\s*available_at\)[\s\S]{0,160}status\s*=\s*'pending'/i,
  );

  assert.match(
    claim,
    /v_job\.generation_request_id\s+is\s+not\s+distinct\s+from\s+p_request_id/i,
  );
  assert.match(claim, /v_job\.status\s*=\s*'pending'/i);
  assert.match(
    claim,
    /v_job\.generation_authorization_consumed_at\s+is\s+null/i,
  );
  assert.match(
    claim,
    /v_turn\.settle_at\s*>\s*now\(\)\s+or\s+v_job\.available_at\s*>\s*now\(\)/i,
  );
  for (const field of [
    "authorized_generation_run",
    "generation_request_id",
    "generation_authorized_at",
    "generation_authorized_by",
    "generation_authorized_last_fragment_message_id",
    "generation_authorized_turn_content_hash",
    "generation_authorization_consumed_at",
  ]) {
    assert.match(claim, new RegExp(`${field}\\s*=\\s*null`, "i"));
  }
  assert.match(
    claim,
    /where\s+target_job\.id\s*=\s*v_job\.id[\s\S]{0,180}target_job\.generation_request_id\s*=\s*p_request_id[\s\S]{0,180}generation_authorization_consumed_at\s+is\s+null/i,
  );
  assert.match(claim, /'modelCallStarted'\s*,\s*false/i);
  assert.ok(
    invalidation >= 0 && processing > invalidation,
    "the stale receipt must be invalidated before any processing claim",
  );
});

test("an older in-window fragment also invalidates the exact reviewed-content receipt", async () => {
  const [migration, completionMigration] = await Promise.all([
    readFile(authorizationMigrationUrl, "utf8"),
    readFile(resetV3CompletionMigrationUrl, "utf8"),
  ]);
  const append = sqlFunctionSource(
    completionMigration,
    "ai_append_client_turn_fragment_v3",
  );
  const invalidate = sqlFunctionSource(
    migration,
    "ai_invalidate_generation_authorization_on_turn_change_v3",
  );
  const authorize = sqlFunctionSource(
    migration,
    "ai_authorize_turn_generation_v3",
  );
  const retry = sqlFunctionSource(
    migration,
    "ai_retry_and_authorize_turn_v3",
  );
  const claim = sqlFunctionSource(
    migration,
    "ai_claim_authorized_turn_job_v3",
  );

  // An older but in-window fragment can change the reviewed content while the
  // chronological last-fragment ID intentionally remains unchanged.
  assert.match(
    append,
    /last_fragment_message_id\s*=\s*case[\s\S]*v_effective_at\s*>=\s*turn\.last_fragment_at[\s\S]*else\s+turn\.last_fragment_message_id/i,
  );
  assert.match(
    append,
    /consolidated_text\s*=\s*case[\s\S]*turn\.consolidated_text\s*\|\|\s*E?'\\n'\s*\|\|\s*v_text/i,
  );
  assert.match(append, /fragments\s*=\s*public\.ai_trim_reset_fragments_v3/i);

  assert.match(
    migration,
    /after update of consolidated_text, fragments, source_message_id,[\s\S]{0,180}last_fragment_message_id, first_fragment_at, last_fragment_at/i,
  );
  assert.match(invalidate, /job\.status\s*=\s*'pending'/i);
  assert.match(
    invalidate,
    /job\.generation_authorization_consumed_at\s+is\s+null/i,
  );
  for (const field of [
    "authorized_generation_run",
    "generation_request_id",
    "generation_authorized_at",
    "generation_authorized_by",
    "generation_authorized_last_fragment_message_id",
    "generation_authorized_turn_content_hash",
    "generation_authorization_consumed_at",
  ]) {
    assert.match(invalidate, new RegExp(`${field}\\s*=\\s*null`, "i"));
  }
  assert.match(invalidate, /'modelCallStarted'\s*,\s*false/i);

  for (const authorization of [authorize, retry]) {
    assert.match(
      authorization,
      /generation_authorized_last_fragment_message_id\s*=\s*v_turn\.last_fragment_message_id/i,
    );
    assert.match(
      authorization,
      /generation_authorized_turn_content_hash\s*=\s*v_turn_content_hash/i,
    );
    assert.match(authorization, /'consolidatedText'\s*,\s*v_turn\.consolidated_text/i);
    assert.match(authorization, /'fragments'\s*,\s*v_turn\.fragments/i);
  }
  assert.match(
    claim,
    /v_job\.generation_authorized_last_fragment_message_id[\s\S]{0,100}is distinct from v_turn\.last_fragment_message_id/i,
  );
  assert.match(
    claim,
    /v_job\.generation_authorized_turn_content_hash[\s\S]{0,100}is distinct from v_turn_content_hash/i,
  );
});

test("ready and failed completion are bound to request, run and worker receipts", async () => {
  const [migration, repository] = await Promise.all([
    readFile(authorizationMigrationUrl, "utf8"),
    readFile(resetRepositoryUrl, "utf8"),
  ]);
  const ready = sqlFunctionSource(
    migration,
    "ai_finish_authorized_turn_ready_v3",
  );
  const failed = sqlFunctionSource(
    migration,
    "ai_finish_authorized_turn_failed_v3",
  );

  for (const finish of [ready, failed]) {
    assert.match(finish, /p_request_id\s+uuid/i);
    assert.match(finish, /p_generation_run\s+integer/i);
    assert.match(finish, /p_worker_id\s+text/i);
    assert.match(
      finish,
      /v_job\.generation_request_id\s+is\s+distinct\s+from\s+p_request_id/i,
    );
    assert.match(
      finish,
      /v_job\.generation_run\s+is\s+distinct\s+from\s+p_generation_run/i,
    );
    assert.match(
      finish,
      /v_job\.locked_by\s+is\s+distinct\s+from\s+left\(p_worker_id,\s*160\)/i,
    );
    assert.match(
      finish,
      /v_job\.generation_authorization_consumed_at\s+is\s+null/i,
    );
  }

  assert.match(
    ready,
    /v_job\.generation_authorized_last_fragment_message_id[\s\S]{0,100}is distinct from v_turn\.last_fragment_message_id/i,
  );
  assert.match(
    ready,
    /v_job\.generation_authorized_turn_content_hash[\s\S]{0,100}is distinct from v_turn_content_hash/i,
  );
  assert.match(ready, /'turn_content_changed_during_generation'/i);
  assert.match(
    ready,
    /message\.created_at\s*>=\s*v_job\.generation_authorized_at/i,
  );

  assert.match(repository, /"ai_finish_authorized_turn_ready_v3"/);
  assert.match(repository, /"ai_finish_authorized_turn_failed_v3"/);
  assert.match(repository, /p_request_id:\s*input\.job\.(?:requestId|generationRequestId)/);
  assert.match(repository, /p_generation_run:\s*input\.job\.generationRun/);
  assert.match(repository, /p_worker_id:\s*input\.job\.workerId/);
  assert.doesNotMatch(repository, /\.rpc\("ai_finish_turn_(?:ready|failed)_v3"/);
});

test("the single paid retry is available only after a failed or stale first call", async () => {
  const [migration, ui] = await Promise.all([
    readFile(authorizationMigrationUrl, "utf8"),
    readFile(uiUrl, "utf8"),
  ]);
  const retry = sqlFunctionSource(
    migration,
    "ai_retry_and_authorize_turn_v3",
  );

  assert.match(retry, /if\s+v_turn\.status\s*<>\s*'failed'\s+then/i);
  assert.doesNotMatch(
    retry,
    /v_turn\.status\s+not\s+in\s*\(\s*'failed'\s*,\s*'ready'\s*\)/i,
  );

  const readyHtml = await renderComposer({
    turnStatus: "ready",
    turnId: "turn-ready",
    settleAt: new Date(Date.now() - 60_000).toISOString(),
    candidateId: "candidate-ready",
    candidateText: "A finished best-quality draft.",
    candidateHash: "candidate-hash",
    candidateModelAttempts: 1,
    retryAvailable: true,
  });
  assert.match(readyHtml, /data-action="send"/);
  assert.doesNotMatch(readyHtml, /data-action="regenerate"|>Regenerate</i);
  assert.doesNotMatch(ui, /action\s*===\s*"regenerate"/);
});

test("human Send reservation follows the canonical generation lock order", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const reserve = sqlFunctionSource(
    migration,
    "ai_reserve_human_send_v3",
  );
  const conversationLock = reserve.indexOf(
    "hashtextextended(v_conversation_id::text, 703)",
  );
  const turnLock = reserve.indexOf(
    "hashtextextended(v_candidate_turn_id::text, 751)",
  );
  const turnRowLock = reserve.indexOf("select turn.* into strict v_turn");
  const candidateRowLock = reserve.indexOf(
    "select candidate.* into strict v_candidate",
  );

  assert.ok(conversationLock >= 0, "Send must take the conversation lock");
  assert.ok(turnLock > conversationLock, "turn advisory lock must follow conversation lock");
  assert.ok(turnRowLock > turnLock, "turn row lock must follow both advisory locks");
  assert.ok(
    candidateRowLock > turnRowLock,
    "candidate row lock must follow the turn row lock",
  );
  assert.match(
    reserve.slice(turnRowLock, candidateRowLock),
    /from public\.ai_client_turns_v3[\s\S]*for update/i,
  );
  assert.match(
    reserve.slice(candidateRowLock),
    /from public\.ai_reply_candidates_v3[\s\S]*for update/i,
  );
  assert.doesNotMatch(
    reserve,
    /hashtextextended\(p_candidate_id::text,\s*727\)/i,
  );
  assert.match(reserve, /v_turn\.delivery_control\s*<>\s*'human_only'/i);
  assert.match(reserve, /'human_reply_already_recorded'/i);

  const normalized = migration.replace(/\s+/g, " ");
  assert.match(
    normalized,
    /revoke all on function public\.ai_reserve_human_send_v3\s*\(\s*uuid,\s*uuid,\s*uuid,\s*integer,\s*text,\s*text,\s*text\s*\)\s*from public, anon, authenticated/i,
  );
  assert.match(
    normalized,
    /grant execute on function public\.ai_reserve_human_send_v3\s*\(\s*uuid,\s*uuid,\s*uuid,\s*integer,\s*text,\s*text,\s*text\s*\)\s*to service_role/i,
  );
});

test("legacy generic claim, retry and finish RPCs have no service-role execute privilege", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const normalizedMigration = migration.replace(/\s+/g, " ");
  const revokedSignatures = [
    String.raw`ai_ingest_whatsapp_message\s*\(\s*text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*jsonb,\s*text,\s*timestamptz,\s*jsonb\s*\)`,
    String.raw`ai_ingest_whatsapp_message_human_review\s*\(\s*text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*text,\s*jsonb,\s*text,\s*timestamptz,\s*jsonb\s*\)`,
    String.raw`ai_claim_jobs\s*\(\s*text,\s*integer\s*\)`,
    String.raw`ai_claim_turn_jobs_v3\s*\(\s*text,\s*integer,\s*uuid\[\]\s*\)`,
    String.raw`ai_retry_turn_v3\s*\(\s*uuid\s*\)`,
    String.raw`ai_finish_turn_ready_v3\s*\(\s*uuid,\s*uuid,\s*text,\s*integer,\s*text,\s*jsonb,\s*jsonb\s*\)`,
    String.raw`ai_finish_turn_failed_v3\s*\(\s*uuid,\s*uuid,\s*text,\s*text,\s*integer\s*\)`,
  ];

  for (const signature of revokedSignatures) {
    assert.match(
      normalizedMigration,
      new RegExp(
        `revoke all on function public\\.${signature}[\\s\\S]{0,160}from public, anon, authenticated, service_role`,
        "i",
      ),
    );
  }
});

test("generation authorization request UUIDs have an immutable one-use audit ledger", async () => {
  const migration = await readFile(authorizationMigrationUrl, "utf8");
  const normalizedMigration = migration.replace(/\s+/g, " ");

  assert.match(
    normalizedMigration,
    /create unique index if not exists ai_generation_authorization_request_audit_idx on public\.ai_audit_log \(\(details ->> 'requestId'\)\)[\s\S]{0,260}reset_v3_generation_authorized[\s\S]{0,160}reset_v3_retry_generation_authorized/i,
  );
  assert.match(
    migration,
    /reset_v3_generation_authorization_audit_is_immutable/i,
  );
  assert.match(
    migration,
    /generation_request_id_already_used/g,
  );
});

test("the feature branch cannot fall back to legacy automatic drafting", () => {
  assert.equal(
    useReceptionistResetV3({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feat/hera-ai-receptionist-foundation",
      WHATSAPP_SEND_MODE: "live",
    } as NodeJS.ProcessEnv),
    true,
  );
  assert.equal(
    useReceptionistResetV3({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "main",
      WHATSAPP_SEND_MODE: "shadow",
    } as NodeJS.ProcessEnv),
    false,
  );
  assert.equal(
    useReceptionistResetV3({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "feat/hera-ai-receptionist-foundation",
      WHATSAPP_SEND_MODE: "shadow",
    } as NodeJS.ProcessEnv),
    false,
  );
});

test("one manual generation performs exactly one Sol Max model call", async () => {
  let calls = 0;
  const requestedModelIds: string[] = [];
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId: RESET_OPENAI_MODEL_ID,
    doGenerate: async () => {
      calls += 1;
      return toolResponse();
    },
  });

  const result = await generateResetDraft({
    evidence: evidence(),
    modelFactory: (modelId) => {
      requestedModelIds.push(modelId);
      return model;
    },
  });

  assert.equal(RESET_MAX_MODEL_CALLS, 1);
  assert.equal(RESET_MAX_TRANSPORT_RETRIES, 0);
  assert.equal(RESET_OPENAI_REASONING_EFFORT, "max");
  assert.equal(calls, 1);
  assert.deepEqual(requestedModelIds, [RESET_OPENAI_MODEL_ID]);
  assert.equal(result.modelAttempts, 1);
  assert.equal(result.modelId, RESET_OPENAI_MODEL_ID);
});

test("a provider failure performs no automatic retry or hidden second generation", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    provider: "offline",
    modelId: RESET_OPENAI_MODEL_ID,
    doGenerate: async () => {
      calls += 1;
      throw new Error("offline provider failure");
    },
  });

  await assert.rejects(
    generateResetDraft({ evidence: evidence(), modelFactory: () => model }),
    /could not complete the receptionist draft generation/i,
  );
  assert.equal(calls, 1);
});

test("generation cannot send; review and Send remain a separate human action", async () => {
  const [ui, webhook, generate, worker, engine] = await Promise.all([
    readFile(uiUrl, "utf8"),
    readFile(webhookUrl, "utf8"),
    readFile(generateUrl, "utf8"),
    readFile(workerUrl, "utf8"),
    readFile(engineUrl, "utf8"),
  ]);
  const generateDraftSource = functionSource(ui, "generateDraft", "holdDraft");
  const sendDraftStart = ui.indexOf("async function sendDraft(");
  const sendDraftEnd = ui.indexOf("\nroot.addEventListener(", sendDraftStart);
  assert.ok(sendDraftStart >= 0 && sendDraftEnd > sendDraftStart);
  const sendDraftSource = ui.slice(sendDraftStart, sendDraftEnd);

  for (const source of [webhook, generate, worker, engine, generateDraftSource]) {
    assert.doesNotMatch(source, /D360WhatsAppClient|MetaWhatsAppClient|\.sendText\s*\(/);
  }
  assert.match(generateDraftSource, /\/api\/command-centre\/reset-generate/);
  assert.doesNotMatch(generateDraftSource, /reset-message|action:\s*"send"|sendDraft\s*\(/);
  assert.match(sendDraftSource, /\/api\/command-centre\/reset-message/);
  assert.match(sendDraftSource, /action:\s*"send"/);
  assert.match(ui, /action === "generate"[\s\S]*generateDraft\(\)/);
  assert.match(ui, /action === "send"[\s\S]*sendDraft\(\)/);
  assert.doesNotMatch(ui, /preparing a new reply automatically/i);
});
