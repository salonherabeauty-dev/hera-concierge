import type {
  AgentDecision,
  PolicyAssessment,
  RiskLevel,
} from "../types.js";
import type { HumanHandoffAssessment } from "./handoff.js";
import {
  detectSupportedClientLocale,
  type SupportedClientLocale,
} from "./locale.js";

export const FINAL_RESPONSE_QUALITY_POLICY_VERSION =
  "hera-final-response-quality-1.4.0";

export interface FinalResponseQualityAssessment {
  passed: boolean;
  issues: string[];
  checks: {
    complete: boolean;
    clientFacing: boolean;
    safeAuthority: boolean;
    contextualEmpathy: boolean;
    specificity: boolean;
    ownership: boolean;
    nextStep: boolean;
    conciseTone: boolean;
  };
}

const INTERNAL_LANGUAGE =
  /(?:\b(?:handoff|human-action task|internal queue|priority queue|workflow|verifier|model name|policy rule|backend|system prompt)\b|内部(?:队列|流程)|工作流程|验证器|模型名称|系统提示|barisan dalaman|aliran kerja|pengesah|nama model|arahan sistem|உள் வரிசை|பணிப்பாய்வு|சரிபார்ப்பான்|மாதிரி பெயர்|கணினி வழிமுறை)/iu;
const GENERIC_HUMAN_ACKNOWLEDGEMENT =
  /certainly\.?\s+i(?:'|’)ve sent your request to hera(?:'|’)s team for direct assistance\.?\s+a staff member will continue with you as soon as available\.?/i;
const BUREAUCRATIC_PROCESS_NOTICE =
  /(?:\bappointment[- ]change request\b|\bfor verification and confirmation\b|\bpassed your\b.{0,90}\brequest to (?:our|the) reception team\b|\bplaced (?:this|your request)\b.{0,70}\b(?:queue|verification)\b)/i;
const ESCALATION_CLAIM =
  /(?:\b(?:sent|passed|routed|placed|escalated|forwarded)\b.{0,100}\b(?:team|manager|management|reception|staff)\b|\b(?:team|manager|management|reception|staff)\b.{0,100}\b(?:will|shall)\b.{0,30}\b(?:review|contact|continue|assist|follow up|check)\b|(?:已|已经)?(?:转交|提交|上报|交给).{0,20}(?:团队|经理|店长|前台|工作人员)|(?:团队|经理|店长|前台|工作人员).{0,20}(?:会|将)(?:审核|联系|跟进|协助|查询)|(?:telah|sudah)\s+(?:dihantar|diserahkan|dirujuk).{0,50}(?:pasukan|pengurus|penerimaan|kakitangan)|(?:pasukan|pengurus|penerimaan|kakitangan).{0,50}(?:akan|bakal).{0,30}(?:semak|hubungi|bantu|susulan)|(?:அனுப்பப்பட்டுள்ளது|ஒப்படைக்கப்பட்டுள்ளது|மேலிடப்பட்டுள்ளது).{0,40}(?:குழு|மேலாளர்|வரவேற்பு|பணியாளர்)|(?:குழு|மேலாளர்|வரவேற்பு|பணியாளர்).{0,40}(?:மதிப்பாய்வு|தொடர்பு|உதவ|தொடர்ந்து))/iu;
const PRIVACY_HANDOFF_CLAIM =
  /\b(?:privacy|data protection)\b.{0,100}\b(?:team|officer|management)\b.{0,100}(?:\b(?:will|shall)\b.{0,30})?\b(?:review|contact|follow up|handle|investigate|assess)\b/iu;
const MANAGEMENT_HANDOFF_CLAIM =
  /\b(?:manager|management|managing director)\b.{0,100}(?:\b(?:will|shall)\b.{0,30})?\b(?:review|contact|follow up|handle|investigate|assess|advise)\b/iu;
