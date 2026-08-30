import type {
  ResetEvidencePacket,
  ResetModelDraft,
  ResetValidationResult,
} from "./types.js";

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
  "Phoebe",
  "Phoeve",
  "Rujean",
  "Tamson",
] as const;

const CURRENT_EMERGENCY = [
  /\b(?:i am|i'm|i’m|i feel|i have|my (?:face|throat|scalp|eye|eyes|skin) (?:is|are))\b.{0,80}\b(?:cannot breathe|can't breathe|can’t breathe|difficulty breathing|severe swelling|swelling rapidly|chemical (?:in|inside) (?:my )?eye|severe pain|blistering)\b/i,
  /\b(?:cannot breathe|can't breathe|can’t breathe|difficulty breathing)\b.{0,50}\b(?:now|currently|today|after the service|after the product)\b/i,
];

const HISTORICAL_OR_REPORTED = [
  /\b(?:letter of demand|medical report|doctor's letter|doctor’s letter|legal notice|lawyer|solicitor)\b/i,
  /\b(?:was|were|had been|previously|last week|last month|on \d{1,2}\s+[A-Za-z]+\s+20\d{2})\b.{0,100}\b(?:diagnosed|burn|injury|swelling|pain|dermatitis|alopecia)\b/i,
  /\b(?:she|he|the client|the claimant|ms\.?|mr\.?)\b.{0,100}\b(?:reported|alleged|described|was diagnosed|suffered)\b/i,
];

const BUREAUCRATIC_LANGUAGE = [
  /\bauthori[sz]ed to (?:review|verify|handle)\b/i,
  /\btransaction request\b/i,
  /\bverification and confirmation\b/i,
  /\bconfirmed outcome\b/i,
  /\bso that (?:the|our) review is as accurate as possible\b/i,
  /\bonce the review is complete\b/i,
  /\bthe relevant team\b/i,
  /\ba staff member will continue\b/i,
  /\bverify (?:the )?appointment and payment records\b/i,
];

const FALSE_BOOKING_COMPLETION = [
  /\b(?:i|we)(?:'ve| have)?\s+(?:booked|rescheduled|rebooked|moved|changed|cancelled|canceled|confirmed|secured)\s+(?:your|the)\s+(?:appointment|booking)\b/i,
  /\b(?:your|the)\s+(?:appointment|booking)\s+(?:has been|is now|is)\s+(?:booked|rescheduled|rebooked|moved|changed|cancelled|canceled|confirmed|secured)\b/i,
  /\b(?:you are|you're|you’re)\s+(?:booked|confirmed)\s+(?:for|with|at)\b/i,
];

const UNAUTHORISED_FINANCIAL_PROMISE = [
  /\b(?:your|the)\s+refund\s+(?:has been|is|was)\s+(?:approved|processed|issued|confirmed)\b/i,
  /\b(?:i|we)\s+(?:will|can|shall)\s+(?:refund|reimburse|compensate)\b/i,
  /\b(?:i|we)\s+(?:will|can|shall)\s+(?:provide|offer|give|issue)\s+(?:you\s+)?(?:a\s+)?(?:complimentary|free|voucher|credit|compensation)\b/i,
];

const LIABILITY_ADMISSION = [
  /\b(?:hera|we)\s+(?:is|are|were|was)\s+(?:legally\s+)?(?:liable|at fault)\b/i,
  /\b(?:hera|we)\s+(?:accept|admit)\s+(?:full\s+)?(?:liability|fault|responsibility for causing)\b/i,
];

const MEDICAL_DIAGNOSIS = [
  /\byou\s+(?:have|are suffering from|definitely have)\s+(?:a\s+)?(?:chemical burn|contact dermatitis|alopecia|infection|allergic reaction)\b/i,
  /\bthis\s+(?:is|means you have)\s+(?:a\s+)?(?:chemical burn|contact dermatitis|alopecia|infection|allergic reaction)\b/i,
];

const INTERNAL_TERMS = [
  /\b(?:system prompt|backend|handoff object|policy engine|verifier|model reasoning|database queue|internal queue|candidate hash|outbox)\b/i,
];

const PRICE_CLAIM = /(?:S\$|SGD|\$)\s?\d|\b\d+(?:\.\d+)?%\s*GST\b/i;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function isGenuineCurrentEmergency(clientTurnText: string): boolean {
  const current = hasAny(clientTurnText, CURRENT_EMERGENCY);
  if (!current) return false;
  const strongNow = /\b(?:now|right now|currently|at the moment|cannot breathe|can't breathe|can’t breathe)\b/i.test(
    clientTurnText,
  );
  if (strongNow) return true;
  return !hasAny(clientTurnText, HISTORICAL_OR_REPORTED);
}

function evidenceText(evidence: ResetEvidencePacket): string {
  return evidence.knowledge
    .map((item) => `${item.id}\n${item.title}\n${item.excerpt}`)
    .join("\n")
    .toLowerCase();
}

function evidenceIds(evidence: ResetEvidencePacket): Set<string> {
  return new Set(evidence.knowledge.map((item) => item.id));
}

function staffEvidenceExists(name: string, evidence: ResetEvidencePacket): boolean {
  const lower = name.toLowerCase();
  return evidence.knowledge.some(
    (item) =>
      item.title.toLowerCase().includes(lower) ||
      item.excerpt.toLowerCase().includes(`staff: ${lower}`),
  );
}

export function validateResetDraft(input: {
  clientTurnText: string;
  draft: ResetModelDraft;
  evidence: ResetEvidencePacket;
}): ResetValidationResult {
  const reply = input.draft.finalReply.trim();
  const issues: string[] = [];
  const evidenceBody = evidenceText(input.evidence);
  const validEvidenceIds = evidenceIds(input.evidence);

  if (!reply || reply.length > 4000) {
    issues.push("The client reply must contain between 1 and 4000 characters.");
  }
  if (hasAny(reply, FALSE_BOOKING_COMPLETION)) {
    issues.push(
      "The reply falsely claims that a booking, cancellation or appointment change is already complete.",
    );
  }
  if (hasAny(reply, UNAUTHORISED_FINANCIAL_PROMISE)) {
    issues.push(
      "The reply promises a refund, compensation, voucher or complimentary outcome without verified authority.",
    );
  }
  if (hasAny(reply, LIABILITY_ADMISSION)) {
    issues.push("The reply admits liability or fault on Hera's behalf.");
  }
  if (hasAny(reply, MEDICAL_DIAGNOSIS)) {
    issues.push("The reply makes a medical diagnosis.");
  }
  if (hasAny(reply, INTERNAL_TERMS)) {
    issues.push("The reply exposes internal system or workflow terminology.");
  }
  if (hasAny(reply, BUREAUCRATIC_LANGUAGE)) {
    issues.push(
      "The reply contains bureaucratic, process-led wording below Hera's client-care standard.",
    );
  }
  if (/\b(?:Sentosa|Quayside(?: Isle)?)\b/i.test(reply)) {
    issues.push(
      "The reply conflicts with the Tanglin Mall-only WhatsApp channel.",
    );
  }
  if (/\b(?:which|what)\s+(?:Hera\s+)?(?:outlet|atelier)\b/i.test(reply)) {
    issues.push("The reply asks for an outlet that is already known to be Tanglin Mall.");
  }

  const emergency = isGenuineCurrentEmergency(input.clientTurnText);
  if (emergency) {
    if (!/\b995\b/.test(reply)) {
      issues.push("A genuine current emergency reply must include Singapore emergency number 995.");
    }
    if (!/\b(?:urgent|immediate|immediately|emergency)\b/i.test(reply)) {
      issues.push("A genuine current emergency reply must prioritise immediate medical help.");
    }
    if (!/\b(?:do not wait|don't wait|don’t wait)\b/i.test(reply)) {
      issues.push("A genuine current emergency reply must tell the client not to wait for the salon.");
    }
  } else if (input.draft.currentEmergency) {
    issues.push(
      "The model classified historical or reported symptoms as a current emergency without deterministic support.",
    );
  }

  if (PRICE_CLAIM.test(reply)) {
    const hasPriceEvidence = input.evidence.knowledge.some(
      (item) =>
        /\bprice\b/i.test(item.title) ||
        /(?:S\$|SGD|\$)\s?\d|\b9%\s*GST\b/i.test(item.excerpt),
    );
    if (!hasPriceEvidence) {
      issues.push("The reply states a price or GST figure without approved price evidence.");
    }
  }

  for (const name of STAFF_NAMES) {
    if (new RegExp(`\\b${name}\\b`, "i").test(reply) && !staffEvidenceExists(name, input.evidence)) {
      issues.push(`The reply names ${name} without an approved staff-expertise record in this run.`);
    }
  }

  if (/\bTamson\b/i.test(reply) && /maternity leave|temporarily unavailable/i.test(evidenceBody)) {
    if (!/\b(?:future|return|after|from|subject to|confirm)\b/i.test(reply)) {
      issues.push("The reply presents Tamson as currently available despite approved leave information.");
    }
  }

  for (const id of input.draft.usedEvidenceIds) {
    if (!validEvidenceIds.has(id)) {
      issues.push(`The model cited evidence id ${id} that was not retrieved for this turn.`);
    }
  }

  return {
    passed: issues.length === 0,
    issues: dedupe(issues),
  };
}
