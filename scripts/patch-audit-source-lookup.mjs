import { readFile, writeFile } from "node:fs/promises";

const path = new URL("./audit-pricing-backlog.ts", import.meta.url);
let source = await readFile(path, "utf8");
const from = `const sourceDocuments = sourceIds.length
  ? await supabase
      .from("ai_knowledge_documents")
      .select("id,document_key,title,body,source_url,version,checksum,status,valid_from,valid_until,metadata,updated_at")
      .in("id", sourceIds)
  : { data: [], error: null };
if (sourceDocuments.error) throw sourceDocuments.error;
`;
const to = `const allApprovedDocuments = await supabase
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
`;
if (!source.includes(from)) throw new Error("audit source lookup anchor missing");
source = source.replace(from, to);
await writeFile(path, source);
