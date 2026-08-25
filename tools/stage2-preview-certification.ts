import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/stage-2-knowledge-action-authority";
const EXPECTED_PROJECT_REF = "zjnbheohgwfzkmbnjqjr";
const CONSTITUTION_KEY = "hera-service-constitution-2026-08-25.1";
const AUTHORITY_KEY = "hera-action-authority-catalog-2026-08-25.1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

if (process.env.VERCEL_ENV !== "preview") {
  throw new Error("stage2_probe_requires_preview");
}
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("stage2_probe_requires_certification_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") {
  throw new Error("stage2_probe_requires_shadow_mode");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("stage2_probe_refuses_live_confirmation");
}

const supabaseUrl = required("SUPABASE_URL");
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
if (projectRef !== EXPECTED_PROJECT_REF) {
  throw new Error("stage2_probe_requires_isolated_staging_database");
}

const supabase = createClient(
  supabaseUrl,
  required("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "X-Client-Info": "hera-stage2-preview-certification" } },
  },
);

const [healthResult, documentsResult, contractsResult, claimsResult, outboxResult, auditResult] =
  await Promise.all([
    supabase.rpc("ai_stage2_authority_health"),
    supabase
      .from("ai_knowledge_documents")
      .select("document_key,version,status,checksum,source_url,valid_from,valid_until,metadata")
      .order("status")
      .order("document_key"),
    supabase
      .from("ai_action_authority_contracts")
      .select("action_key,domain,authority,responsible_role,task_type,scope,external_mutation,idempotency_required,provider_confirmation_required,before_after_audit_required,reconciliation_required,status,version,constitution_version,effective_from,effective_until")
      .eq("status", "approved")
      .order("action_key"),
    supabase
      .from("ai_knowledge_claim_registry")
      .select("claim_key,domain,authority_document_key,authority_version,source_class,precedence_rank,status,effective_from,effective_until")
      .eq("status", "approved")
      .order("claim_key"),
    supabase
      .from("ai_outbox")
      .select("id,status,provider_message_id,target_type")
      .in("status", ["pending", "processing", "retry", "dead"]),
    supabase
      .from("ai_audit_log")
      .select("event_type,target_id,details,created_at")
      .in("event_type", [
        "stage2_dynamic_knowledge_inventory_certified",
        "stage2_action_authority_registry_activated",
        "stage2_knowledge_inventory_snapshot",
      ])
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

for (const [label, result] of [
  ["health", healthResult],
  ["documents", documentsResult],
  ["contracts", contractsResult],
  ["claims", claimsResult],
  ["outbox", outboxResult],
  ["audit", auditResult],
] as const) {
  if (result.error) throw new Error(`stage2_${label}_query_failed:${result.error.code}`);
}

const health = healthResult.data as Record<string, unknown> | null;
if (!health || health.healthy !== true) {
  throw new Error("stage2_authority_health_not_healthy");
}
if (health.expiredApprovedDocuments !== 0) {
  throw new Error("stage2_expired_approved_documents_present");
}
if (health.approvedLegacyWindowConflicts !== 0) {
  throw new Error("stage2_approved_legacy_conflict_present");
}
if (health.approvedActionContracts !== 25) {
  throw new Error("stage2_action_contract_count_mismatch");
}
if (health.approvedCanonicalClaims !== 9) {
  throw new Error("stage2_canonical_claim_count_mismatch");
}
if (health.constitutionPresent !== true || health.authorityCataloguePresent !== true) {
  throw new Error("stage2_authoritative_knowledge_missing");
}

const documents = documentsResult.data ?? [];
const approved = documents.filter((item) => item.status === "approved");
const invalidApproved = approved.filter(
  (item) =>
    !item.document_key ||
    !item.version ||
    !item.checksum ||
    (item.valid_until && Date.parse(item.valid_until) <= Date.now()) ||
    (item.source_url && !item.source_url.startsWith("https://")),
);
if (invalidApproved.length > 0) {
  throw new Error("stage2_invalid_approved_document_present");
}
if (!approved.some((item) => item.document_key === CONSTITUTION_KEY)) {
  throw new Error("stage2_constitution_document_missing");
}
if (!approved.some((item) => item.document_key === AUTHORITY_KEY)) {
  throw new Error("stage2_authority_document_missing");
}

const contracts = contractsResult.data ?? [];
if (contracts.length !== 25) throw new Error("stage2_contract_inventory_mismatch");
if (
  contracts.some(
    (item) =>
      item.external_mutation &&
      !(
        item.idempotency_required &&
        item.provider_confirmation_required &&
        item.before_after_audit_required &&
        item.reconciliation_required
      ),
  )
) {
  throw new Error("stage2_external_mutation_without_full_controls");
}
if (
  contracts.some(
    (item) =>
      item.authority === "human_required" &&
      (!item.responsible_role || !item.task_type),
  )
) {
  throw new Error("stage2_human_action_without_owner_or_task");
}

const bookingWrites = new Set([
  "quote_live_availability",
  "create_booking",
  "reschedule_booking",
  "cancel_booking",
  "confirm_booking_outcome",
]);
if (
  contracts.some(
    (item) => bookingWrites.has(item.action_key) && item.authority !== "human_required",
  )
) {
  throw new Error("stage2_booking_write_authority_broadened");
}

const financial = new Set(["approve_refund", "approve_voucher", "approve_compensation"]);
if (
  contracts.some(
    (item) =>
      financial.has(item.action_key) &&
      (item.authority !== "human_required" ||
        item.responsible_role !== "managing_director_or_owner"),
  )
) {
  throw new Error("stage2_financial_authority_broadened");
}

const providerSend = contracts.find(
  (item) => item.action_key === "send_ai_generated_whatsapp_reply",
);
if (!providerSend || providerSend.authority !== "prohibited") {
  throw new Error("stage2_provider_send_not_locked");
}

const claims = claimsResult.data ?? [];
if (claims.length !== 9) throw new Error("stage2_claim_inventory_mismatch");
if (
  claims.some(
    (item) =>
      item.authority_document_key !== CONSTITUTION_KEY ||
      item.authority_version !== CONSTITUTION_KEY ||
      item.status !== "approved",
  )
) {
  throw new Error("stage2_claim_without_constitution_authority");
}

const activeOutbox = outboxResult.data ?? [];
if (activeOutbox.length > 0) {
  throw new Error("stage2_active_or_dead_outbox_present");
}
if ((auditResult.data ?? []).length < 3) {
  throw new Error("stage2_required_audit_events_missing");
}

const countsByAuthority = Object.fromEntries(
  ["read_only", "ai_authorised_no_external_side_effect", "human_required", "prohibited"].map(
    (authority) => [
      authority,
      contracts.filter((item) => item.authority === authority).length,
    ],
  ),
);

console.log(
  "HERA_STAGE2_AUTHORITY_CERTIFICATION",
  JSON.stringify({
    branch: process.env.VERCEL_GIT_COMMIT_REF,
    commit: process.env.VERCEL_GIT_COMMIT_SHA,
    deploymentUrl: process.env.VERCEL_URL,
    databaseProjectRef: projectRef,
    provider: process.env.WHATSAPP_PROVIDER,
    mode: process.env.WHATSAPP_SEND_MODE,
    liveConfirmationEnabled: false,
    health,
    knowledge: {
      totalDocuments: documents.length,
      approvedDocuments: approved.length,
      draftDocuments: documents.filter((item) => item.status === "draft").length,
      retiredDocuments: documents.filter((item) => item.status === "retired").length,
      invalidApprovedDocuments: invalidApproved.length,
      constitutionPresent: true,
      authorityCataloguePresent: true,
    },
    actions: {
      contracts: contracts.length,
      countsByAuthority,
      externalMutationsWithoutFullControls: 0,
      bookingWritesHumanRequired: true,
      financialAuthorityRestricted: true,
      providerSendProhibited: true,
    },
    canonicalClaims: claims.length,
    activeOrDeadOutbox: activeOutbox.length,
    auditEvents: (auditResult.data ?? []).length,
    databaseMutationAttempted: false,
    whatsappProviderSendAttempted: false,
    productionTouched: false,
  }),
);
