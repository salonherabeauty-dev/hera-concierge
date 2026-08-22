import type {
  AgentDecision,
  AgentIntent,
  SourceReference,
} from "../types.js";
import {
  detectSupportedClientLocale,
  type SupportedClientLocale,
} from "./locale.js";

export const GROUNDING_POLICY_VERSION = "hera-grounding-policy-1.0.0";

export interface GroundingAssessment {
  required: boolean;
  grounded: boolean;
  sourceIds: string[];
  flags: string[];
  replyOverride: string | null;
  confidenceCap: number | null;
}

const ALWAYS_SOURCE_REQUIRED = new Set<AgentIntent>([
  "booking",
  "availability",
  "stylist_matching",
  "location_hours",
  "appointment_lookup",
  "appointment_change",
]);

const FALLBACKS: Record<
  SupportedClientLocale,
  Record<"appointment" | "booking" | "hera_fact", string>
> = {
  en: {
    appointment:
      "I don’t want to guess about your appointment. I couldn’t securely verify the current booking record just now. Please try again shortly, or send the appointment name and date so I can check it again.",
    booking:
      "I can help, but I won’t invent live availability or claim a booking change before the booking system confirms it. Please use Hera’s secure booking page: https://bookings.gettimely.com/herabeauty1/bb/book, or tell me the service, preferred outlet, date and time you want checked.",
    hera_fact:
      "I don’t want to give you an outdated or unverified Hera detail. I couldn’t confirm that information from an approved source just now. Please tell me the exact service, outlet or stylist you mean, and I’ll check again.",
  },
  zh: {
    appointment:
      "为避免猜测你的预约资料，我目前无法安全核实最新预约记录。请稍后再试，或提供预约姓名和日期，我会再次查询。",
    booking:
      "我可以协助你，但在预约系统确认之前，我不会虚构实时空档或声称预约已更改。请使用 Hera 的安全预约页面：https://bookings.gettimely.com/herabeauty1/bb/book，或告诉我所需服务、分店、日期和时间。",
    hera_fact:
      "为避免提供过时或未经核实的 Hera 资料，我目前无法从获批来源确认这项信息。请告诉我具体的服务、分店或发型师，我会再次核实。",
  },
  ms: {
    appointment:
      "Saya tidak mahu membuat andaian tentang janji temu anda. Saya belum dapat mengesahkan rekod tempahan semasa dengan selamat. Sila cuba lagi sebentar lagi, atau kongsi nama dan tarikh janji temu untuk saya semak semula.",
    booking:
      "Saya boleh membantu, tetapi saya tidak akan mereka-reka kekosongan masa atau mendakwa tempahan telah diubah sebelum sistem tempahan mengesahkannya. Gunakan halaman tempahan selamat Hera: https://bookings.gettimely.com/herabeauty1/bb/book, atau beritahu perkhidmatan, cawangan, tarikh dan masa pilihan anda.",
    hera_fact:
      "Saya tidak mahu memberi maklumat Hera yang lapuk atau belum disahkan. Saya belum dapat mengesahkannya daripada sumber yang diluluskan. Beritahu perkhidmatan, cawangan atau stylist yang tepat, dan saya akan semak semula.",
  },
  ta: {
    appointment:
      "உங்கள் முன்பதிவைப் பற்றி நான் ஊகிக்க விரும்பவில்லை. தற்போதைய முன்பதிவு பதிவை இப்போது பாதுகாப்பாக உறுதிப்படுத்த முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும், அல்லது முன்பதிவு பெயர் மற்றும் தேதியை அனுப்பவும்.",
    booking:
      "நான் உதவ முடியும்; ஆனால் முன்பதிவு அமைப்பு உறுதிப்படுத்தும் வரை நேரடி காலியிடத்தையோ மாற்றம் முடிந்ததாகவோ கூற மாட்டேன். Hera-வின் பாதுகாப்பான முன்பதிவு பக்கத்தைப் பயன்படுத்தவும்: https://bookings.gettimely.com/herabeauty1/bb/book, அல்லது சேவை, கிளை, தேதி மற்றும் நேரத்தைத் தெரிவிக்கவும்.",
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

  const required =
    ALWAYS_SOURCE_REQUIRED.has(decision.intent) ||
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
    ["booking", "availability", "appointment_change"].includes(decision.intent) &&
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
