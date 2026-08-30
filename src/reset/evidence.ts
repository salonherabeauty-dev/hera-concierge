import type { ReceptionistRepository } from "../db/repository.js";
import { searchAllKnowledge } from "../knowledge/search.js";
import type { BookingSummary, KnowledgeResult } from "../types.js";
import type {
  ClaimedResetTurnJob,
  ResetAppointmentEvidence,
  ResetConversationMessage,
  ResetEvidenceBundle,
  ResetKnowledgeEvidence,
  ResetTurnContact,
  ResetTurnFragment,
} from "./types.js";

const RESET_QUERY_LIMIT = 16;
const RESET_EVIDENCE_LIMIT = 24;

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

interface QueryPlanItem {
  category: ResetKnowledgeEvidence["category"];
  query: string;
  boost: number;
}

interface TopicRule {
  match: RegExp;
  category: ResetKnowledgeEvidence["category"];
  queries: string[];
}

const TOPIC_RULES: TopicRule[] = [
  {
    match: /\b(?:curl|curls|curly|wavy|wave|coily|coil|rezo|rëzo|cado|cadō)\b/i,
    category: "service",
    queries: ["curly hair", "curl hydration", "curly specialist"],
  },
  {
    match: /\b(?:blonde|blond|blonding|highlight|highlights|airtou?ch|air touch)\b/i,
    category: "service",
    queries: ["blonding", "highlights", "AirTouch"],
  },
  {
    match: /\bbalayage\b/i,
    category: "service",
    queries: ["balayage"],
  },
  {
    match: /\b(?:grey|gray|salt and pepper|salt-and-pepper)\b/i,
    category: "service",
    queries: ["grey blending", "salt and pepper"],
  },
  {
    match: /\b(?:extension|extensions|tape-in|tape in|weft|keratin bond|nano ring|micro ring|clip-in)\b/i,
    category: "service",
    queries: ["hair extensions", "tape-in", "keratin bond", "weft"],
  },
  {
    match: /\b(?:colour correction|color correction|corrective colour|corrective color)\b/i,
    category: "service",
    queries: ["colour correction"],
  },
  {
    match: /\b(?:keratin|smoothing|rebonding|straighten|straightening)\b/i,
    category: "service",
    queries: ["keratin", "rebonding", "smoothing"],
  },
  {
    match: /\b(?:perm|perming|spiral perm)\b/i,
    category: "service",
    queries: ["perm"],
  },
  {
    match: /\b(?:treatment|k18|olaplex|hydration|hair spa|scalp spa)\b/i,
    category: "service",
    queries: ["hair treatment", "K18", "Olaplex", "hydration"],
  },
  {
    match: /\b(?:manicure|pedicure|nail|nails|gel manicure|gel pedicure)\b/i,
    category: "service",
    queries: ["manicure", "pedicure", "nail artist"],
  },
  {
    match: /\b(?:complaint|unhappy|dissatisfied|refund|compensation|sue|lawyer|legal|injury|damage)\b/i,
    category: "policy",
    queries: ["service concern", "refund authority", "complaint policy"],
  },
  {
    match: /\b(?:strand test|patch test|bleach|henna)\b/i,
    category: "policy",
    queries: ["strand test", "patch test", "bleach safety"],
  },
  {
    match: /\b(?:waited|waiting|late|delay)\b/i,
    category: "policy",
    queries: ["waiting time policy"],
  },
  {
    match: /\b(?:photo|video|consent|privacy|delete my data|pdpa)\b/i,
    category: "policy",
    queries: ["photo consent", "privacy authority"],
  },
  {
    match: /\b(?:book|booking|appointment|reschedule|rebook|cancel|availability|available|slot)\b/i,
    category: "authority",
    queries: ["booking authority"],
  },
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryFor(result: KnowledgeResult): ResetKnowledgeEvidence["category"] {
  const text = `${result.title}\n${result.excerpt}`.toLowerCase();
  if (/action authority|service constitution|channel scope|channel routing/.test(text)) {
    return "authority";
  }
  if (/official price|pricing|price —|price -|before 9% gst/.test(text)) {
    return "price";
  }
  if (/current team expertise|^staff:|primary approved specialties/.test(text)) {
    return "staff";
  }
  if (/policy|rule|complaint|refund|consent|strand test|service concern/.test(text)) {
    return "policy";
  }
  return "service";
}

function sentosaOnly(
  result: KnowledgeResult,
  category: ResetKnowledgeEvidence["category"],
): boolean {
  if (category !== "price" && category !== "staff") return false;
  const text = `${result.title}\n${result.excerpt}`;
  const mentionsSentosa = /Sentosa Cove|Quayside Isle/i.test(text);
  const explicitlyTanglinOrBoth = /Tanglin Mall|\bBoth\b/i.test(text);
  const normalOutletSentosa = /Normal outlet:\s*Sentosa Cove/i.test(text);
  return (mentionsSentosa && !explicitlyTanglinOrBoth) || normalOutletSentosa;
}

function toEvidence(result: KnowledgeResult): ResetKnowledgeEvidence | null {
  const category = categoryFor(result);
  if (sentosaOnly(result, category)) return null;
  return {
    id: result.id,
    title: result.title,
    excerpt: result.excerpt,
    sourceUrl: result.sourceUrl,
    version: result.version,
    score: result.score,
    category,
  };
}

function fragmentTime(fragment: ResetTurnFragment): number {
  const parsed = Date.parse(fragment.providerTimestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fragmentDescription(fragment: ResetTurnFragment): string {
  const text = fragment.text?.trim();
  if (text) return text;
  const media = fragment.media && typeof fragment.media === "object" && !Array.isArray(fragment.media)
    ? fragment.media as Record<string, unknown>
    : null;
  const filename = typeof media?.filename === "string" ? media.filename : null;
  const caption = typeof media?.caption === "string" ? media.caption : null;
  if (caption?.trim()) return caption.trim();
  if (fragment.kind === "image") return "[Client attached an image.]";
  if (fragment.kind === "document") {
    return filename
      ? `[Client attached a document named ${filename}.]`
      : "[Client attached a document.]";
  }
  if (fragment.kind === "audio") return "[Client attached a voice message.]";
  if (fragment.kind === "video") return "[Client attached a video.]";
  if (fragment.kind === "sticker") return "[Client sent a sticker.]";
  if (!fragment.readable) {
    return "[Client attached an item that could not be interpreted; preserve it as part of this client turn and do not treat it as a separate request.]";
  }
  return `[Client sent a ${fragment.kind} message.]`;
}

export function consolidatedTurnText(job: ClaimedResetTurnJob): string {
  const descriptions = [...job.fragments]
    .sort(
      (left, right) =>
        fragmentTime(left) - fragmentTime(right) ||
        left.messageId.localeCompare(right.messageId),
    )
    .map(fragmentDescription)
    .filter(Boolean);
  const unique = [...new Set(descriptions)];
  if (unique.length > 0) return unique.join("\n").slice(0, 24_000);

  const direct = job.consolidatedText.trim();
  return direct.slice(0, 24_000) ||
    "[The client sent an attachment that could not be interpreted. Ask them to resend it in a supported format.]";
}

function compactQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 420);
}

function explicitStaffNames(clientTurn: string): string[] {
  return STAFF_NAMES.map((name) => ({
    name,
    index: clientTurn.search(new RegExp(`\\b${name}\\b`, "i")),
  }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.name);
}

function likelyStylistRecommendation(clientTurn: string): boolean {
  return /\b(?:which|who|recommend|recommendation|suitable|best)\b.{0,50}\b(?:stylist|colourist|colorist|specialist)\b|\b(?:stylist|colourist|colorist|specialist)\b.{0,50}\b(?:recommend|suitable|best)\b/i.test(
    clientTurn,
  );
}

function likelyPriceQuestion(clientTurn: string): boolean {
  return /\b(?:price|prices|pricing|cost|costs|how much|quote|quotation|estimated price)\b/i.test(
    clientTurn,
  );
}

export function needsResetAppointmentLookup(clientTurn: string): boolean {
  return /\b(?:book|booking|appointment|reschedule|rebook|cancel|cancellation|availability|available|slot|today|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(
    clientTurn,
  );
}

export function resetEvidenceQueries(clientTurn: string): QueryPlanItem[] {
  const byQuery = new Map<string, QueryPlanItem>();
  const add = (item: QueryPlanItem) => {
    const query = compactQuery(item.query);
    if (!query) return;
    const key = normalize(query);
    const current = byQuery.get(key);
    if (!current || item.boost > current.boost) {
      byQuery.set(key, { ...item, query });
    }
  };

  // Runtime authority is mandatory and receives the highest retrieval priority.
  add({
    category: "authority",
    query: "Hera service constitution action authority Tanglin Mall WhatsApp",
    boost: 2_000,
  });

  // Explicitly named staff must never be crowded out by broad multi-service
  // terms. Each name receives its own exact retrieval query.
  for (const name of explicitStaffNames(clientTurn)) {
    add({ category: "staff", query: name, boost: 1_800 });
  }

  if (likelyPriceQuestion(clientTurn)) {
    add({ category: "price", query: `${clientTurn} service price`, boost: 1_300 });
  }
  if (likelyStylistRecommendation(clientTurn)) {
    add({ category: "staff", query: `${clientTurn} staff expertise`, boost: 1_300 });
  }

  for (const rule of TOPIC_RULES) {
    if (!rule.match.test(clientTurn)) continue;
    for (const query of rule.queries) {
      add({ category: rule.category, query, boost: 900 });
    }
  }

  // The exact turn remains useful for unusual or multi-intent queries, but its
  // broad search cannot outrank explicit authority, staff or price evidence.
  add({ category: "service", query: clientTurn, boost: 200 });
  if (byQuery.size === 1) {
    add({ category: "service", query: "Hera services", boost: 200 });
  }

  return [...byQuery.values()]
    .sort((left, right) => right.boost - left.boost)
    .slice(0, RESET_QUERY_LIMIT);
}

function bookingEvidence(bookings: BookingSummary[]): ResetAppointmentEvidence[] {
  return bookings.map((booking) => ({
    id: booking.id,
    clientName: booking.clientName,
    serviceName: booking.serviceName,
    stylistName: booking.stylistName,
    locationName: booking.locationName,
    appointmentAt: booking.appointmentAt,
    bookingStatus: booking.bookingStatus,
    price: booking.price,
    currency: booking.currency,
  }));
}

export async function buildResetEvidenceBundle(input: {
  repository: ReceptionistRepository;
  job: ClaimedResetTurnJob;
  contact: ResetTurnContact;
  recentConversation: ResetConversationMessage[];
}): Promise<ResetEvidenceBundle> {
  const clientTurn = consolidatedTurnText(input.job);
  const plan = resetEvidenceQueries(clientTurn);
  const settled = await Promise.all(
    plan.map(async (item) => ({
      ...item,
      results: await searchAllKnowledge(input.repository, item.query, 8),
    })),
  );

  const merged = new Map<string, ResetKnowledgeEvidence>();
  for (const group of settled) {
    for (const result of group.results) {
      const evidence = toEvidence(result);
      if (!evidence) continue;
      const next = {
        ...evidence,
        // Preserve the source's real document class. A staff record returned by
        // a price query is still staff evidence and vice versa.
        score:
          evidence.score +
          group.boost +
          (evidence.category === group.category ? 100 : 0),
      } satisfies ResetKnowledgeEvidence;
      const current = merged.get(next.id);
      if (!current || next.score > current.score) merged.set(next.id, next);
    }
  }

  const categoryTieBreak: Record<ResetKnowledgeEvidence["category"], number> = {
    authority: 0,
    staff: 1,
    price: 2,
    policy: 3,
    service: 4,
  };
  const knowledge = [...merged.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        categoryTieBreak[left.category] - categoryTieBreak[right.category],
    )
    .slice(0, RESET_EVIDENCE_LIMIT);

  const appointments = needsResetAppointmentLookup(clientTurn)
    ? await input.repository
        .lookupBookingsByWaId(input.contact.waId, 10)
        .catch(() => [] as BookingSummary[])
    : [];

  return {
    channel: "Tanglin Mall WhatsApp",
    outlet: "Tanglin Mall",
    turnId: input.job.turnId,
    turnVersion: input.job.version,
    client: {
      displayName: input.contact.profileName,
      whatsappEnding: input.contact.waId.slice(-4),
    },
    consolidatedClientTurn: clientTurn,
    fragments: input.job.fragments,
    recentConversation: input.recentConversation,
    knowledge,
    currentClientAppointments: bookingEvidence(appointments),
    authorityBoundaries: {
      mayDraft: true,
      maySendAutomatically: false,
      mayWriteTimely: false,
      mayConfirmLiveAvailability: false,
      mayConfirmBookingChangeWithoutVerifiedOutcome: false,
      mayApproveRefundOrCompensation: false,
      humanApprovalRequired: true,
    },
  };
}
