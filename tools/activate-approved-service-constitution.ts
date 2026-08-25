import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  getDatabaseConfig,
  getOperationsConfig,
  WHATSAPP_LIVE_CONFIRMATION_VALUE,
} from "../src/config.js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const EXPECTED_PROJECT_REF = "zjnbheohgwfzkmbnjqjr";
const DOCUMENT_KEY = "hera-service-constitution-2026-08-25.1";
const VERSION = "hera-service-constitution-2026-08-25.1";
const EFFECTIVE_AT = "2026-08-25T13:38:30.000Z";
const APPROVAL_RECORDED_AT = "2026-08-25T21:38:30+08:00";
const LEGACY_SENTENCE =
  "Service concerns should be raised within 7 working days of the appointment";

interface QueryError {
  code?: string;
  message?: string;
}

interface QueryResult<T> {
  data: T | null;
  error: QueryError | null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checked<T>(
  label: string,
  operation: () => PromiseLike<QueryResult<T>>,
): Promise<T> {
  let lastError: QueryError | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await operation();
    if (!result.error && result.data !== null) return result.data;
    lastError = result.error;
    if (result.error?.code !== "PGRST303" || attempt === 4) break;
    await sleep(attempt * 2_000);
  }
  throw new Error(`${label}_failed:${lastError?.code ?? "unknown"}`);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function main(): Promise<void> {
  if (process.env.VERCEL_ENV !== "preview") return;
  if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
    throw new Error("constitution_activation_requires_authoritative_preview_branch");
  }

  const operations = getOperationsConfig();
  if (operations.sendMode !== "shadow") {
    throw new Error("constitution_activation_requires_shadow_mode");
  }
  if (
    process.env.WHATSAPP_LIVE_CONFIRMATION ===
    WHATSAPP_LIVE_CONFIRMATION_VALUE
  ) {
    throw new Error("constitution_activation_refuses_live_confirmation");
  }

  const database = getDatabaseConfig();
  const databaseHost = new URL(database.url).hostname.toLowerCase();
  if (!databaseHost.startsWith(`${EXPECTED_PROJECT_REF}.`)) {
    throw new Error("constitution_activation_requires_isolated_staging_database");
  }

  const [body, machineSource] = await Promise.all([
    readFile(new URL("../docs/HERA_SERVICE_CONSTITUTION.md", import.meta.url), "utf8"),
    readFile(
      new URL("../governance/hera-service-constitution.json", import.meta.url),
      "utf8",
    ),
  ]);
  const machine = JSON.parse(machineSource) as {
    version?: string;
    status?: string;
    effectiveDate?: string;
    runtimeAuthoritative?: boolean;
    liveUseAllowed?: boolean;
    unresolvedPolicies?: unknown[];
    approvedBy?: { name?: string; role?: string };
    approvalRecordedAt?: string;
  };

  if (
    machine.version !== VERSION ||
    machine.status !== "approved_runtime_authoritative" ||
    machine.effectiveDate !== "2026-08-25" ||
    machine.runtimeAuthoritative !== true ||
    machine.liveUseAllowed !== false ||
    machine.approvedBy?.name !== "Neo Chin Chuan" ||
    machine.approvedBy?.role !== "Owner" ||
    machine.approvalRecordedAt !== APPROVAL_RECORDED_AT ||
    !Array.isArray(machine.unresolvedPolicies) ||
    machine.unresolvedPolicies.length !== 0
  ) {
    throw new Error("constitution_activation_source_contract_invalid");
  }

