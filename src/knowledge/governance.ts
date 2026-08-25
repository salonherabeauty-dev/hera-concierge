import { createHash } from "node:crypto";
import type { KnowledgeResult } from "../types.js";

export const KNOWLEDGE_GOVERNANCE_VERSION =
  "hera-knowledge-governance-2026-08-25.1";
export const APPROVED_CONSTITUTION_VERSION =
  "hera-service-constitution-2026-08-25.1";

export type KnowledgeSourceClass =
  | "approved_service_constitution"
  | "signed_operator_policy"
  | "approved_dynamic_knowledge"
  | "embedded_approved_knowledge"
  | "approved_website_snapshot"
  | "untrusted";

export interface KnowledgeSourceAssessment {
  allowed: boolean;
  sourceClass: KnowledgeSourceClass;
  authorityRank: number;
  reasons: string[];
  contentFingerprint: string;
}

const ALLOWED_HERA_HOSTS = new Set(["herabeauty.sg", "www.herabeauty.sg"]);
const SUPERSEDED_PATTERNS = [/\b7\s+working\s+days?\b/i];
const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "can",
  "do",
  "does",
  "for",
  "from",
  "hera",
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
  "service",
  "the",
  "to",
  "what",
  "with",
  "you",
  "your",
]);

function sourceHost(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "invalid";
    return url.hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}

export function knowledgeContentFingerprint(
  result: Pick<KnowledgeResult, "title" | "excerpt" | "version">,
): string {
  return createHash("sha256")
    .update(`${result.version}\n${result.title}\n${result.excerpt}`)
    .digest("hex")
    .slice(0, 16);
}

export function assessKnowledgeSource(
  result: KnowledgeResult,
): KnowledgeSourceAssessment {
  const reasons: string[] = [];
  const host = sourceHost(result.sourceUrl);
  const title = result.title.trim();
  const excerpt = result.excerpt.trim();
  const version = result.version.trim();
  const contentFingerprint = knowledgeContentFingerprint(result);

  if (!result.id.trim() || !title || !excerpt || !version) {
    reasons.push("incomplete_source_identity");
  }
  if (SUPERSEDED_PATTERNS.some((pattern) => pattern.test(excerpt))) {
    reasons.push("superseded_policy_claim");
  }
  if (host === "invalid") reasons.push("invalid_source_url");
  if (host && !ALLOWED_HERA_HOSTS.has(host)) {
    reasons.push("untrusted_source_host");
  }

  let sourceClass: KnowledgeSourceClass = "untrusted";
  let authorityRank = 0;

  if (
    version === APPROVED_CONSTITUTION_VERSION ||
    result.id === APPROVED_CONSTITUTION_VERSION ||
    /SERVICE CONSTITUTION/i.test(title)
  ) {
    sourceClass = "approved_service_constitution";
    authorityRank = 900;
  } else if (version.startsWith("hera-operator-policy-")) {
    sourceClass = "signed_operator_policy";
    authorityRank = 800;
  } else if (
    version === "hera-approved-v4" &&
    result.id.startsWith("hera-kb-v4:") &&
    host !== "invalid" &&
    host !== null &&
    ALLOWED_HERA_HOSTS.has(host)
  ) {
    sourceClass = "embedded_approved_knowledge";
    authorityRank = 600;
  } else if (
    host !== "invalid" &&
    host !== null &&
    ALLOWED_HERA_HOSTS.has(host)
  ) {
    sourceClass = "approved_website_snapshot";
    authorityRank = 500;
  } else if (
    host === null &&
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(result.id) &&
    version.length >= 3
  ) {
    // The database search function exposes only approved, effective and
    // unexpired records. Null-source internal records remain below the
    // constitution and signed operator policy unless explicitly classified.
    sourceClass = "approved_dynamic_knowledge";
    authorityRank = 700;
  }

  if (sourceClass === "untrusted") reasons.push("unknown_source_class");

  return {
    allowed: reasons.length === 0 && sourceClass !== "untrusted",
    sourceClass,
    authorityRank,
    reasons,
    contentFingerprint,
  };
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term)),
    ),
  ];
}

function countTerm(text: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0;
}

function relevanceScore(query: string, result: KnowledgeResult): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const title = result.title.toLowerCase();
  const excerpt = result.excerpt.toLowerCase();
  const phrase = query.toLowerCase().trim();
  let score = phrase.length >= 4 && excerpt.includes(phrase) ? 80 : 0;

  let matchedTerms = 0;
  for (const term of terms) {
    const titleMatches = countTerm(title, term);
    const excerptMatches = countTerm(excerpt, term);
    if (titleMatches + excerptMatches > 0) matchedTerms += 1;
    score += Math.min(titleMatches, 2) * 12;
    score += Math.min(excerptMatches, 6) * 3;
  }

  if (matchedTerms === terms.length) score += 20;
  score += Math.round((matchedTerms / terms.length) * 20);
  return score;
}

function semanticDedupeKey(result: KnowledgeResult): string {
  if (/SERVICE CONSTITUTION/i.test(result.title)) return "policy:service-constitution";
  return `${result.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${knowledgeContentFingerprint(result)}`;
}

export function governKnowledgeResults(
  query: string,
  results: KnowledgeResult[],
  limit: number,
): KnowledgeResult[] {
  const assessed = results
    .map((result) => {
      const source = assessKnowledgeSource(result);
      const relevance = relevanceScore(query, result);
      return {
        result,
        source,
        relevance,
        combinedScore: relevance * 1000 + source.authorityRank,
      };
    })
    .filter((item) => item.source.allowed && item.relevance > 0)
    .sort(
      (left, right) =>
        right.combinedScore - left.combinedScore ||
        left.result.id.localeCompare(right.result.id),
    );

  const deduped = new Map<string, (typeof assessed)[number]>();
  for (const item of assessed) {
    const key = semanticDedupeKey(item.result);
    const current = deduped.get(key);
    if (!current || item.combinedScore > current.combinedScore) {
      deduped.set(key, item);
    }
  }

  return [...deduped.values()]
    .sort(
      (left, right) =>
        right.combinedScore - left.combinedScore ||
        left.result.id.localeCompare(right.result.id),
    )
    .slice(0, Math.max(1, Math.min(limit, 8)))
    .map((item) => ({
      ...item.result,
      score: item.combinedScore,
    }));
}
