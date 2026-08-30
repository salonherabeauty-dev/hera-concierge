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

const SERVICE_TERMS = [
  "curly",
  "curl",
  "haircut",
  "hydration",
  "balayage",
  "blonde",
  "blonding",
  "highlight",
  "grey",
  "gray",
  "colour",
  "color",
  "correction",
  "extension",
  "keratin",
  "rebonding",
  "smoothing",
  "perm",
  "treatment",
  "manicure",
  "pedicure",
  "nail",
  "styling",
  "blow-dry",
  "regrowth",
  "toner",
  "airtouch",
] as const;

const POLICY_TERMS = [
  "complaint",
  "unhappy",
  "refund",
  "compensation",
  "refinement",
  "appointment",
  "booking",
  "cancel",
  "reschedule",
  "late",
  "strand test",
  "bleach",
  "consent",
  "privacy",
  "medical",
  "scalp",
  "allergy",
  "pregnant",
  "pregnancy",
] as const;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchedTerms(text: string, terms: readonly string[]): string[] {
  const normalized = normalize(text);
  return terms.filter((term) => normalized.includes(normalize(term)));
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

function sentosaOnly(result: KnowledgeResult, category: ResetKnowledgeEvidence["category"]): boolean {
  if (category !== "price" && category !== "staff") return false;
  const text = `${result.title}\n${result.excerpt}`;
  const mentionsSentosa = /Sentosa Cove|Quayside Isle/i.test(text);
  const explicitlyTanglinOrBoth = /Tanglin Mall|\bBoth\b/i.test(text);
  const normalOutletSentosa = /Normal outlet:\s*Sentosa Cove/i.test(text);
  return mentionsSentosa && !explicitlyTanglinOrBoth || normalOutletSentosa;
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
  const direct = job.consolidatedText.trim();
  const descriptions = job.fragments
    .map(fragmentDescription)
    .filter(Boolean);
  if (direct && descriptions.length === 0) return direct;
  const unique = [...new Set(descriptions)];
  return unique.join("\n").slice(0, 24_000) ||
    "[The client sent an attachment that could not be interpreted. Ask them to resend it in a supported format.]";
}

function compactQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 420);
}

function queryPlan(clientTurn: string): Array<{
  category: ResetKnowledgeEvidence["category"];
  query: string;
}> {
  const services = matchedTerms(clientTurn, SERVICE_TERMS);
  const policies = matchedTerms(clientTurn, POLICY_TERMS);
  const serviceSeed = services.slice(0, 4).join(" ") || "hair salon service";
  const policySeed = policies.slice(0, 4).join(" ") || "client service policy";

  return [
    { category: "service", query: compactQuery(clientTurn) },
    { category: "service", query: compactQuery(`${serviceSeed} service`) },
    { category: "price", query: compactQuery(`${serviceSeed} price`) },
    { category: "staff", query: compactQuery(`${serviceSeed} specialist expertise`) },
    { category: "policy", query: compactQuery(`${policySeed} policy`) },
    { category: "authority", query: "Hera service constitution action authority Tanglin Mall" },
  ];
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
  const plan = queryPlan(clientTurn);
  const settled = await Promise.all(
    plan.map(async ({ category, query }) => ({
      category,
      results: await searchAllKnowledge(input.repository, query, 8),
    })),
  );

  const merged = new Map<string, ResetKnowledgeEvidence>();
  for (const group of settled) {
    for (const result of group.results) {
      const evidence = toEvidence(result);
      if (!evidence) continue;
      const current = merged.get(evidence.id);
      const next = {
        ...evidence,
        category:
          evidence.category === "authority" ? "authority" : group.category,
      } satisfies ResetKnowledgeEvidence;
      if (!current || next.score > current.score || next.category === "authority") {
        merged.set(next.id, next);
      }
    }
  }

  const categoryOrder: Record<ResetKnowledgeEvidence["category"], number> = {
    authority: 0,
    policy: 1,
    service: 2,
    price: 3,
    staff: 4,
  };
  const knowledge = [...merged.values()]
    .sort((left, right) =>
      categoryOrder[left.category] - categoryOrder[right.category] ||
      right.score - left.score,
    )
    .slice(0, 24);

  const appointments = await input.repository
    .lookupBookingsByWaId(input.contact.waId, 10)
    .catch(() => [] as BookingSummary[]);

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
