import { createClient } from "@supabase/supabase-js";

const EXPECTED_BRANCH = "feat/hera-ai-receptionist-foundation";
const PRICING_TEXT = "How much is your curly haircut";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function preview(value: unknown, max = 1200): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

if (process.env.VERCEL_ENV !== "preview") throw new Error("audit_requires_preview");
if (process.env.VERCEL_GIT_COMMIT_REF !== EXPECTED_BRANCH) {
  throw new Error("audit_requires_authoritative_staging_branch");
}
if (process.env.WHATSAPP_LIVE_CONFIRMATION === "ENABLE_HERA_WHATSAPP_LIVE") {
  throw new Error("audit_refuses_live_confirmation");
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "hera-pricing-backlog-audit" } },
});

const { data: pricingMessages, error: pricingMessageError } = await supabase
  .from("ai_messages")
  .select("id,conversation_id,text_body,created_at")
  .eq("direction", "inbound")
  .eq("text_body", PRICING_TEXT)
  .order("created_at", { ascending: false })
  .limit(5);
if (pricingMessageError) throw pricingMessageError;
if (!pricingMessages?.length) throw new Error("pricing_message_not_found");
const pricingMessage = pricingMessages[0];

const { data: decisions, error: decisionError } = await supabase
  .from("ai_decisions")
  .select("stage,model_id,output,created_at")
  .eq("source_message_id", pricingMessage.id)
  .order("created_at", { ascending: true });
if (decisionError) throw decisionError;
const responseDecision = (decisions ?? []).find((item) => item.stage === "response");
const policyDecision = (decisions ?? []).find((item) => item.stage === "policy");
const responseOutput = object(responseDecision?.output);
const responseDecisionBody = object(responseOutput.decision);
const responseSources = Array.isArray(responseDecisionBody.sources)
  ? responseDecisionBody.sources.map(object)
  : [];
const evidence = Array.isArray(responseOutput.evidence)
  ? responseOutput.evidence.map(object)
  : [];
const sourceIds = [...new Set(
  [...responseSources, ...evidence]
    .map((item) => item.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0),
)];

const allApprovedDocuments = await supabase
  .from("ai_knowledge_documents")
  .select("id,document_key,title,body,source_url,version,checksum,status,valid_from,valid_until,metadata,updated_at")
  .eq("status", "approved")
  .limit(500);
if (allApprovedDocuments.error) throw allApprovedDocuments.error;
const sourceDocuments = {
  data: (allApprovedDocuments.data ?? []).filter(
    (doc) => sourceIds.includes(String(doc.id)) || sourceIds.includes(String(doc.document_key)),
  ),
  error: null,
};

const { data: curlyPricingDocs, error: curlyPricingDocsError } = await supabase
  .from("ai_knowledge_documents")
  .select("id,document_key,title,body,source_url,version,checksum,status,valid_from,valid_until,metadata,updated_at")
  .eq("status", "approved")
  .or("title.ilike.%curly%,body.ilike.%curly%")
  .order("updated_at", { ascending: false })
  .limit(20);
if (curlyPricingDocsError) throw curlyPricingDocsError;

