import {
  isBlockedLegacyKnowledge,
  knowledgeAuthorityRank,
} from "../governance/knowledgeAuthority.js";
import { searchAllKnowledge } from "../knowledge/search.js";
import type { ReceptionistRepository } from "../db/repository.js";
import type { BookingSummary, KnowledgeResult } from "../types.js";
import type { ResetEvidencePacket } from "./types.js";

const RESET_EVIDENCE_LIMIT = 24;
const RESET_QUERY_LIMIT = 16;

const STAFF_NAMES = [
  "Adam",
  "Aleksandra",
  "Alina",
  "Andy",
  "Anna",
  "Cris",
  "Gabriela",
  "Ilze",
  "Irene",
  "Johnny",
  "Kezlin",
  "Monica",
  "Phoeve",
  "Rujean",
  "Tamson",
] as const;

interface TopicRule {
  match: RegExp;
  queries: string[];
}

const TOPIC_RULES: TopicRule[] = [
  {
    match: /\b(?:curl|curls|curly|wavy|wave|coily|coil|rezo|rëzo|cado|cadō)\b/i,
    queries: ["curly hair", "curl hydration", "curly specialist"],
  },
  {
    match: /\b(?:blonde|blond|blonding|highlight|highlights|airtou?ch|air touch)\b/i,
    queries: ["blonding", "highlights", "AirTouch"],
  },
  { match: /\bbalayage\b/i, queries: ["balayage"] },
  {
    match: /\b(?:grey|gray|salt and pepper|salt-and-pepper)\b/i,
    queries: ["grey blending", "salt and pepper"],
  },
  {
    match: /\b(?:extension|extensions|tape-in|tape in|weft|keratin bond|nano ring|micro ring|clip-in)\b/i,
    queries: ["hair extensions", "tape-in", "keratin bond", "weft"],
  },
  {
    match: /\b(?:colour correction|color correction|corrective colour|corrective color)\b/i,
    queries: ["colour correction"],
  },
  {
    match: /\b(?:keratin|smoothing|rebonding|straighten|straightening)\b/i,
    queries: ["keratin", "rebonding", "smoothing"],
  },
  { match: /\b(?:perm|perming|spiral perm)\b/i, queries: ["perm"] },
  {
    match: /\b(?:treatment|k18|olaplex|hydration|hair spa|scalp spa)\b/i,
    queries: ["hair treatment", "K18", "Olaplex", "hydration"],
  },
  {
    match: /\b(?:manicure|pedicure|nail|nails|gel manicure|gel pedicure)\b/i,
    queries: ["manicure", "pedicure", "nail artist"],
  },
  {
    match: /\b(?:complaint|unhappy|dissatisfied|refund|compensation|sue|lawyer|legal|injury|damage)\b/i,
    queries: ["service concern", "refund", "complaint"],
  },
  {
    match: /\b(?:strand test|patch test|bleach|henna)\b/i,
    queries: ["strand test", "patch test", "bleach"],
  },
  { match: /\b(?:waited|waiting|late|delay)\b/i, queries: ["waiting time"] },
  {
    match: /\b(?:photo|video|consent|privacy|delete my data|pdpa)\b/i,
    queries: ["photo consent", "privacy"],
  },
  {
    match: /\b(?:book|booking|appointment|reschedule|rebook|cancel|availability|available|slot)\b/i,
    queries: ["booking authority"],
  },
];

function hasExplicitSentosaQuestion(text: string): boolean {
  return /\b(?:Sentosa|Quayside(?: Isle)?|Sentosa Cove)\b/i.test(text);
}

function isSentosaOnly(result: KnowledgeResult): boolean {
  const body = `${result.title}\n${result.excerpt}`;
  const explicitlySentosa = /\b(?:Sentosa Cove|Quayside Isle)\b/i.test(body);
  const supportsTanglin = /\b(?:Tanglin Mall|Both)\b/i.test(body);
  return explicitlySentosa && !supportsTanglin;
}

