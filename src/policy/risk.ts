import type { AgentDecision, PolicyAssessment, RiskLevel } from "../types.js";

export const POLICY_VERSION = "hera-whatsapp-policy-1.0.0";

const RISK_RANK: Record<RiskLevel, number> = {
  green: 0,
  amber: 1,
  red: 2,
  black: 3,
};

const BLACK_PATTERNS = [
  /(?:i\s*(?:can'?t|cannot)|unable to)\s*breathe/i,
  /difficulty breathing|trouble breathing|throat (?:is )?closing/i,
  /severe (?:facial )?swelling|face (?:is )?swelling/i,
  /unconscious|collapsed|anaphylaxis/i,
  /severe (?:chemical )?burn|blistering|chemical (?:in|near) (?:my )?eyes?/i,
  /threat(?:en|ening)? (?:to )?(?:hurt|kill)|physical violence/i,
];

const RED_PATTERNS = [
  /lawyer|legal action|sue|court|police report|cctv|evidence request/i,
  /chargeback|compensation|refund|money back/i,
  /allergic|allergy|burn(?:ed|t)?|scalp (?:pain|wound|injury)|hair (?:loss|falling out)/i,
  /damage(?:d)? my hair|chemical injury/i,
  /harass(?:ed|ment)|discriminat(?:ed|ion)|threaten(?:ed|ing)/i,
  /delete my data|privacy complaint|personal data|pdpa/i,
];

const AMBER_PATTERNS = [
  /complaint|unhappy|upset|disappointed|dissatisfied/i,
  /too (?:short|dark|light|warm|cool)|brassy|uneven|patchy/i,
  /overcharg(?:ed|ing)|price dispute|unexpected (?:charge|price)/i,
  /rude|unprofessional|waited|running late|late for my appointment/i,
  /redo|re-do|fix my hair|service concern|not what i (?:asked|wanted)/i,
  /strand test (?:has )?(?:failed|did not pass)|failed (?:the )?strand test/i,
];

const INJECTION_PATTERNS = [
  /ignore (?:all |the )?(?:previous|prior|system) instructions/i,
  /reveal (?:the )?(?:system prompt|hidden instructions|knowledge base)/i,
  /developer message|jailbreak|bypass (?:the )?(?:rules|policy|safety)/i,
  /act as if you (?:have|had) no restrictions/i,
];

const UNAUTHORISED_ACTION_PATTERNS = [
  /(?:i|we)(?:'ve| have) (?:booked|cancelled|rescheduled) (?:your|the) appointment/i,
  /(?:i|we) will (?:refund|compensate|reimburse)/i,
  /(?:your )?refund (?:is|has been) (?:approved|processed)/i,
  /(?:i have|i've|we have|we've) applied (?:the |a )?(?:10% )?discount/i,
  /(?:the |your )?(?:10% )?discount (?:is|has been) applied/i,
  /guarantee(?:d)? (?:result|outcome|damage-free|safe)/i,
  /(?:this is|you have) (?:an allergy|a chemical burn|alopecia|eczema|psoriasis)/i,
];

export const URGENT_SAFETY_REPLY =
  "Thank you for telling me. Please stop using the product or pause the service immediately. If you have severe pain, swelling, breathing difficulty, eye exposure or another urgent symptom, seek urgent medical attention now. I have marked this as an urgent Hera concern; when safe, please send the appointment name and date, what was used if known, and clear photos. This is not a medical diagnosis.";

export const SAFE_CONCERN_REPLY =
  "I’m sorry to hear this. I’ve opened a priority service concern so the facts can be reviewed carefully. Please share the appointment name and date, stylist if known, what happened, and clear photos where relevant. I won’t make assumptions or promise a remedy before the details are reviewed, but I’ll keep the case organised here.";

export const SAFE_MEDICAL_CONCERN_REPLY =
  "I’m sorry you’re experiencing this. Please stop using the product or pause the service. If pain, burning, swelling, rash, eye irritation or other symptoms are significant or worsening, seek prompt medical attention. I’ve opened a priority Hera concern; when safe, please share the appointment name and date, what was used if known, and clear photos. This is not a medical diagnosis.";

export const SAFE_PRIVACY_LEGAL_REPLY =
  "I’ve recorded your privacy or legal request as a priority case. To protect personal data, identity and scope must be verified before any access, correction, deletion, CCTV or evidence action. Please provide the appointment name and date and state the exact records or action requested; I won’t expose information or promise an outcome before verification.";

export const SAFE_WAIT_RECOVERY_REPLY =
  "You’re right to flag a wait beyond 10 minutes. Hera’s stated service-recovery policy is a 10% discount. I’ve recorded the concern, but I cannot claim the bill has been updated until the transaction is confirmed.";

export const SAFE_STRAND_TEST_REPLY =
  "A failed strand test means bleach should not proceed. Hair and client safety take priority over the requested colour result; the safer next step is a stylist-led alternative plan that does not override the failed test.";

export const SAFE_BOOKING_REPLY =
  "I can help you choose the right service and check any appointment details already recorded, but I cannot claim a booking change until the booking system confirms it. Please use Hera’s secure booking page: https://bookings.gettimely.com/herabeauty1/bb/book, or tell me the appointment name and date you want checked.";

export function highestRisk(...levels: RiskLevel[]): RiskLevel {
  return levels.reduce((highest, level) =>
    RISK_RANK[level] > RISK_RANK[highest] ? level : highest,
  );
}

export function classifyDeterministicRisk(input: string): {
  risk: RiskLevel;
  securityFlags: string[];
} {
  const value = input.slice(0, 20_000);
  const securityFlags = INJECTION_PATTERNS.some((pattern) => pattern.test(value))
    ? ["prompt_injection_attempt"]
    : [];
  if (BLACK_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "black", securityFlags };
  }
  if (RED_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "red", securityFlags };
  }
  if (AMBER_PATTERNS.some((pattern) => pattern.test(value))) {
    return { risk: "amber", securityFlags };
  }
  return { risk: "green", securityFlags };
}

export function assessPolicy(input: string, decision: AgentDecision): PolicyAssessment {
  const deterministic = classifyDeterministicRisk(input);
  const risk = highestRisk(deterministic.risk, decision.risk);
  const blockedActions = UNAUTHORISED_ACTION_PATTERNS.filter((pattern) =>
    pattern.test(decision.reply),
  ).map((pattern) => pattern.source);

  let replyOverride: string | null = null;
  const failedStrandTest =
    /strand test (?:has )?(?:failed|did not pass)|failed (?:the )?strand test/i.test(input);
  const lateBeyondTenMinutes =
    /(?:waited|waiting|wait)\D{0,20}(?:1[1-9]|[2-9][0-9])\s*(?:minutes?|mins?)/i.test(input);
  const medicalConcern =
    decision.intent === "medical_safety" ||
    /allergic|allergy|burn(?:ed|t)?|scalp (?:pain|wound|injury)|hair (?:loss|falling out)/i.test(input);
  const privacyLegalConcern =
    decision.intent === "privacy_legal" ||
    /lawyer|legal action|court|cctv|evidence request|delete my data|privacy|pdpa/i.test(input);

  if (risk === "black") replyOverride = URGENT_SAFETY_REPLY;
  else if (failedStrandTest) replyOverride = SAFE_STRAND_TEST_REPLY;
  else if (lateBeyondTenMinutes && blockedActions.length > 0) {
    replyOverride = SAFE_WAIT_RECOVERY_REPLY;
  } else if (blockedActions.length > 0 && decision.intent === "booking") {
    replyOverride = SAFE_BOOKING_REPLY;
  } else if (risk === "red" && medicalConcern) {
    replyOverride = SAFE_MEDICAL_CONCERN_REPLY;
  } else if (risk === "red" && privacyLegalConcern) {
    replyOverride = SAFE_PRIVACY_LEGAL_REPLY;
  } else if (blockedActions.length > 0 || risk === "red") {
    replyOverride = SAFE_CONCERN_REPLY;
  }

  return {
    risk,
    canAutoSend: true,
    requiresManagementNotification:
      risk === "red" || risk === "black" || decision.requiresManagementNotification,
    requiresIncident: risk !== "green" || decision.proposedActions.includes("open_incident"),
    blockedActions,
    securityFlags: deterministic.securityFlags,
    replyOverride,
  };
}
