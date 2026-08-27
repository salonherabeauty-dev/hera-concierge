import type { KnowledgeResult } from "../types.js";

export const KNOWLEDGE_AUTHORITY_VERSION = "hera-knowledge-authority-2026-08-25.1";
export const OWNER_SERVICE_PRICE_EXPERTISE_VERSION =
  "hera-service-price-expertise-master-v1.2-2026-08-27";

const APPROVED_CONSTITUTION_VERSION = "hera-service-constitution-2026-08-25.1";
const ACTION_AUTHORITY_VERSION = "hera-action-authority-2026-08-25.1";
const OPERATOR_POLICY_VERSION = "hera-operator-policy-v3";
const APPROVED_KNOWLEDGE_VERSION = "hera-approved-v4";

const LEGACY_CONFLICT_PATTERNS = [
  /\b7\s+working\s+days\b/i,
  /\bautomatic\s+(?:refund|redo|compensation)\b/i,
  /\bconsent\s+(?:is|was)\s+assumed\b/i,
] as const;

export function isBlockedLegacyKnowledge(result: KnowledgeResult): boolean {
  if (result.version === APPROVED_CONSTITUTION_VERSION) return false;
  return LEGACY_CONFLICT_PATTERNS.some((pattern) =>
    pattern.test(`${result.title}\n${result.excerpt}`),
  );
}

export function knowledgeAuthorityRank(result: KnowledgeResult): number {
  if (result.version === APPROVED_CONSTITUTION_VERSION) return 700;
  if (result.version === ACTION_AUTHORITY_VERSION) return 650;
  if (result.version === OPERATOR_POLICY_VERSION) return 600;
  if (result.version === OWNER_SERVICE_PRICE_EXPERTISE_VERSION) return 550;
  if (/^hera-operator-policy-v\d+$/i.test(result.version)) return 500;
  if (result.version === APPROVED_KNOWLEDGE_VERSION) return 300;
  if (
    result.sourceUrl?.startsWith("https://www.herabeauty.sg/") ||
    result.sourceUrl?.startsWith("https://herabeauty.sg/")
  ) {
    return 200;
  }
  return 100;
}

export function orderKnowledgeByAuthority(
  results: readonly KnowledgeResult[],
  limit: number,
): KnowledgeResult[] {
  const unique = new Map<string, KnowledgeResult>();

  for (const result of results) {
    if (isBlockedLegacyKnowledge(result)) continue;
    const key = `${result.title.toLowerCase()}:${result.excerpt
      .slice(0, 160)
      .toLowerCase()}`;
    const existing = unique.get(key);
    if (!existing || knowledgeAuthorityRank(result) > knowledgeAuthorityRank(existing)) {
      unique.set(key, result);
    }
  }

  return [...unique.values()]
    .sort((left, right) => {
      const authorityDifference =
        knowledgeAuthorityRank(right) - knowledgeAuthorityRank(left);
      if (authorityDifference !== 0) return authorityDifference;
      return right.score - left.score;
    })
    .slice(0, Math.max(1, Math.min(limit, 8)));
}
