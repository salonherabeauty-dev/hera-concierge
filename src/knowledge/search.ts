import { HERA_KNOWLEDGE_BASE } from "../../api/concierge.js";
import type { ReceptionistRepository } from "../db/repository.js";
import type { KnowledgeResult } from "../types.js";

interface KnowledgeSection {
  id: string;
  title: string;
  body: string;
}

export const HERA_OPERATOR_POLICIES = String.raw`
HERA OPERATOR-APPROVED POLICIES - VERSION 1
- If a client has waited more than 10 minutes beyond the agreed appointment time, Hera's stated service-recovery policy is a 10% discount. The AI may explain the policy and record the concern, but must not claim the discount has been applied to a bill unless a transaction system confirms it.
- If a strand test fails, do not proceed with bleach. Hair and client safety override the requested colour result and any sales objective.
- Published service prices are before 9% GST unless explicitly stated otherwise.
- Every colour service requires consultation, a clear quotation and client consent before work begins.
`;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "to",
  "what",
  "with",
  "you",
]);

const SYNONYMS: Record<string, string[]> = {
  color: ["colour"],
  colour: ["color"],
  dye: ["colour", "color"],
  straighten: ["keratin", "rebonding", "smoothing"],
  curls: ["curly", "curl"],
  curly: ["curls", "curl"],
  bleach: ["lightening", "blonde"],
  complaint: ["concern", "unhappy", "refund"],
  cost: ["price", "pricing"],
  price: ["cost", "pricing"],
  appointment: ["booking", "book"],
  booking: ["appointment", "book"],
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function isHeading(line: string): boolean {
  const clean = line.trim();
  return clean.length >= 4 && clean.length <= 120 && /^[A-Z0-9][A-Z0-9 &/(),:'’+.-]+$/.test(clean);
}

export function splitApprovedKnowledge(source = HERA_KNOWLEDGE_BASE): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let title = "Hera approved knowledge";
  let lines: string[] = [];

  const flush = () => {
    const body = lines.join("\n").trim();
    if (body) {
      sections.push({
        id: `hera-kb-v4:${slug(title) || sections.length}`,
        title,
        body,
      });
    }
    lines = [];
  };

  for (const line of source.split("\n")) {
    if (isHeading(line)) {
      flush();
      title = line.trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

const STATIC_SECTIONS = [
  ...splitApprovedKnowledge(HERA_OPERATOR_POLICIES),
  ...splitApprovedKnowledge(),
];

function queryTerms(query: string): string[] {
  const base = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  return [...new Set(base.flatMap((term) => [term, ...(SYNONYMS[term] ?? [])]))];
}

export function searchStaticKnowledge(query: string, limit = 5): KnowledgeResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const normalizedQuery = query.toLowerCase().trim();

  return STATIC_SECTIONS.map((section) => {
    const title = section.title.toLowerCase();
    const body = section.body.toLowerCase();
    let score = normalizedQuery && body.includes(normalizedQuery) ? 12 : 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      const matches = body.match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
      score += Math.min(matches?.length ?? 0, 8);
    }
    if (score > 0 && section.title.startsWith("HERA OPERATOR-APPROVED")) {
      score += 50;
    }
    return { section, score };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(limit, 8)))
    .map(({ section, score }) => ({
      id: section.id,
      title: section.title,
      excerpt: section.body.slice(0, 4500),
      sourceUrl: section.title.startsWith("HERA OPERATOR-APPROVED")
        ? null
        : "https://www.herabeauty.sg/",
      version: section.title.startsWith("HERA OPERATOR-APPROVED")
        ? "hera-operator-policy-v1"
        : "hera-approved-v4",
      score,
    }));
}

export async function searchAllKnowledge(
  repository: ReceptionistRepository,
  query: string,
  limit = 6,
): Promise<KnowledgeResult[]> {
  const staticResults = searchStaticKnowledge(query, limit);
  const dynamicResults = await repository
    .searchApprovedKnowledge(query, limit)
    .catch(() => [] as KnowledgeResult[]);
  const merged = new Map<string, KnowledgeResult>();
  for (const result of [...dynamicResults, ...staticResults]) {
    const key = `${result.title.toLowerCase()}:${result.excerpt.slice(0, 120).toLowerCase()}`;
    if (!merged.has(key)) merged.set(key, result);
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