const BOOKING_COMPLETION =
  /(?:\b(?:i|we)(?:'|’)ve\s+(?:booked|confirmed|reserved|secured)|\b(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured)\b|(?:已|已经)(?:为您|为你)?(?:预订|预约|确认|保留)(?:了|好)?|(?:预约|时段).{0,8}(?:已确认|已预订|已保留)|(?:telah|sudah).{0,24}(?:menempah|mengesahkan|menyimpan slot)|(?:tempahan|janji temu).{0,24}(?:telah|sudah).{0,12}(?:disahkan|ditempah)|(?:முன்பதிவு|சந்திப்பு).{0,24}(?:உறுதிசெய்யப்பட்டது|செய்யப்பட்டது)|(?:நான்|நாங்கள்).{0,24}முன்பதிவு செய்துவிட்ட)/iu;
const FINANCIAL_COMPLETION =
  /(?:\b(?:refund|compensation|credit|voucher)\s+(?:is|has been|was|will be)\s+(?:approved|processed|issued|given|applied)\b|\b(?:i|we)(?:'|’)ve\s+(?:approved|processed|issued)\s+(?:a\s+)?(?:refund|compensation|credit|voucher)\b|(?:退款|赔偿|代金券|抵用金).{0,12}(?:已批准|已处理|已发放|会发放)|(?:bayaran balik|pampasan|kredit|baucar).{0,24}(?:diluluskan|diproses|dikeluarkan|akan diberikan)|(?:பணத்தைத் திருப்புதல்|இழப்பீடு|கடன்|வவுச்சர்).{0,24}(?:அங்கீகரிக்கப்பட்டது|செயலாக்கப்பட்டது|வழங்கப்படும்))/iu;
const PRIVACY_COMPLETION =
  /(?:\b(?:your|the)\s+(?:data|number|photo|record)s?\s+(?:has|have)\s+been\s+(?:deleted|removed|erased)\b|(?:您的|你的|相关)(?:数据|号码|照片|记录).{0,12}(?:已删除|已移除|已清除)|(?:data|nombor|foto|rekod)\s+(?:anda\s+)?(?:telah|sudah)\s+(?:dipadam|dibuang)|(?:உங்கள்|அந்த)?(?:தரவு|எண்|புகைப்படம்|பதிவு).{0,20}(?:நீக்கப்பட்டது|அழிக்கப்பட்டது))/iu;
const LIABILITY_ADMISSION =
  /(?:\b(?:we|hera|our stylist)\s+(?:damaged|destroyed|ruined|caused|were at fault|are liable)|\bour fault\b|\bwe accept liability\b|(?:我们|Hera|我们的发型师).{0,12}(?:损坏|毁坏|造成|有过错|承担责任)|这是我们的错|(?:kami|hera|stylist kami).{0,24}(?:merosakkan|menyebabkan|bersalah|bertanggungjawab)|(?:நாங்கள்|Hera|எங்கள் ஸ்டைலிஸ்ட்).{0,24}(?:சேதப்படுத்தினோம்|காரணம்|தவறு|பொறுப்பு))/iu;
const GUARANTEED_REMEDY =
  /(?:\b(?:guaranteed|definitely|certainly)\s+(?:fix|resolve|refund|redo)|\b(?:free|complimentary)\s+(?:redo|service|treatment|correction)\b|(?:保证|肯定|一定).{0,12}(?:修复|解决|退款|重做)|(?:免费|赠送).{0,12}(?:重做|服务|护理|修正)|(?:dijamin|pasti).{0,24}(?:baiki|selesaikan|bayar balik|buat semula)|(?:percuma|komplemen).{0,24}(?:buat semula|perkhidmatan|rawatan|pembetulan)|(?:உத்தரவாதம்|நிச்சயம்).{0,24}(?:சரி செய்வோம்|தீர்ப்போம்|பணம் திருப்புவோம்|மீண்டும் செய்வோம்)|(?:இலவச|கட்டணமில்லா).{0,24}(?:மீண்டும்|சேவை|சிகிச்சை|திருத்தம்))/iu;
const MEDICAL_CLAIM =
  /(?:\b(?:this is|you have|you are experiencing)\s+(?:an?\s+)?(?:allergy|allergic reaction|chemical burn|infection|alopecia|eczema|psoriasis)\b|\bmedically safe\b|(?:这是|您有|你有).{0,8}(?:过敏|化学灼伤|感染|脱发症|湿疹|银屑病)|医学上安全|(?:ini ialah|anda mempunyai|anda mengalami).{0,20}(?:alahan|reaksi alergi|melecur kimia|jangkitan|alopecia|ekzema|psoriasis)|selamat dari segi perubatan|(?:இது|உங்களுக்கு|நீங்கள் அனுபவிப்பது).{0,24}(?:ஒவ்வாமை|இரசாயன தீக்காயம்|தொற்று|அலோபீசியா|எக்சிமா|சொரியாசிஸ்)|மருத்துவ ரீதியாக பாதுகாப்பான)/iu;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

const EMPATHY: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:sorry|understand|appreciate|thank you for explaining|unhappy|concern|disappointed|frustrating|experience|take care|hope)\b/i,
  zh: /抱歉|遗憾|理解|感谢您说明|谢谢您说明|不满意|担忧|失望|经历|保重|希望/u,
  ms: /\b(?:maaf|faham|memahami|terima kasih kerana menjelaskan|tidak puas hati|tak puas hati|kecewa|pengalaman|kebimbangan|aduan|jaga diri|harap)\b/i,
  ta: /மன்னிக்கவும்|வருந்துகிறோம்|புரிந்துகொள்கிறோம்|விளக்கியதற்கு நன்றி|திருப்தி இல்லை|கவலை|ஏமாற்றம்|அனுபவம்|கவனித்துக் கொள்ளுங்கள்|நம்புகிறோம்/u,
};

const DISTRESS_CONTEXT: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:not feeling well|unwell|sick|ill|hospital|medical emergency|family emergency|accident|bereavement|passed away|daughter|son|child|mother|father|family)\b/i,
  zh: /不舒服|生病|医院|医疗紧急|家庭紧急|事故|去世|女儿|儿子|孩子|母亲|父亲|家人/u,
  ms: /\b(?:tidak sihat|sakit|hospital|kecemasan perubatan|kecemasan keluarga|kemalangan|meninggal|anak perempuan|anak lelaki|anak|ibu|bapa|keluarga)\b/i,
  ta: /உடல்நிலை சரியில்லை|நோய்|மருத்துவமனை|மருத்துவ அவசரம்|குடும்ப அவசரம்|விபத்து|இறந்த|மகள்|மகன்|குழந்தை|அம்மா|அப்பா|குடும்பம்/u,
};

