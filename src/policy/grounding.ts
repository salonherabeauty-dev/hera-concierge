import type {
  AgentDecision,
  AgentIntent,
  SourceReference,
} from "../types.js";
import {
  bookingDecisionRequiresApprovedEvidence,
} from "./bookingExperience.js";
import {
  detectSupportedClientLocale,
  type SupportedClientLocale,
} from "./locale.js";

export const GROUNDING_POLICY_VERSION = "hera-grounding-policy-1.1.0";

export interface GroundingAssessment {
  required: boolean;
  grounded: boolean;
  sourceIds: string[];
  flags: string[];
  replyOverride: string | null;
  confidenceCap: number | null;
}

const ALWAYS_SOURCE_REQUIRED = new Set<AgentIntent>([
  "stylist_matching",
  "location_hours",
  "appointment_lookup",
]);

const FALLBACKS: Record<
  SupportedClientLocale,
  Record<"appointment" | "booking" | "hera_fact", string>
> = {
  en: {
    appointment:
      "Certainly — I can help check this. I couldn’t securely verify the current appointment record just now, so please send the appointment name and date, or try again shortly.",
    booking:
      "Certainly — I can help with this. Please confirm only the booking detail still missing, such as the exact date or preferred time. I’ll then guide you to the appropriate next step, subject to live availability.",
    hera_fact:
      "I don’t want to give you an outdated or unverified Hera detail. I couldn’t confirm that information from an approved source just now. Please tell me the exact service, outlet or stylist you mean, and I’ll check again.",
  },
  zh: {
    appointment:
      "当然，我可以协助查询。我目前无法安全核实最新预约记录，请提供预约姓名和日期，或稍后再试。",
    booking:
      "当然，我可以协助你。请只确认尚未提供的预约资料，例如确切日期或首选时间；我会在实时档期确认后，为你指引下一步。",
    hera_fact:
      "为避免提供过时或未经核实的 Hera 资料，我目前无法从获批来源确认这项信息。请告诉我具体的服务、分店或发型师，我会再次核实。",
  },
  ms: {
    appointment:
      "Sudah tentu, saya boleh membantu menyemaknya. Saya belum dapat mengesahkan rekod janji temu semasa dengan selamat, jadi sila kongsi nama dan tarikh janji temu atau cuba lagi sebentar lagi.",
    booking:
      "Sudah tentu, saya boleh membantu. Sila sahkan hanya butiran tempahan yang masih belum diberikan, seperti tarikh tepat atau masa pilihan. Saya akan membimbing anda ke langkah seterusnya, tertakluk pada ketersediaan semasa.",
    hera_fact:
      "Saya tidak mahu memberi maklumat Hera yang lapuk atau belum disahkan. Saya belum dapat mengesahkannya daripada sumber yang diluluskan. Beritahu perkhidmatan, cawangan atau stylist yang tepat, dan saya akan semak semula.",
  },
  ta: {
    appointment:
      "நிச்சயமாக, இதைச் சரிபார்க்க நான் உதவுகிறேன். தற்போதைய முன்பதிவு பதிவை இப்போது பாதுகாப்பாக உறுதிப்படுத்த முடியவில்லை; முன்பதிவு பெயர் மற்றும் தேதியை அனுப்பவும் அல்லது சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.",
    booking:
      "நிச்சயமாக, நான் உதவுகிறேன். இன்னும் வழங்கப்படாத முன்பதிவு விவரத்தை மட்டும்—உதாரணமாக சரியான தேதி அல்லது விருப்ப நேரம்—உறுதிப்படுத்துங்கள். நேரடி கிடைப்பைப் பொறுத்து அடுத்த படியை வழிகாட்டுவேன்.",
    hera_fact:
      "காலாவதியான அல்லது உறுதிப்படுத்தப்படாத Hera தகவலை நான் வழங்க விரும்பவில்லை. அங்கீகரிக்கப்பட்ட ஆதாரத்தில் இருந்து அதை இப்போது உறுதிப்படுத்த முடியவில்லை. குறிப்பிட்ட சேவை, கிளை அல்லது stylist-ஐத் தெரிவிக்கவும்; மீண்டும் சரிபார்க்கிறேன்.",
  },
};

function uniqueSources(sources: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

function hasBookingEvidence(sourceIds: string[]): boolean {
  return sourceIds.some((id) => id.startsWith("booking:"));
}

function hasBookingActionEvidence(sourceIds: string[]): boolean {
  return sourceIds.some(
    (id) => id.startsWith("booking:") || id === "hera-digital-tools",
  );
}

function fallbackKind(intent: AgentIntent): "appointment" | "booking" | "hera_fact" {
  if (intent === "appointment_lookup") return "appointment";
  if (
    intent === "booking" ||
    intent === "availability" ||
    intent === "appointment_change"
  ) {
    return "booking";
  }
  return "hera_fact";
}

export function canonicalizeSources(
  proposed: SourceReference[],
  approvedTitles: ReadonlyMap<string, string>,
): SourceReference[] {
  return uniqueSources(proposed)
    .filter((source) => approvedTitles.has(source.id))
    .slice(0, 8)
    .map((source) => ({
      id: source.id,
      title: approvedTitles.get(source.id) as string,
    }));
}

export function assessGrounding(
  input: string,
  decision: AgentDecision,
): GroundingAssessment {
  const sourceIds = [...new Set(decision.sources.map((source) => source.id))];
  const flags: string[] = [];
  const claimsHeraFact = decision.factualBasis.includes("approved_hera_source");
  const claimsAppointment = decision.factualBasis.includes("current_client_record");
  const claimsCalculation = decision.factualBasis.includes(
    "deterministic_calculation",
  );
  const bookingRequiresEvidence = bookingDecisionRequiresApprovedEvidence(decision);

  const required =
    ALWAYS_SOURCE_REQUIRED.has(decision.intent) ||
    bookingRequiresEvidence ||
    claimsHeraFact ||
    claimsAppointment ||
    claimsCalculation ||
    (decision.intent === "pricing" &&
      !decision.factualBasis.includes("client_provided_fact"));

  if (claimsHeraFact && sourceIds.length === 0) {
    flags.push("hera_fact_without_approved_source");
  }
  if (claimsAppointment && !hasBookingEvidence(sourceIds)) {
    flags.push("appointment_claim_without_current_client_record");
  }
  if (
    claimsCalculation &&
    !sourceIds.some((id) => id.startsWith("calculation:"))
  ) {
    flags.push("calculation_without_deterministic_result");
  }
  if (
    decision.intent === "appointment_lookup" &&
    !hasBookingEvidence(sourceIds)
  ) {
    flags.push("appointment_lookup_without_record_evidence");
  }
  if (
    bookingRequiresEvidence &&
    !hasBookingActionEvidence(sourceIds)
  ) {
    flags.push("booking_guidance_without_approved_tool_evidence");
  }
  if (
    ["stylist_matching", "location_hours"].includes(decision.intent) &&
    sourceIds.length === 0
  ) {
    flags.push("hera_operational_answer_without_approved_source");
  }
  if (
    decision.intent === "pricing" &&
    sourceIds.length === 0 &&
    !decision.factualBasis.includes("client_provided_fact")
  ) {
    flags.push("pricing_answer_without_approved_source");
  }

  const grounded = !required || flags.length === 0;
  const locale = detectSupportedClientLocale(input);
  return {
    required,
    grounded,
    sourceIds,
    flags,
    replyOverride: grounded
      ? null
      : FALLBACKS[locale][fallbackKind(decision.intent)],
    confidenceCap: grounded ? null : 0.35,
  };
}
