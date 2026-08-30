import type {
  ResetDraftDecision,
  ResetDraftValidation,
  ResetEvidenceBundle,
} from "./types.js";

export const RESET_DRAFT_VALIDATOR_VERSION =
  "hera-receptionist-reset-validator-1.0.0";

const INTERNAL_LANGUAGE = [
  /\b(?:system prompt|hidden instruction|backend|database row|handoff object|policy engine|verifier|model id|outbox|candidate hash|internal queue)\b/i,
  /\b(?:full_takeover|task_only|deliveryEligible|send_authorization)\b/i,
];

const TANGLIN_CONFLICTS = [
  /\b(?:which|what)\s+(?:Hera\s+)?(?:outlet|atelier)\b/i,
  /\b(?:Tanglin(?: Mall)?|our outlet)\b.{0,80}\b(?:or|versus)\b.{0,40}\b(?:Sentosa|Quayside)\b/i,
  /\b(?:Sentosa|Quayside)\b.{0,70}\b(?:team|reception|salon|outlet|atelier|appointment|availability|booking)\b/i,
];

const FALSE_OPERATIONAL_COMPLETION = [
  /\bwe(?:'ve| have)\s+(?:now\s+)?(?:booked|confirmed|cancelled|canceled|changed|moved|rescheduled|updated)\b/i,
  /\byour\s+(?:booking|appointment)\s+(?:has been|is now|is)\s+(?:booked|confirmed|cancelled|canceled|changed|moved|rescheduled|updated)\b/i,
  /\bthe\s+(?:booking|appointment|change|cancellation)\s+(?:has been|is now)\s+(?:confirmed|completed|processed|done)\b/i,
];

const UNAUTHORISED_FINANCIAL_OUTCOME = [
  /\bwe(?:'ll| will| have|’ll)\s+(?:issue|process|provide|give|approve)\s+(?:you\s+)?(?:a\s+)?(?:full\s+|partial\s+)?(?:refund|voucher|compensation|credit)\b/i,
  /\byour\s+(?:refund|compensation|voucher|credit)\s+(?:is|has been)\s+(?:approved|confirmed|processed|issued)\b/i,
  /\byou\s+will\s+(?:receive|be refunded|be compensated)\b/i,
];

const LIABILITY_ADMISSION = [
  /\bwe\s+(?:accept|admit)\s+(?:full\s+)?(?:liability|fault|negligence)\b/i,
  /\bour\s+(?:negligence|fault|mistake)\s+(?:caused|resulted in)\b/i,
  /\bwe\s+caused\s+(?:your|the)\s+(?:injury|damage|hair loss|burn)\b/i,
];

const MEDICAL_DIAGNOSIS = [
  /\byou\s+(?:have|are suffering from)\s+(?:an?\s+)?(?:allergic reaction|chemical burn|infection|dermatitis|alopecia|scalp disease)\b/i,
  /\bthis\s+is\s+(?:definitely|clearly|certainly)\s+(?:an?\s+)?(?:allergic reaction|chemical burn|infection|dermatitis)\b/i,
];

const BUREAUCRATIC_CLIENT_COPY = [
  /\bauthori[sz]ed to (?:review|verify|handle)\b/i,
  /\bverification and confirmation\b/i,
  /\bconfirmed outcome\b/i,
  /\btransaction request\b/i,
  /\bso that (?:the|our) review is as accurate as possible\b/i,
  /\bonce the review is complete\b/i,
];

const LEGAL_OR_HISTORICAL_MARKERS = [
  /\bletter of demand\b/i,
  /\bour ref\b/i,
  /\badvocates?\s*&?\s*solicitors?\b/i,
  /\bclaimant\b/i,
  /\bmedical (?:report|certificate|records?)\b/i,
  /\balleg(?:e|ed|ation)\b/i,
  /\bon\s+\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+20\d{2}\b/i,
  /\b(?:was|were|had been)\s+(?:treated|diagnosed|injured|burned|burnt)\b/i,
];

const CURRENT_FIRST_PERSON_EMERGENCY = [
  /\bi\s+(?:am|'m|’m)\s+(?:currently\s+)?(?:having|experiencing|suffering from)\s+(?:difficulty breathing|trouble breathing|severe swelling|severe pain|blistering|eye pain)\b/i,
  /\bi\s+(?:cannot|can't|can’t)\s+breathe\b/i,
  /\bmy\s+(?:face|lips|tongue|throat|eyes?)\s+(?:is|are)\s+(?:swollen|burning|closing|blistering)\b/i,
  /\bchemical\s+(?:is|went|got)\s+in\s+my\s+eyes?\b/i,
  /\bi\s+(?:feel|am feeling)\s+(?:faint|dizzy)\s+(?:right now|now)\b/i,
];

const URGENT_GUIDANCE = [
  /\bseek\s+(?:urgent|immediate|emergency)\s+medical\s+(?:care|attention|help)\b/i,
  /\bcall\s+(?:995|emergency services)\b/i,
  /\bgo\s+to\s+(?:the\s+)?(?:nearest\s+)?(?:a&e|emergency department|hospital)\b/i,
];

function normalizeIssue(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function currentEmergencyFromText(text: string): boolean {
  if (!hasAny(text, CURRENT_FIRST_PERSON_EMERGENCY)) return false;
  const looksLikeHistoricalLegalDocument = hasAny(text, LEGAL_OR_HISTORICAL_MARKERS);
  const explicitlyCurrent = /\b(?:right now|currently|at the moment|today|now)\b/i.test(text);
  return !looksLikeHistoricalLegalDocument || explicitlyCurrent;
}

function evidenceIds(bundle: ResetEvidenceBundle): Set<string> {
  return new Set(bundle.knowledge.map((item) => item.id));
}

function usedIds(decision: ResetDraftDecision): Set<string> {
  return new Set(decision.verifiedFactsUsed.map((item) => item.sourceId));
}

function staffNames(bundle: ResetEvidenceBundle): string[] {
  return bundle.knowledge
    .filter((item) => item.category === "staff")
    .map((item) => item.title.match(/expertise\s+[—-]\s+(.+)$/i)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function mentionsName(reply: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(reply);
}

export function validateResetDraft(input: {
  decision: ResetDraftDecision;
  evidence: ResetEvidenceBundle;
}): ResetDraftValidation {
  const reply = input.decision.finalReply.trim();
  const clientTurn = input.evidence.consolidatedClientTurn;
  const issues: string[] = [];

  if (reply.length < 1 || reply.length > 4000) {
    issues.push("The client reply must contain between 1 and 4,000 characters.");
  }
  if (hasAny(reply, INTERNAL_LANGUAGE)) {
    issues.push("The reply exposes internal system or workflow terminology.");
  }
  if (hasAny(reply, TANGLIN_CONFLICTS)) {
    issues.push("The reply conflicts with the Tanglin Mall-only WhatsApp channel.");
  }
  if (hasAny(reply, FALSE_OPERATIONAL_COMPLETION)) {
    issues.push("The reply claims an unverified booking, change, cancellation or confirmation outcome.");
  }
  if (hasAny(reply, UNAUTHORISED_FINANCIAL_OUTCOME)) {
    issues.push("The reply promises a refund, voucher, credit or compensation without authorised approval.");
  }
  if (hasAny(reply, LIABILITY_ADMISSION)) {
    issues.push("The reply admits legal liability, fault or causation.");
  }
  if (hasAny(reply, MEDICAL_DIAGNOSIS)) {
    issues.push("The reply makes a medical diagnosis.");
  }
  if (hasAny(reply, BUREAUCRATIC_CLIENT_COPY)) {
    issues.push("The reply contains bureaucratic wording below Hera's client-care standard.");
  }

  const deterministicEmergency = currentEmergencyFromText(clientTurn);
  if ((input.decision.currentEmergency || deterministicEmergency) && !hasAny(reply, URGENT_GUIDANCE)) {
    issues.push("A genuinely current emergency lacks clear urgent medical guidance.");
  }
  if (!deterministicEmergency && hasAny(clientTurn, LEGAL_OR_HISTORICAL_MARKERS) && input.decision.currentEmergency) {
    issues.push("Historical or third-party medical allegations were incorrectly classified as a current emergency.");
  }

  const availableSourceIds = evidenceIds(input.evidence);
  const citedSourceIds = usedIds(input.decision);
  for (const sourceId of citedSourceIds) {
    if (!availableSourceIds.has(sourceId) && sourceId !== "current-client-appointments") {
      issues.push(`The reply cites an unavailable evidence source: ${sourceId}.`);
    }
  }

  if (/\b(?:S\$|SGD|\$)\s*\d/i.test(reply)) {
    const hasPriceEvidence = input.evidence.knowledge.some(
      (item) => item.category === "price" && citedSourceIds.has(item.id),
    );
    if (!hasPriceEvidence) {
      issues.push("A stated price is not linked to approved Tanglin-eligible price evidence.");
    }
  }

  const mentionedStaff = staffNames(input.evidence).filter((name) =>
    mentionsName(reply, name),
  );
  for (const name of mentionedStaff) {
    const supported = input.evidence.knowledge.some(
      (item) =>
        item.category === "staff" &&
        item.title.toLowerCase().includes(name.toLowerCase()) &&
        citedSourceIds.has(item.id),
    );
    if (!supported) {
      issues.push(`The stylist recommendation for ${name} is not linked to the retrieved approved staff record.`);
    }
  }

  const uniqueIssues = [...new Set(issues.map(normalizeIssue))].slice(0, 12);
  return {
    passed: uniqueIssues.length === 0,
    issues: uniqueIssues,
    checkedAt: new Date().toISOString(),
    policyVersion: RESET_DRAFT_VALIDATOR_VERSION,
  };
}
