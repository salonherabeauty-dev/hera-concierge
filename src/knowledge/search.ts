import { HERA_KNOWLEDGE_BASE } from "../../api/concierge.js";
import type { ReceptionistRepository } from "../db/repository.js";
import {
  renderActionAuthorityPrompt,
} from "../governance/actionAuthority.js";
import {
  orderKnowledgeByAuthority,
} from "../governance/knowledgeAuthority.js";
import type { KnowledgeResult } from "../types.js";

interface KnowledgeSection {
  id: string;
  title: string;
  body: string;
}

const SERVICE_CONSTITUTION_VERSION = "hera-service-constitution-2026-08-25.1";
const ACTION_AUTHORITY_VERSION = "hera-action-authority-2026-08-25.1";
const OPERATOR_POLICY_VERSION = "hera-operator-policy-v3";
const APPROVED_KNOWLEDGE_VERSION = "hera-approved-v4";

export const HERA_OPERATOR_POLICIES = String.raw`
HERA OPERATOR-APPROVED POLICIES - VERSION 3
- If a client has waited more than 10 minutes beyond the agreed appointment time, Hera's stated service-recovery policy is a 10% discount. The AI may explain the policy and record the concern, but must not claim the discount has been applied to a bill unless a transaction system confirms it.
- If a strand test fails, do not proceed with bleach. Hair and client safety override the requested colour result and any sales objective.
- Published service prices are before 9% GST unless explicitly stated otherwise.
- Every colour service requires consultation, a clear quotation and client consent before work begins.

HERA OPERATOR-APPROVED SERVICE CONSTITUTION - VERSION 2026-08-25.1
- Owner approval: Neo Chin Chuan approved this constitution on 25 August 2026. It is runtime-authoritative for the receptionist, while live WhatsApp sending remains blocked until every remaining certification gate passes.
- Service concern and refinement window: seven calendar days from completion of the appointment.
- An eligible client receives a careful management review and a complimentary refinement only when the salon manager confirms that the concern relates to the original service and can be corrected safely.
- The refinement policy does not automatically guarantee a refund, compensation, a completely different result or an entirely new service.
- Within the seven-calendar-day policy, the salon manager may authorise an eligible complimentary refinement. Outside the standard period or in exceptional circumstances, approval is reserved to the managing director or owner.
- Timely is the booking source of truth. The AI collects the complete request and creates a receptionist task. A receptionist checks or updates Timely and confirms the verified outcome. The AI must never claim that an appointment was created, changed, cancelled or confirmed without a certified provider result or verified human outcome.
- The AI and receptionist have no refund or compensation authority. A salon manager may authorise a policy-based complimentary refinement and the stated 10% waiting-time recovery. Refunds, vouchers, compensation and outside-policy exceptions require the managing director or owner.
- Separate explicit consent is required for capturing photos or video and for publishing or using the material externally. Consent proof must be stored in an approved system. Withdrawal blocks future use and creates a privacy-officer review for material already published.
- A specialised complaint, refund, safety, privacy, legal or technical matter must never be reduced to a generic staff-handoff sentence. The exact reply must recognise the situation, identify the authorised owner and explain one useful next step without promising an unauthorised outcome.

HERA OPERATOR-APPROVED CURL SERVICE MATRIX - VERSION 2
- Hera offers specialist curly haircuts at both Tanglin Mall and Quayside Isle, Sentosa Cove.
- Curly services include curly haircuts, curl-defining and hydration care for waves, curls and coils, subject to consultation.
- A pure service-at-outlet question must be answered directly. Do not create a receptionist handoff unless the current client turn asks to book, check live availability, change an appointment or speak to a person.
- Do not claim a named stylist's live schedule or current atelier assignment without live confirmation.
- Curl-specialist guidance: Alina is Rëzocut-certified and known for curl architecture; Phoeve is REZO Cut and Cadō Academy certified; Irene is known for precision cutting and curl transformations.
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
  complaint: ["concern", "unhappy", "refund", "refinement"],
  concern: ["complaint", "refinement", "unhappy"],
  refund: ["complaint", "compensation", "financial"],
  consent: ["photo", "video", "privacy"],
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
  return (
    clean.length >= 4 &&
    clean.length <= 120 &&
    /^[A-Z0-9][A-Z0-9 &/(),:'’+.-]+$/.test(clean)
  );
}

function sectionVersion(section: KnowledgeSection): string {
  if (/SERVICE CONSTITUTION/i.test(section.title)) {
    return SERVICE_CONSTITUTION_VERSION;
  }
  if (section.title.startsWith("HERA OPERATOR-APPROVED")) {
    return OPERATOR_POLICY_VERSION;
  }
  return APPROVED_KNOWLEDGE_VERSION;
}

function actionAuthorityResult(): KnowledgeResult {
  return {
    id: ACTION_AUTHORITY_VERSION,
    title: "HERA ACTION AUTHORITY CONTRACTS",
    excerpt: renderActionAuthorityPrompt(),
    sourceUrl: null,
    version: ACTION_AUTHORITY_VERSION,
    score: 1,
  };
}

export function splitApprovedKnowledge(
  source = HERA_KNOWLEDGE_BASE,
): KnowledgeSection[] {
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

const SUPERSEDED_LEGACY_SECTION_TITLES = new Set([
  "SERVICE CONCERNS, COMPLAINTS AND REFUNDS",
]);

const STATIC_SECTIONS = [
  ...splitApprovedKnowledge(HERA_OPERATOR_POLICIES),
  ...splitApprovedKnowledge().filter(
    (section) => !SUPERSEDED_LEGACY_SECTION_TITLES.has(section.title),
  ),
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

export function searchStaticKnowledge(
  query: string,
  limit = 5,
): KnowledgeResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const normalizedQuery = query.toLowerCase().trim();

  return STATIC_SECTIONS.map((section) => {
    const title = section.title.toLowerCase();
    const body = section.body.toLowerCase();
    let score = normalizedQuery && body.includes(normalizedQuery) ? 12 : 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      const matches = body.match(
        new RegExp(
          `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "g",
        ),
      );
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
    .map(({ section, score }) => {
      const version = sectionVersion(section);
      return {
        id: section.id,
        title: section.title,
        excerpt: section.body.slice(0, 4500),
        sourceUrl:
          version === APPROVED_KNOWLEDGE_VERSION
            ? "https://www.herabeauty.sg/"
            : null,
        version,
        score,
      };
    });
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

  for (const result of [
    ...dynamicResults,
    ...staticResults,
    actionAuthorityResult(),
  ]) {
    const key = `${result.title.toLowerCase()}:${result.excerpt
      .slice(0, 120)
      .toLowerCase()}`;
    if (!merged.has(key)) merged.set(key, result);
  }

  return orderKnowledgeByAuthority([...merged.values()], limit);
}
