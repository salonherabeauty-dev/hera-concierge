import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const TARGET_MESSAGE_ID = "3a64e356-310e-4126-88aa-ec356fd6a8d5";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeText(value: unknown, max = 1600): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("audit_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("audit_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_SEND_MODE !== "shadow") throw new Error("audit_requires_shadow_mode");
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("audit_refuses_live_confirmation");
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-pricing-evidence-audit" } },
});

const { data: responseDecision, error: decisionError } = await supabase
  .from("ai_decisions")
  .select("id,model_id,prompt_version,policy_version,output,created_at")
  .eq("source_message_id", TARGET_MESSAGE_ID)
  .eq("stage", "response")
  .single();
if (decisionError) throw decisionError;
assert(responseDecision, "response_decision_not_found");
const output = record(responseDecision.output);
const decision = record(output?.decision);
const evidence = Array.isArray(output?.evidence) ? output.evidence : [];
const sources = Array.isArray(decision?.sources) ? decision.sources : [];
const sourceIds = sources
  .map((source) => record(source)?.id)
  .filter((id): id is string => typeof id === "string" && Boolean(id));

const { data: documents, error: documentError } = sourceIds.length
  ? await supabase
      .from("ai_knowledge_documents")
      .select("id,document_key,title,body,source_url,version,status,valid_from,valid_until,metadata,updated_at")
      .in("id", sourceIds)
  : { data: [], error: null };
if (documentError) throw documentError;

const { data: curlyDocuments, error: curlyError } = await supabase
  .from("ai_knowledge_documents")
  .select("id,document_key,title,body,source_url,version,status,valid_from,valid_until,metadata,updated_at")
  .eq("status", "approved")
  .ilike("body", "%curly%")
  .order("updated_at", { ascending: false })
  .limit(20);
if (curlyError) throw curlyError;

const now = Date.now();
const mappedDocuments = (documents ?? []).map((document) => ({
  id: document.id,
  documentKey: document.document_key,
  title: document.title,
  sourceUrl: document.source_url,
  version: document.version,
  status: document.status,
  validFrom: document.valid_from,
  validUntil: document.valid_until,
  expired:
    typeof document.valid_until === "string" &&
    Date.parse(document.valid_until) < now,
  updatedAt: document.updated_at,
  metadata: document.metadata,
  bodyExcerpt: safeText(document.body, 2200),
}));

console.log(
  "HERA_PRICING_EVIDENCE_AUDIT",
  JSON.stringify({
    modelId: responseDecision.model_id,
    promptVersion: responseDecision.prompt_version,
    policyVersion: responseDecision.policy_version,
    decisionCreatedAt: responseDecision.created_at,
    intent: decision?.intent ?? null,
    reply: safeText(decision?.reply, 1200),
    sources,
    evidence,
    sourceDocuments: mappedDocuments,
    approvedCurlyDocuments: (curlyDocuments ?? []).map((document) => ({
      id: document.id,
      documentKey: document.document_key,
      title: document.title,
      sourceUrl: document.source_url,
      version: document.version,
      validFrom: document.valid_from,
      validUntil: document.valid_until,
      updatedAt: document.updated_at,
      bodyExcerpt: safeText(document.body, 1800),
    })),
    databaseMutationAttempted: false,
    whatsappSendAttempted: false,
  }),
);
