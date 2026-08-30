import {
  orderKnowledgeByAuthority,
} from "../governance/knowledgeAuthority.js";
import { searchAllKnowledge } from "../knowledge/search.js";
import type { ReceptionistRepository } from "../db/repository.js";
import type { BookingSummary, KnowledgeResult } from "../types.js";
import type { ResetEvidencePacket } from "./types.js";

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

function dedupeKnowledge(results: KnowledgeResult[]): KnowledgeResult[] {
  const seen = new Map<string, KnowledgeResult>();
  for (const result of results) {
    const key = result.id || `${result.title}:${result.version}`;
    const current = seen.get(key);
    if (!current || result.score > current.score) seen.set(key, result);
  }
  return [...seen.values()];
}

export function resetKnowledgeQueries(clientTurnText: string): string[] {
  const queries = new Set<string>([
    "Tanglin Mall WhatsApp",
    "service constitution",
    "action authority",
  ]);

  for (const rule of TOPIC_RULES) {
    if (!rule.match.test(clientTurnText)) continue;
    for (const query of rule.queries) queries.add(query);
  }

  for (const name of STAFF_NAMES) {
    if (new RegExp(`\\b${name}\\b`, "i").test(clientTurnText)) {
      queries.add(name);
    }
  }

  if (queries.size === 3) queries.add("Hera services");
  return [...queries].slice(0, 16);
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
        return await searchAllKnowledge(input.repository, query, 6);
      } catch {
        warnings.push(`Knowledge search failed for: ${query}`);
        return [] as KnowledgeResult[];
      }
    }),
  );

  const allowSentosaInformation = hasExplicitSentosaQuestion(input.clientTurnText);
  const merged = dedupeKnowledge(batches.flat()).filter(
    (item) => allowSentosaInformation || !isSentosaOnly(item),
  );
  const knowledge = orderKnowledgeByAuthority(merged, 30);

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