  const checksum = createHash("sha256").update(body).digest("hex");
  const client = createClient(database.url, database.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { "X-Client-Info": "hera-service-constitution-activation" },
    },
  });

  type LegacyRow = {
    id: string;
    document_key: string;
    title: string;
    version: string;
    metadata: Record<string, unknown> | null;
  };
  const legacyRows = await checked<LegacyRow[]>("legacy_policy_scan", () =>
    client
      .from("ai_knowledge_documents")
      .select("id,document_key,title,version,metadata")
      .eq("status", "approved")
      .ilike("body", `%${LEGACY_SENTENCE}%`),
  );
  if (legacyRows.length > 5) {
    throw new Error("constitution_activation_legacy_conflict_scope_too_large");
  }

  for (const legacy of legacyRows) {
    if (legacy.document_key === DOCUMENT_KEY) {
      throw new Error("constitution_activation_document_contains_legacy_policy");
    }
    const metadata = {
      ...(legacy.metadata ?? {}),
      supersededBy: DOCUMENT_KEY,
      supersededAt: new Date().toISOString(),
      supersededReason: "owner_approved_seven_calendar_day_policy",
    };
    const updated = await checked<Array<{ id: string }>>(
      "retire_legacy_policy",
      () =>
        client
          .from("ai_knowledge_documents")
          .update({ status: "retired", metadata })
          .eq("id", legacy.id)
          .eq("status", "approved")
          .select("id"),
    );
    if (updated.length !== 1) {
      throw new Error("constitution_activation_legacy_retirement_conflict");
    }
  }

  const documentPayload = {
    document_key: DOCUMENT_KEY,
    title: "HERA SERVICE CONSTITUTION — OWNER APPROVED",
    body,
    source_url: null,
    version: VERSION,
    checksum,
    status: "approved",
    valid_from: EFFECTIVE_AT,
    valid_until: null,
    metadata: {
      documentType: "hera_service_constitution",
      runtimeAuthoritative: true,
      liveUseAllowed: false,
      approvedBy: "Neo Chin Chuan",
      approverRole: "Owner",
      approvalRecordedAt: APPROVAL_RECORDED_AT,
      sourceFile: "docs/HERA_SERVICE_CONSTITUTION.md",
      machineReadableSource: "governance/hera-service-constitution.json",
      precedenceRank: 2,
    },
  };

  type DocumentRow = {
    id: string;
    document_key: string;
    title: string;
    version: string;
    checksum: string;
    status: string;
    valid_from: string | null;
    valid_until: string | null;
    metadata: Record<string, unknown> | null;
  };
  const document = await checked<DocumentRow>("constitution_upsert", () =>
    client
      .from("ai_knowledge_documents")
      .upsert(documentPayload, { onConflict: "document_key" })
      .select(
        "id,document_key,title,version,checksum,status,valid_from,valid_until,metadata",
      )
      .single(),
  );

  if (
    document.document_key !== DOCUMENT_KEY ||
    document.version !== VERSION ||
    document.checksum !== checksum ||
    document.status !== "approved" ||
    document.valid_until !== null ||
    document.metadata?.runtimeAuthoritative !== true ||
    document.metadata?.liveUseAllowed !== false
  ) {
    throw new Error("constitution_activation_database_verification_failed");
  }

  const remainingLegacy = await checked<Array<{ id: string }>>(
    "remaining_legacy_policy_scan",
    () =>
      client
        .from("ai_knowledge_documents")
        .select("id")
        .eq("status", "approved")
        .ilike("body", `%${LEGACY_SENTENCE}%`),
  );
  if (remainingLegacy.length !== 0) {
    throw new Error("constitution_activation_approved_legacy_policy_remains");
  }

  const existingAudit = await checked<Array<{ id: string }>>(
    "constitution_audit_lookup",
    () =>
      client
        .from("ai_audit_log")
        .select("id")
        .eq("event_type", "service_constitution_approved")
        .eq("target_type", "knowledge_document")
        .eq("target_id", DOCUMENT_KEY)
        .limit(1),
  );
  if (existingAudit.length === 0) {
    const auditRows = await checked<Array<{ id: string }>>(
      "constitution_audit_insert",
      () =>
        client
          .from("ai_audit_log")
          .insert({
            actor_type: "management",
            actor_id: "Neo Chin Chuan",
            event_type: "service_constitution_approved",
            target_type: "knowledge_document",
            target_id: DOCUMENT_KEY,
            details: {
              version: VERSION,
              effectiveDate: "2026-08-25",
              approvalRecordedAt: APPROVAL_RECORDED_AT,
              runtimeAuthoritative: true,
              liveUseAllowed: false,
              checksum,
            },
          })
          .select("id"),
    );
    if (auditRows.length !== 1) {
      throw new Error("constitution_activation_audit_insert_failed");
    }
  }

  console.log(
    "HERA_SERVICE_CONSTITUTION_ACTIVATION",
    JSON.stringify({
      branch: process.env.VERCEL_GIT_COMMIT_REF,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      projectRef: EXPECTED_PROJECT_REF,
      provider: process.env.WHATSAPP_PROVIDER ?? "meta",
      mode: operations.sendMode,
      liveConfirmationEnabled: false,
      documentKey: DOCUMENT_KEY,
      documentFingerprint: fingerprint(document.id),
      version: document.version,
      checksum,
      status: document.status,
      runtimeAuthoritative: true,
      liveUseAllowed: false,
      retiredLegacyDocuments: legacyRows.length,
      approvedLegacyDocumentsRemaining: 0,
      auditRecorded: true,
      whatsappProviderSendAttempted: false,
      productionTouched: false,
    }),
  );
}

await main();