const OWNERSHIP: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:salon manager|manager|management|authorised team|privacy team|technical lead|reception team|reception|outlet team|hera(?:'|’)s team|staff member)\b/i,
  zh: /沙龙经理|经理|店长|管理团队|授权团队|隐私团队|技术负责人|前台团队|前台|分店团队|Hera团队|工作人员/u,
  ms: /\b(?:pengurus salon|pengurus|pihak pengurusan|pasukan diberi kuasa|pasukan privasi|ketua teknikal|pasukan penerimaan|penerimaan|pasukan cawangan|pasukan Hera|kakitangan)\b/i,
  ta: /சலூன் மேலாளர்|மேலாளர்|நிர்வாகம்|அங்கீகரிக்கப்பட்ட குழு|தனியுரிமை குழு|தொழில்நுட்ப தலைவர்|வரவேற்பு குழு|வரவேற்பு|கிளை குழு|Hera குழு|பணியாளர்/u,
};

const MANAGER_OWNERSHIP: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:salon manager|manager|management)\b/i,
  zh: /沙龙经理|经理|店长|管理团队/u,
  ms: /\b(?:pengurus salon|pengurus|pihak pengurusan)\b/i,
  ta: /சலூன் மேலாளர்|மேலாளர்|நிர்வாகம்/u,
};

const NEXT_STEP: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:review|assess|check|verify|advise|confirm|contact|share|send|seek|arrange|coordinate|update|continue|assist|follow up|next step)\b/i,
  zh: /审核|审查|评估|检查|核实|建议|确认|联系|分享|发送|就医|安排|协调|更新|继续|协助|跟进|下一步/u,
  ms: /\b(?:semak|menilai|periksa|sahkan|nasihat|hubungi|kongsi|hantar|dapatkan|atur|selaras|kemas kini|teruskan|bantu|susulan|langkah seterusnya)\b/i,
  ta: /மதிப்பாய்வு|ஆய்வு|சரிபார்க்க|உறுதிப்படுத்த|ஆலோசனை|தொடர்பு|பகிர|அனுப்ப|மருத்துவ உதவி|ஏற்பாடு|ஒருங்கிணை|புதுப்பிப்பு|தொடர்ந்து|உதவ|அடுத்த படி/u,
};

const VERIFY_ACTION: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:review|assess|check|verify)\b/i,
  zh: /审核|审查|评估|检查|核实/u,
  ms: /\b(?:semak|menilai|periksa|sahkan)\b/i,
  ta: /மதிப்பாய்வு|ஆய்வு|சரிபார்க்க|உறுதிப்படுத்த/u,
};