const policyOutput = object(policyDecision?.output);
console.log("HERA_PRICING_SOURCE_AUDIT", JSON.stringify({
  messageId: pricingMessage.id,
  responseModelId: responseDecision?.model_id ?? null,
  policyModelId: policyDecision?.model_id ?? null,
  decisionReply: preview(responseDecisionBody.reply),
  intent: responseDecisionBody.intent ?? null,
  factualBasis: responseDecisionBody.factualBasis ?? [],
  declaredSources: responseSources,
  retrievedEvidence: evidence.map((item) => ({
    id: item.id ?? null,
    title: item.title ?? null,
    excerpt: preview(item.excerpt ?? item.body, 1800),
    sourceUrl: item.sourceUrl ?? item.source_url ?? null,
    version: item.version ?? null,
    score: item.score ?? null,
  })),
  exactSourceDocuments: (sourceDocuments.data ?? []).map((doc) => ({
    id: doc.id,
    documentKey: doc.document_key,
    title: doc.title,
    body: preview(doc.body, 2600),
    sourceUrl: doc.source_url,
    version: doc.version,
    checksum: doc.checksum,
    status: doc.status,
    validFrom: doc.valid_from,
    validUntil: doc.valid_until,
    metadata: doc.metadata,
    updatedAt: doc.updated_at,
  })),
  approvedCurlyDocuments: (curlyPricingDocs ?? []).map((doc) => ({
    id: doc.id,
    documentKey: doc.document_key,
    title: doc.title,
    body: preview(doc.body, 2600),
    sourceUrl: doc.source_url,
    version: doc.version,
    checksum: doc.checksum,
    validFrom: doc.valid_from,
    validUntil: doc.valid_until,
    metadata: doc.metadata,
    updatedAt: doc.updated_at,
  })),
  finalReply: preview(policyOutput.finalReply),
  deliveryEligible: policyOutput.deliveryEligible === true,
}));

const { data: backlog, error: backlogError } = await supabase
  .from("ai_jobs")
  .select("id,source_message_id,status,attempts,max_attempts,available_at,locked_at,last_error,created_at,updated_at")
  .in("status", ["pending", "processing", "retry", "dead"])
  .order("created_at", { ascending: true })
  .limit(100);
if (backlogError) throw backlogError;
const sourceMessageIds = [...new Set((backlog ?? []).map((job) => job.source_message_id))];
const messageRows = sourceMessageIds.length
  ? await supabase
      .from("ai_messages")
      .select("id,conversation_id,contact_id,direction,kind,text_body,provider_timestamp,created_at")
      .in("id", sourceMessageIds)
  : { data: [], error: null };
if (messageRows.error) throw messageRows.error;
const messageById = new Map((messageRows.data ?? []).map((message) => [message.id, message]));
const contactIds = [...new Set((messageRows.data ?? []).map((message) => message.contact_id))];
const conversationIds = [...new Set((messageRows.data ?? []).map((message) => message.conversation_id))];
const [contacts, conversations] = await Promise.all([
  contactIds.length
    ? supabase.from("ai_contacts").select("id,wa_id,profile_name,last_seen_at").in("id", contactIds)
    : Promise.resolve({ data: [], error: null }),
  conversationIds.length
    ? supabase.from("ai_conversations").select("id,status,operating_mode,current_risk,last_message_at,updated_at").in("id", conversationIds)
    : Promise.resolve({ data: [], error: null }),
]);
if (contacts.error) throw contacts.error;
if (conversations.error) throw conversations.error;
const contactById = new Map((contacts.data ?? []).map((item) => [item.id, item]));
const conversationById = new Map((conversations.data ?? []).map((item) => [item.id, item]));

console.log("HERA_BACKLOG_AUDIT", JSON.stringify({
  jobs: (backlog ?? []).map((job) => {
    const message = messageById.get(job.source_message_id);
    const contact = message ? contactById.get(message.contact_id) : null;
    const conversation = message ? conversationById.get(message.conversation_id) : null;
    return {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      availableAt: job.available_at,
      lockedAt: job.locked_at,
      lastError: preview(job.last_error),
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      sourceMessage: message ? {
        id: message.id,
        direction: message.direction,
        kind: message.kind,
        text: preview(message.text_body),
        providerTimestamp: message.provider_timestamp,
        createdAt: message.created_at,
      } : null,
      contact: contact ? {
        phoneEnding: String(contact.wa_id).slice(-4),
        profileName: contact.profile_name,
        lastSeenAt: contact.last_seen_at,
      } : null,
      conversation: conversation ? {
        id: conversation.id,
        status: conversation.status,
        operatingMode: conversation.operating_mode,
        currentRisk: conversation.current_risk,
        lastMessageAt: conversation.last_message_at,
        updatedAt: conversation.updated_at,
      } : null,
    };
  }),
  databaseMutationAttempted: false,
  whatsappSendAttempted: false,
}));
