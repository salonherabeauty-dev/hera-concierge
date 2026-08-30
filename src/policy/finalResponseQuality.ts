import {
  assessFinalResponseQuality as assessLegacyFinalResponseQuality,
  type FinalResponseQualityAssessment,
} from "./finalResponseQualityCore.js";
import {
  detectSupportedClientLocale,
  type SupportedClientLocale,
} from "./locale.js";

export type { FinalResponseQualityAssessment } from "./finalResponseQualityCore.js";

export const FINAL_RESPONSE_QUALITY_POLICY_VERSION =
  "hera-final-response-quality-1.5.0";

type FinalResponseQualityInput = Parameters<
  typeof assessLegacyFinalResponseQuality
>[0];

const DIRECT_ACTION_OWNERSHIP: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:i|we)(?:(?:['’](?:m|re|ve|ll))|(?:\s+(?:am|are|have|will|can)))?\s+(?:personally\s+)?(?:review(?:ing)?|assess(?:ing)?|check(?:ing)?|verif(?:y|ying)|arrang(?:e|ing)|coordinat(?:e|ing)|handl(?:e|ing)|bring(?:ing)?|send(?:ing)?|refer(?:ring)?|forward(?:ing)?|confirm(?:ing)?|updat(?:e|ing)|keep(?:ing)?|follow(?:ing)?\s+up|help(?:ing)?|take(?:ing)?\s+care\s+of)\b/i,
  zh: /(?:我|我们)(?:会|将|正在|已经|已)?(?:审核|审查|评估|检查|核实|安排|协调|处理|转交|提交|确认|更新|跟进|协助)/u,
  ms: /\b(?:saya|kami)(?:\s+(?:akan|sedang|telah|sudah|boleh))?\s+(?:semak|menilai|periksa|sahkan|atur|selaras|urus|rujuk|hantar|kemas\s+kini|susulan|bantu)\b/i,
  ta: /(?:நான்|நாங்கள்)(?:\s+)?(?:மதிப்பாய்வு|ஆய்வு|சரிபார்க்க|உறுதிப்படுத்த|ஏற்பாடு|ஒருங்கிணை|கையாள|அனுப்ப|ஒப்படைக்க|புதுப்பிக்க|தொடர்ந்து|உதவ)/u,
};

const NATURAL_OUTCOME_CONFIRMATION: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:confirm(?:ed|ing)?|update(?:d|ing)?(?:\s+you)?|keep(?:ing)?\s+you\s+updated|let(?:ting)?\s+you\s+know|advise(?:d|ing)?|come\s+back\s+to\s+you|share(?:d|ing)?\s+(?:the\s+)?(?:outcome|next\s+step))\b/i,
  zh: /确认|更新|告知|通知|回复|下一步|结果/u,
  ms: /\b(?:sahkan|kemas\s+kini|maklumkan|beritahu|hubungi\s+semula|keputusan|langkah\s+seterusnya)\b/i,
  ta: /உறுதிப்படுத்த|புதுப்பிக்க|தெரிவிக்க|அறிவிக்க|மீண்டும் தொடர்பு|முடிவு|அடுத்த படி/u,
};

const REVIEW_ACTION: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:review(?:ed|ing)?|assess(?:ed|ing)?|check(?:ed|ing)?|verif(?:y|ied|ying)|arrang(?:e|ed|ing)\s+(?:an?\s+)?(?:urgent\s+)?review)\b/i,
  zh: /审核|审查|评估|检查|核实|安排.{0,10}审核/u,
  ms: /\b(?:semak|menilai|periksa|sahkan|atur(?:kan)?\s+(?:semakan|penilaian))\b/i,
  ta: /மதிப்பாய்வு|ஆய்வு|சரிபார்க்க|உறுதிப்படுத்த|மதிப்பாய்வை ஏற்பாடு/u,
};