const CONFIRM_OUTCOME: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:advise|confirm|alternative|available|outcome|next step)\b/i,
  zh: /建议|确认|替代|可预约|结果|下一步/u,
  ms: /\b(?:nasihat|sahkan|alternatif|tersedia|keputusan|langkah seterusnya)\b/i,
  ta: /ஆலோசனை|உறுதிப்படுத்த|மாற்று|கிடைக்கும்|முடிவு|அடுத்த படி/u,
};

const AVAILABILITY: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:live\s+)?availability\b/i,
  zh: /实时档期|档期|可预约时间|空档|有空/u,
  ms: /\b(?:ketersediaan semasa|ketersediaan|slot|masa tersedia)\b/i,
  ta: /நேரடி கிடைப்புத் தன்மை|கிடைப்புத் தன்மை|கிடைக்கும் நேரம்|காலியிடம்/u,
};

const URGENT_SAFETY: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:urgent medical attention|emergency medical attention|emergency services|call 995|seek medical attention|stop using|stop the service|breathing difficulty|severe swelling|eye exposure)\b/i,
  zh: /立即就医|紧急就医|急救服务|拨打995|停止使用|暂停服务|呼吸困难|严重肿胀|眼睛接触/u,
  ms: /\b(?:rawatan perubatan segera|bantuan perubatan kecemasan|perkhidmatan kecemasan|hubungi 995|dapatkan rawatan|berhenti menggunakan|hentikan perkhidmatan|susah bernafas|bengkak teruk|terkena mata)\b/i,
  ta: /அவசர மருத்துவ உதவி|உடனடி மருத்துவ உதவி|அவசர சேவை|995|பயன்பாட்டை நிறுத்த|சேவையை நிறுத்த|மூச்சுத் திணறல்|கடுமையான வீக்கம்|கண்ணில் பட்ட/u,
};

const EMERGENCY_NUMBER: Record<SupportedClientLocale, RegExp> = {
  en: /\b995\b/,
  zh: /995/u,
  ms: /\b995\b/,
  ta: /995/u,
};

