import type { ReceptionistRepository } from "../db/repository.js";
import { searchAllKnowledge } from "../knowledge/search.js";
import type { KnowledgeResult } from "../types.js";
import type {
  WebsiteConciergeEvidenceBundle,
  WebsiteConciergeHistoryMessage,
  WebsiteConciergeKnowledgeEvidence,
  WebsiteConciergeOutlet,
} from "./types.js";

const QUERY_LIMIT = 14;
const EVIDENCE_LIMIT = 26;

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
  category: WebsiteConciergeKnowledgeEvidence["category"];
  query: string;
  boost: number;
}

const TOPIC_QUERIES: Array<{
  match: RegExp;
  category: WebsiteConciergeKnowledgeEvidence["category"];
  queries: string[];
}> = [
  {
    match: /\b(?:curl|curls|curly|wavy|coily|coil|rezo|rëzo|cado|cadō)\b/i,
    category: "service",
    queries: ["curly haircut", "curl defining hydration", "curly specialist"],
  },
  {
    match: /\b(?:blonde|blond|highlight|highlights|airtou?ch|air touch)\b/i,
    category: "service",
    queries: ["blonding highlights AirTouch", "blonde specialist"],
  },
  {
    match: /\bbalayage\b/i,
    category: "service",
    queries: ["balayage service", "balayage specialist"],
  },
  {
    match: /\b(?:grey|gray|salt and pepper|salt-and-pepper)\b/i,
    category: "service",
    queries: ["grey blending", "salt and pepper hair"],
  },
  {
    match: /\b(?:extension|extensions|tape-in|tape in|weft|keratin bond|nano ring|micro ring|clip-in)\b/i,
    category: "service",
    queries: ["hair extensions", "tape-in weft keratin bond nano micro ring"],
  },
  {
    match: /\b(?:colour correction|color correction|corrective colour|corrective color|box dye)\b/i,
    category: "service",
    queries: ["colour correction box dye", "corrective colour consultation"],
  },
  {
    match: /\b(?:keratin|smoothing|rebonding|straighten|straightening)\b/i,
    category: "service",
    queries: ["keratin smoothing", "rebonding straightening"],
  },
  {
    match: /\b(?:perm|perming|spiral perm)\b/i,
    category: "service",
    queries: ["perm spiral perm"],
  },
  {
    match: /\b(?:treatment|k18|olaplex|hydration|hair spa|scalp spa)\b/i,
    category: "service",
    queries: ["hair treatment K18 Olaplex hydration", "scalp spa"],
  },
  {
    match: /\b(?:complaint|unhappy|dissatisfied|refund|compensation|sue|lawyer|legal|injury|damage)\b/i,
    category: "policy",
    queries: ["service concern policy", "refund compensation authority"],
  },
  {
    match: /\b(?:strand test|patch test|bleach|henna)\b/i,
    category: "policy",
    queries: ["strand test bleach safety", "patch test henna"],
  },
  {
    match: /\b(?:waited|waiting|late|delay)\b/i,
    category: "policy",
    queries: ["waiting time policy late arrival"],
  },
  {
    match: /\b(?:photo|video|consent|privacy|delete my data|pdpa)\b/i,
    category: "policy",
    queries: ["photo video consent privacy"],
  },
  {
    match: /\b(?:book|booking|appointment|reschedule|rebook|cancel|availability|available|slot)\b/i,
    category: "authority",
    queries: ["booking appointment authority"],
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

export function detectWebsiteOutlet(
  message: string,
  previous: WebsiteConciergeOutlet = "unspecified",
): WebsiteConciergeOutlet {
  if (/\b(?:both outlets|either outlet|any outlet|either one)\b/i.test(message)) {
    return "either";
  }
  if (/\b(?:sentosa|quayside|quayside isle|sentosa cove)\b/i.test(message)) {
    return "sentosa";
  }
  if (/\b(?:tanglin|tanglin mall)\b/i.test(message)) {
    return "tanglin";
  }
  return previous;
}

export function outletClarificationIsRelevant(message: string): boolean {
  return /\b(?:book|booking|appointment|availability|available|slot|reschedule|rebook|cancel|today|tomorrow|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|price|cost|how much|which stylist|who is best|recommend a stylist|opening hours|address|location)\b/i.test(
    message,
  );
}

function explicitStaffNames(message: string): string[] {
  return STAFF_NAMES.filter((name) =>
    new RegExp(`\\b${name}\\b`, "i").test(message),
  );
}

function categoryFor(result: KnowledgeResult): WebsiteConciergeKnowledgeEvidence["category"] {
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

function outletScopeFor(result: KnowledgeResult): WebsiteConciergeOutlet {
  const text = `${result.title}\n${result.excerpt}`;
  const tanglin = /Tanglin Mall|\bTanglin\b/i.test(text);
  const sentosa = /Sentosa Cove|Quayside Isle|\bSentosa\b/i.test(text);
  if (tanglin && sentosa) return "either";
  if (tanglin) return "tanglin";
  if (sentosa) return "sentosa";
  return "unspecified";
}

function toEvidence(result: KnowledgeResult): WebsiteConciergeKnowledgeEvidence {
  return {
    id: result.id,
    title: result.title,
    excerpt: result.excerpt,
    sourceUrl: result.sourceUrl,
    version: result.version,
    score: result.score,
    category: categoryFor(result),
    outletScope: outletScopeFor(result),
  };
}

export function websiteEvidenceQueries(
  message: string,
  outlet: WebsiteConciergeOutlet,
): QueryPlanItem[] {
  const map = new Map<string, QueryPlanItem>();
  const add = (item: QueryPlanItem) => {
    const query = item.query.replace(/\s+/g, " ").trim().slice(0, 420);
    if (!query) return;
    const key = normalize(query);
    const current = map.get(key);
    if (!current || item.boost > current.boost) map.set(key, { ...item, query });
  };

  add({
    category: "authority",
    query: "Hera service constitution booking refund authority website concierge",
    boost: 2_000,
  });

  for (const name of explicitStaffNames(message)) {
    add({ category: "staff", query: `${name} staff expertise`, boost: 1_900 });
  }

  const outletText =
    outlet === "tanglin"
      ? "Tanglin Mall"
      : outlet === "sentosa"
        ? "Sentosa Cove Quayside Isle"
        : "Tanglin Mall Sentosa Cove";

  if (/\b(?:price|cost|how much|quote|quotation)\b/i.test(message)) {
    add({ category: "price", query: `${message} ${outletText} price`, boost: 1_600 });
  }
  if (/\b(?:which|who|recommend|best|suitable)\b/i.test(message)) {
    add({ category: "staff", query: `${message} staff expertise ${outletText}`, boost: 1_500 });
  }

  for (const rule of TOPIC_QUERIES) {
    if (!rule.match.test(message)) continue;
    for (const query of rule.queries) {
      add({
        category: rule.category,
        query: `${query} ${outletText}`,
        boost: 1_000,
      });
    }
  }

  add({ category: "service", query: message, boost: 300 });
  if (map.size === 1) {
    add({ category: "service", query: "Hera services and hair expertise", boost: 300 });
  }

  return [...map.values()]
    .sort((left, right) => right.boost - left.boost)
    .slice(0, QUERY_LIMIT);
}

export async function buildWebsiteConciergeEvidence(input: {
  repository: ReceptionistRepository;
  message: string;
  history: WebsiteConciergeHistoryMessage[];
  previousOutlet: WebsiteConciergeOutlet;
}): Promise<WebsiteConciergeEvidenceBundle> {
  const outlet = detectWebsiteOutlet(input.message, input.previousOutlet);
  const plan = websiteEvidenceQueries(input.message, outlet);
  const groups = await Promise.all(
    plan.map(async (item) => ({
      ...item,
      results: await searchAllKnowledge(input.repository, item.query, 8),
    })),
  );

  const merged = new Map<string, WebsiteConciergeKnowledgeEvidence>();
  for (const group of groups) {
    for (const result of group.results) {
      const evidence = toEvidence(result);
      const outletBoost =
        outlet === "unspecified" || outlet === "either"
          ? 0
          : evidence.outletScope === outlet || evidence.outletScope === "either"
            ? 180
            : 0;
      const next = {
        ...evidence,
        score:
          evidence.score +
          group.boost +
          outletBoost +
          (evidence.category === group.category ? 100 : 0),
      };
      const current = merged.get(next.id);
      if (!current || next.score > current.score) merged.set(next.id, next);
    }
  }

  const knowledge = [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, EVIDENCE_LIMIT);

  return {
    channel: "Hera public website",
    visitorOutlet: outlet,
    outletClarificationOperationallyRelevant:
      outlet === "unspecified" && outletClarificationIsRelevant(input.message),
    visitorMessage: input.message,
    history: input.history.slice(-12),
    knowledge,
    authorityBoundaries: {
      mayAnswerDirectly: true,
      maySendWhatsApp: false,
      mayWriteTimely: false,
      mayConfirmLiveAvailability: false,
      mayConfirmBookingOrAppointmentChange: false,
      mayApproveRefundOrCompensation: false,
      mayDiagnoseMedicalCondition: false,
    },
    contactOptions: {
      bookingUrl: "https://bookings.gettimely.com/herabeauty1/bb/book",
      tanglinPhone: "+65 6732 1206",
      tanglinWhatsAppUrl: "https://api.whatsapp.com/send?phone=6592371254",
      sentosaPhone: "+65 6268 8949",
    },
  };
}