function orderResetEvidence(results: KnowledgeResult[]): KnowledgeResult[] {
  const unique = new Map<string, KnowledgeResult>();
  for (const result of results) {
    if (isBlockedLegacyKnowledge(result)) continue;
    const key = result.id || `${result.title}:${result.version}`;
    const current = unique.get(key);
    if (
      !current ||
      knowledgeAuthorityRank(result) > knowledgeAuthorityRank(current) ||
      (knowledgeAuthorityRank(result) === knowledgeAuthorityRank(current) &&
        result.score > current.score)
    ) {
      unique.set(key, result);
    }
  }
  return [...unique.values()]
    .sort((left, right) => {
      const authority =
        knowledgeAuthorityRank(right) - knowledgeAuthorityRank(left);
      return authority !== 0 ? authority : right.score - left.score;
    })
    .slice(0, RESET_EVIDENCE_LIMIT);
}

function explicitStaffNames(clientTurnText: string): string[] {
  return STAFF_NAMES.map((name) => ({
    name,
    index: clientTurnText.search(new RegExp(`\\b${name}\\b`, "i")),
  }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.name);
}

export function resetKnowledgeQueries(clientTurnText: string): string[] {
  const queries = new Set<string>([
    "Tanglin Mall WhatsApp",
    "service constitution",
    "action authority",
  ]);

  // Explicit names and direct commercial questions outrank broad topic expansion.
  // This prevents a multi-service enquiry from exhausting the bounded query budget
  // before the exact stylist or price evidence requested by the client is fetched.
  for (const name of explicitStaffNames(clientTurnText)) queries.add(name);
  if (/\b(?:price|prices|pricing|cost|costs|how much|quote|quotation)\b/i.test(clientTurnText)) {
    queries.add("service price");
  }
  if (/\b(?:which|who|recommend|recommendation|suitable|best)\b.{0,40}\b(?:stylist|colourist|colorist|specialist)\b|\b(?:stylist|colourist|colorist|specialist)\b.{0,40}\b(?:recommend|suitable|best)\b/i.test(clientTurnText)) {
    queries.add("staff expertise");
  }

  for (const rule of TOPIC_RULES) {
    if (!rule.match.test(clientTurnText)) continue;
    for (const query of rule.queries) queries.add(query);
  }

  if (queries.size === 3) queries.add("Hera services");
  return [...queries].slice(0, RESET_QUERY_LIMIT);
}

function needsAppointmentLookup(text: string): boolean {
  return /\b(?:book|booking|appointment|reschedule|rebook|cancel|availability|available|slot|today|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    text,
  );
}

export async function buildResetEvidencePacket(input: {
  repository: ReceptionistRepository;
  clientTurnText: string;
  waId: string;
}): Promise<ResetEvidencePacket> {
  const queries = resetKnowledgeQueries(input.clientTurnText);
  const warnings: string[] = [];
  const batches = await Promise.all(
    queries.map(async (query) => {
      try {
        return await searchAllKnowledge(input.repository, query, 8);
      } catch {
        warnings.push(`Knowledge search failed for: ${query}`);
        return [] as KnowledgeResult[];
      }
    }),
  );

  const allowSentosaInformation = hasExplicitSentosaQuestion(input.clientTurnText);
  const knowledge = orderResetEvidence(batches.flat()).filter(
    (item) => allowSentosaInformation || !isSentosaOnly(item),
  );

  let bookings: BookingSummary[] = [];
  if (needsAppointmentLookup(input.clientTurnText)) {
    try {
      bookings = await input.repository.lookupBookingsByWaId(input.waId, 10);
    } catch {
      warnings.push("Current-client appointment lookup was unavailable.");
    }
  }

  return {
    queries,
    knowledge,
    bookings,
    tanglinOnly: true,
    liveAvailabilityVerified: false,
    retrievalWarnings: warnings,
  };
}