const DO_NOT_WAIT_FOR_SALON: Record<SupportedClientLocale, RegExp> = {
  en: /\b(?:do not|don['’]?t)\s+wait\b.{0,100}\b(?:salon|Hera|team|response|reply|follow[ -]?up)\b/i,
  zh: /不要等待(?:沙龙|Hera|团队)?(?:回复|回应|答复|跟进)/u,
  ms: /\bjangan tunggu\b.{0,80}\b(?:salon|Hera|pasukan|jawapan|balasan|respons|susulan)\b/i,
  ta: /காத்திருக்க வேண்டாம்/u,
};

const STOP_PRODUCT_OR_SERVICE: Record<SupportedClientLocale, RegExp> = {
  en: /\bstop (?:using )?(?:the )?product\b|\bpause (?:the )?service\b/i,
  zh: /停止使用(?:该|此)?产品|暂停服务/u,
  ms: /\bhentikan penggunaan produk\b|\bhentikan perkhidmatan\b/i,
  ta: /பொருளைப் பயன்படுத்துவதை.{0,20}நிறுத்த|சேவையை.{0,20}நிறுத்த/u,
};

const AUTHORITY_REQUIRED_INTENTS = new Set<AgentDecision["intent"]>([
  "complaint",
  "refund_compensation",
  "medical_safety",
  "privacy_legal",
]);

function matches(
  patterns: Record<SupportedClientLocale, RegExp>,
  locale: SupportedClientLocale,
  value: string,
): boolean {
  return patterns[locale].test(value);
}

function preservesEmergencyContainment(
  locale: SupportedClientLocale,
  reply: string,
): boolean {
  return matches(URGENT_SAFETY, locale, reply) &&
    matches(EMERGENCY_NUMBER, locale, reply) &&
    matches(DO_NOT_WAIT_FOR_SALON, locale, reply) &&
    matches(STOP_PRODUCT_OR_SERVICE, locale, reply);
}

function normalized(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesKnownFact(reply: string, fact: string | null): boolean {
  if (!fact) return true;
  const expected = normalized(fact);
  if (!expected) return true;
  return normalized(reply).includes(expected);
}

function sentenceCount(reply: string): number {
  return reply
    .split(/[.!?。！？]+/u)
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function activeTaskType(input: {
  decision: AgentDecision;
  handoff: HumanHandoffAssessment;
}): string | null {
  if (!input.handoff.createTask) return null;
  if (input.handoff.taskType) return input.handoff.taskType;
  if (input.decision.intent === "complaint") return "complaint_review";
  if (input.decision.intent === "refund_compensation") return "refund_finance";
  if (input.decision.intent === "medical_safety") return "medical_safety";
  if (input.decision.intent === "privacy_legal") return "privacy_legal";
  return null;
}

export function assessFinalResponseQuality(input: {
  clientMessage: string;
  reply: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
  handoff: HumanHandoffAssessment;
  risk: RiskLevel;
}): FinalResponseQualityAssessment {
  const reply = input.reply.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const issues: string[] = [];
  const locale = detectSupportedClientLocale(input.clientMessage);
  const type = activeTaskType(input);
  const facts = input.handoff.collectedFacts;
  const isEmergency =
    input.risk === "black" || input.handoff.scope === "emergency";
  const distressContext = matches(
    DISTRESS_CONTEXT,
    locale,
    input.clientMessage,
  );
  const needsContextualEmpathy =
    type === "complaint_review" || distressContext;

  if (!reply) issues.push("The final client reply is empty.");
  if (reply.length > 4000) issues.push("The final client reply exceeds the delivery limit.");
  if (INTERNAL_LANGUAGE.test(reply)) {
    issues.push("The final client reply exposes internal operational terminology.");
  }
  if (EMOJI.test(reply) || reply.includes("!") || reply.includes("！")) {
    issues.push("The final client reply uses an emoji or exclamation mark.");
  }
  if (sentenceCount(reply) > 6) {
    issues.push("The final client reply is unnecessarily long.");
  }
  if (BUREAUCRATIC_PROCESS_NOTICE.test(reply)) {
    issues.push(
      "The final reply sounds like a bureaucratic process notice rather than warm, client-centred Hera service.",
    );
  }
  if (
    needsContextualEmpathy &&
    !matches(EMPATHY, locale, reply)
  ) {
    issues.push(
      "The final reply does not acknowledge the client’s personal circumstances with appropriate care.",
    );
  }
  if (
    distressContext &&
    !matches(DISTRESS_CONTEXT, locale, reply)
  ) {
    issues.push(
      "The final reply ignores the specific personal circumstance the client explained.",
    );
  }
  if (
    input.handoff.createTask &&
    type !== "client_requested_human" &&
    GENERIC_HUMAN_ACKNOWLEDGEMENT.test(reply)
  ) {
    issues.push("A specialised handoff was reduced to a crude generic human-assistance message.");
  }
  if (BOOKING_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unverified booking completion.");
  }
  if (FINANCIAL_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unauthorised financial outcome.");
  }
  if (PRIVACY_COMPLETION.test(reply)) {
    issues.push("The final client reply claims an unverified privacy action is complete.");
  }
  if (LIABILITY_ADMISSION.test(reply)) {
    issues.push("The final client reply admits liability or blame.");
  }
  if (GUARANTEED_REMEDY.test(reply)) {
    issues.push("The final client reply promises or guarantees a remedy.");
  }
  if (!input.handoff.createTask && ESCALATION_CLAIM.test(reply)) {
    issues.push("The final reply claims a human escalation that was not durably created.");
  }
  if (
    PRIVACY_HANDOFF_CLAIM.test(reply) &&
    (!input.handoff.createTask ||
      input.handoff.assignedRole !== "privacy_officer")
  ) {
    issues.push("The final reply claims unsupported privacy-team ownership.");
  }
  if (
    MANAGEMENT_HANDOFF_CLAIM.test(reply) &&
    (!input.handoff.createTask ||
      !["salon_manager", "managing_director"].includes(
        input.handoff.assignedRole ?? "",
      ))
  ) {
    issues.push("The final reply claims unsupported management ownership.");
  }
  if (
    AUTHORITY_REQUIRED_INTENTS.has(input.decision.intent) &&
    !input.handoff.createTask
  ) {
    issues.push("A high-consequence request has no durable human-action task.");
  }

  if (type === "complaint_review") {
    if (!matches(EMPATHY, locale, reply)) {
      issues.push("The complaint reply does not acknowledge the client’s experience or concern.");
    }
    if (!matches(MANAGER_OWNERSHIP, locale, reply)) {
      issues.push("The complaint reply does not identify management ownership.");
    }
    if (!matches(NEXT_STEP, locale, reply)) {
      issues.push("The complaint reply does not explain the review or next step.");
    }
    if (!includesKnownFact(reply, facts.service)) {
      issues.push("The complaint reply omits the known service context.");
    }
    if (!includesKnownFact(reply, facts.outlet)) {
      issues.push("The complaint reply omits the known outlet context.");
    }
  }

  if (type === "booking_action") {
    if (
      !matches(VERIFY_ACTION, locale, reply) ||
      !matches(AVAILABILITY, locale, reply)
    ) {
      issues.push("The booking reply does not state that live availability still requires checking.");
    }
    if (!includesKnownFact(reply, facts.service) || !includesKnownFact(reply, facts.outlet)) {
      issues.push("The booking reply omits known booking details.");
    }
  }

  if (type === "appointment_change") {
    if (!matches(VERIFY_ACTION, locale, reply)) {
      issues.push("The appointment-change reply does not state that the existing booking will be verified.");
    }
    if (!matches(CONFIRM_OUTCOME, locale, reply)) {
      issues.push("The appointment-change reply does not explain how the verified outcome will be confirmed.");
    }
  }

  if (type === "refund_finance") {
    if (!matches(OWNERSHIP, locale, reply)) {
      issues.push("The financial reply does not identify authorised review.");
    }
    if (!matches(VERIFY_ACTION, locale, reply)) {
      issues.push("The financial reply does not explain the verification step.");
    }
  }

  if (type === "medical_safety") {
    if (isEmergency) {
      if (!matches(URGENT_SAFETY, locale, reply)) {
        issues.push("The emergency reply does not preserve urgent safety guidance.");
      }
      if (!matches(EMERGENCY_NUMBER, locale, reply)) {
        issues.push("The emergency reply does not give Singapore emergency number 995.");
      }
      if (!matches(DO_NOT_WAIT_FOR_SALON, locale, reply)) {
        issues.push("The emergency reply does not tell the client not to wait for the salon.");
      }
      if (!matches(STOP_PRODUCT_OR_SERVICE, locale, reply)) {
        issues.push("The emergency reply does not tell the client to stop the product or service.");
      }
    }
    if (MEDICAL_CLAIM.test(reply)) {
      issues.push("The safety reply makes a diagnosis or medical-safety claim.");
    }
  }

  if (type === "privacy_legal") {
    if (!matches(OWNERSHIP, locale, reply) || !matches(VERIFY_ACTION, locale, reply)) {
      issues.push("The privacy or legal reply does not identify authorised review.");
    }
  }

  if (type === "arrival_issue") {
    if (!matches(OWNERSHIP, locale, reply) || !matches(NEXT_STEP, locale, reply)) {
      issues.push("The arrival reply does not explain direct outlet coordination.");
    }
  }

  const complete = Boolean(reply) && reply.length <= 4000;
  const clientFacing = !INTERNAL_LANGUAGE.test(reply);
  const safeAuthority = ![
    BOOKING_COMPLETION,
    FINANCIAL_COMPLETION,
    PRIVACY_COMPLETION,
    LIABILITY_ADMISSION,
    GUARANTEED_REMEDY,
  ].some((pattern) => pattern.test(reply));
  const contextualEmpathy = needsContextualEmpathy
    ? matches(EMPATHY, locale, reply) &&
      (!distressContext || matches(DISTRESS_CONTEXT, locale, reply))
    : true;
  const specificity =
    type === "complaint_review" || type === "booking_action"
      ? includesKnownFact(reply, facts.service) && includesKnownFact(reply, facts.outlet)
      : true;
  const ownership = input.handoff.createTask
    ? type === "medical_safety" && isEmergency
      ? preservesEmergencyContainment(locale, reply)
      : matches(OWNERSHIP, locale, reply)
    : true;
  const nextStep = input.handoff.createTask
    ? type === "medical_safety" && isEmergency
      ? preservesEmergencyContainment(locale, reply)
      : matches(NEXT_STEP, locale, reply)
    : true;
  const conciseTone =
    !EMOJI.test(reply) &&
    !reply.includes("!") &&
    !reply.includes("！") &&
    !BUREAUCRATIC_PROCESS_NOTICE.test(reply) &&
    sentenceCount(reply) <= 6;

  if (input.handoff.createTask && !ownership) {
    issues.push("The final reply does not identify clear human ownership.");
  }
  if (input.handoff.createTask && !nextStep) {
    issues.push("The final reply does not explain the next useful step.");
  }

  const checks = {
    complete,
    clientFacing,
    safeAuthority,
    contextualEmpathy,
    specificity,
    ownership,
    nextStep,
    conciseTone,
  };

  return {
    passed: issues.length === 0 && Object.values(checks).every(Boolean),
    issues: [...new Set(issues)],
    checks,
  };
}