const ROUTE_TO_AUTHORISED_OWNER: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:bring(?:ing)?|send(?:ing)?|forward(?:ing)?|refer(?:ring)?|rout(?:e|ed|ing))\b.{0,140}\b(?:senior\s+management|management|legal(?:\s+(?:team|handler))?|privacy(?:\s+(?:team|officer))?)\b/i,
  zh: /(?:转交|提交|交给|上报).{0,40}(?:高级管理层|管理团队|法律团队|法律负责人|隐私团队|隐私负责人)/u,
  ms: /\b(?:serah|hantar|rujuk|majukan)\b.{0,120}\b(?:pengurusan\s+kanan|pihak\s+pengurusan|pasukan\s+undang-undang|pegawai\s+privasi|pasukan\s+privasi)\b/i,
  ta: /(?:ஒப்படைக்க|அனுப்ப|மேலிட|பரிந்துரைக்க).{0,80}(?:மூத்த நிர்வாகம்|நிர்வாகம்|சட்டக் குழு|தனியுரிமைக் குழு|தனியுரிமை அதிகாரி)/u,
};

const GENERAL_OWNERSHIP_ISSUE =
  "The final reply does not identify clear human ownership.";
const APPOINTMENT_OUTCOME_ISSUE =
  "The appointment-change reply does not explain how the verified outcome will be confirmed.";
const PRIVACY_LEGAL_REVIEW_ISSUE =
  "The privacy or legal reply does not identify authorised review.";

function matches(
  patterns: Record<SupportedClientLocale, RegExp>,
  locale: SupportedClientLocale,
  value: string,
): boolean {
  return patterns[locale].test(value);
}

function activeTaskType(input: FinalResponseQualityInput): string | null {
  if (!input.handoff.createTask) return null;
  if (input.handoff.taskType) return input.handoff.taskType;
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "medical_safety") return "medical_safety";
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  return null;
}

function hasDirectOwnership(
  locale: SupportedClientLocale,
  reply: string,
): boolean {
  return matches(DIRECT_ACTION_OWNERSHIP, locale, reply);
}

function hasNaturalOutcomeConfirmation(
  locale: SupportedClientLocale,
  reply: string,
): boolean {
  return matches(NATURAL_OUTCOME_CONFIRMATION, locale, reply);
}

function hasAuthorisedReviewSemantics(
  input: FinalResponseQualityInput,
  locale: SupportedClientLocale,
  reply: string,
): boolean {
  const durableOwner = [
    "privacy_officer",
    "salon_manager",
    "managing_director",
  ].includes(input.handoff.assignedRole ?? "");
  if (!input.handoff.createTask || !durableOwner) return false;
  if (!hasDirectOwnership(locale, reply)) return false;
  return (
    matches(REVIEW_ACTION, locale, reply) ||
    matches(ROUTE_TO_AUTHORISED_OWNER, locale, reply)
  );
}

export function assessFinalResponseQuality(
  input: FinalResponseQualityInput,
): FinalResponseQualityAssessment {
  const legacy = assessLegacyFinalResponseQuality(input);
  const issues = new Set(legacy.issues);
  const locale = detectSupportedClientLocale(input.clientMessage);
  const reply = input.reply.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const taskType = activeTaskType(input);
  const directOwnership = hasDirectOwnership(locale, reply);

  let ownership = legacy.checks.ownership;
  if (input.handoff.createTask && directOwnership) {
    ownership = true;
    issues.delete(GENERAL_OWNERSHIP_ISSUE);
  }

  if (
    taskType === "appointment_change" &&
    hasNaturalOutcomeConfirmation(locale, reply)
  ) {
    issues.delete(APPOINTMENT_OUTCOME_ISSUE);
  }

  if (
    taskType === "privacy_legal" &&
    hasAuthorisedReviewSemantics(input, locale, reply)
  ) {
    issues.delete(PRIVACY_LEGAL_REVIEW_ISSUE);
  }

  // Complaint, refund, medical, booking-completion, privacy-completion,
  // liability, guarantee, internal-language and channel safeguards remain
  // exactly as evaluated by the legacy fail-closed core. In particular, the
  // specific complaint requirement for manager ownership is never removed.
  const checks = {
    ...legacy.checks,
    ownership,
  };
  const finalIssues = [...issues];

  return {
    passed: finalIssues.length === 0 && Object.values(checks).every(Boolean),
    issues: finalIssues,
    checks,
  };
}
