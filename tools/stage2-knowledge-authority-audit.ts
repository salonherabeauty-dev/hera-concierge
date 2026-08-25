import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getDatabaseConfig } from "../src/config.js";
import { SupabaseReceptionistRepository } from "../src/db/repository.js";
import { searchAllKnowledge } from "../src/knowledge/search.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const EXPECTED_PROJECT_REF = "zjnbheohgwfzkmbnjqjr";
const CONSTITUTION_VERSION = "hera-service-constitution-2026-08-25.1";

function fingerprint(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function projectRef(urlValue: string): string | null {
  try {
    const host = new URL(urlValue).hostname;
    return host.endsWith(".supabase.co") ? host.slice(0, -".supabase.co".length) : null;
  } catch {
    return null;
  }
}

function sourceHost(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "invalid_url";
  }
}

function metadataKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function claimFlags(bodyValue: unknown): string[] {
  const body = typeof bodyValue === "string" ? bodyValue : "";
  const flags: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["seven_working_days", /7\s+working\s+days?/i],
    ["seven_calendar_days", /7\s+calendar\s+days?/i],
    ["booking_write_or_confirmation", /(?:booked|confirmed|rescheduled|cancelled).{0,80}(?:appointment|booking)|(?:appointment|booking).{0,80}(?:booked|confirmed|rescheduled|cancelled)/i],
    ["refund_or_compensation", /refund|compensation|voucher|credit/i],
    ["photo_video_consent", /photo|video|consent|publication/i],
    ["live_availability", /live availability|same-day slot|available today/i],
    ["pricing", /\$\s?\d|price|pricing/i],
    ["gst", /\b9%\s*gst\b|before gst|inclusive gst/i],
    ["medical_or_safety", /medical|breathing difficulty|burn|allergy|severe swelling/i],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(body)) flags.push(name);
  }
  return flags;
}

function validState(input: {
  status: string;
  valid_from: string | null;
  valid_until: string | null;
}): string {
  const now = Date.now();
  const from = input.valid_from ? Date.parse(input.valid_from) : null;
  const until = input.valid_until ? Date.parse(input.valid_until) : null;
  if (input.status !== "approved") return input.status;
  if (from !== null && Number.isFinite(from) && from > now) return "approved_future";
  if (until !== null && Number.isFinite(until) && until <= now) return "approved_expired";
  return "approved_current";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("stage2_audit_requires_authoritative_preview_branch");
  }
  const sendMode = process.env.WHATSAPP_SEND_MODE?.trim() || "shadow";
  if (sendMode !== "shadow") throw new Error("stage2_audit_requires_shadow_mode");
  if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
    throw new Error("stage2_audit_refuses_live_confirmation");
  }

  const database = getDatabaseConfig();
  if (projectRef(database.url) !== EXPECTED_PROJECT_REF) {
    throw new Error("stage2_audit_requires_isolated_staging_project");
  }

  // Vercel build workers can briefly lead Supabase's JWT clock. Waiting avoids
  // treating a transient infrastructure skew as a knowledge-governance failure.
  await sleep(8_000);

  const client = createClient(database.url, database.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage2-knowledge-audit" } },
  });

  const [documentsResult, auditResult] = await Promise.all([
    client
      .from("ai_knowledge_documents")
      .select("id,document_key,title,body,source_url,version,checksum,status,valid_from,valid_until,metadata,created_at,updated_at")
      .order("status", { ascending: true })
      .order("document_key", { ascending: true }),
    client
      .from("ai_audit_log")
      .select("event_type,target_type,target_id,details,created_at")
      .eq("event_type", "service_constitution_approved")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  if (documentsResult.error) throw documentsResult.error;
  if (auditResult.error) throw auditResult.error;

  const documents = documentsResult.data ?? [];
  const inventory = documents.map((document) => ({
    idFingerprint: fingerprint(document.id),
    documentKey: document.document_key,
    title: document.title,
    version: document.version,
    status: document.status,
    validState: validState(document),
    sourceHost: sourceHost(document.source_url),
    sourceUrlFingerprint: fingerprint(document.source_url),
    checksum: document.checksum,
    bodyFingerprint: fingerprint(document.body),
    bodyLength: typeof document.body === "string" ? document.body.length : 0,
    claimFlags: claimFlags(document.body),
    metadataKeys: metadataKeys(document.metadata),
    createdAt: document.created_at,
    updatedAt: document.updated_at,
  }));

  const approved = inventory.filter((item) => item.status === "approved");
  const currentApproved = approved.filter((item) => item.validState === "approved_current");
  const constitution = currentApproved.filter(
    (item) => item.documentKey === CONSTITUTION_VERSION && item.version === CONSTITUTION_VERSION,
  );
  const approvedLegacyConflict = approved.filter((item) =>
    item.claimFlags.includes("seven_working_days"),
  );
  const approvedUntrustedHost = approved.filter(
    (item) => item.sourceHost && !["www.herabeauty.sg", "herabeauty.sg"].includes(item.sourceHost),
  );

  const repository = new SupabaseReceptionistRepository(database.url, database.serviceRoleKey);
  const queries = [
    "service concern refinement seven calendar days",
    "curly haircut price",
    "Tanglin Mall opening hours",
    "book change cancel appointment authority",
    "photo video consent withdrawal",
    "refund compensation authority",
  ];
  const retrieval = [] as Array<{
    query: string;
    results: Array<{
      id: string;
      title: string;
      version: string;
      score: number;
      sourceHost: string | null;
    }>;
  }>;
  for (const query of queries) {
    const results = await searchAllKnowledge(repository, query, 8);
    retrieval.push({
      query,
      results: results.map((result) => ({
        id: result.id,
        title: result.title,
        version: result.version,
        score: result.score,
        sourceHost: sourceHost(result.sourceUrl),
      })),
    });
  }

  console.log(
    "HERA_STAGE2_KNOWLEDGE_INVENTORY",
    JSON.stringify({
      branch: process.env.VERCEL_GIT_COMMIT_REF,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      projectRef: projectRef(database.url),
      mode: sendMode,
      liveConfirmationEnabled:
        process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE",
      summary: {
        totalDocuments: inventory.length,
        approvedDocuments: approved.length,
        currentApprovedDocuments: currentApproved.length,
        draftDocuments: inventory.filter((item) => item.status === "draft").length,
        retiredDocuments: inventory.filter((item) => item.status === "retired").length,
        approvedExpiredOrFuture: approved.filter((item) => item.validState !== "approved_current").length,
        approvedLegacySevenWorkingDayDocuments: approvedLegacyConflict.length,
        approvedUntrustedHostDocuments: approvedUntrustedHost.length,
        exactApprovedConstitutionRecords: constitution.length,
        constitutionApprovalAuditRecords: (auditResult.data ?? []).length,
      },
      documents: inventory,
      retrieval,
      databaseMutationAttempted: false,
      whatsappProviderSendAttempted: false,
      productionTouched: false,
    }),
  );
}

await main();
