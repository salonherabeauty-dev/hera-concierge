import type {
  WebsiteConciergeDecision,
  WebsiteConciergeEvidenceBundle,
  WebsiteConciergeValidation,
} from "./types.js";

export const WEBSITE_CONCIERGE_VALIDATOR_VERSION =
  "hera-website-concierge-validator-1.0.0";

const INTERNAL_LANGUAGE = [
  /\b(?:system prompt|hidden instruction|backend|database|policy engine|verifier|model id|candidate|outbox|internal queue|tool call)\b/i,
];

const FALSE_OPERATIONAL_OUTCOME = [
  /\bwe(?:'ve| have)\s+(?:now\s+)?(?:booked|confirmed|cancelled|canceled|changed|moved|rescheduled|updated)\b/i,
  /\byour\s+(?:booking|appointment)\s+(?:has been|is now)\s+(?:booked|confirmed|cancelled|canceled|changed|moved|rescheduled|updated)\b/i,
  /\bthe\s+(?:booking|appointment|change|cancellation)\s+(?:has been|is now)\s+(?:confirmed|completed|processed|done)\b/i,
  /\b(?:is|are)\s+(?:available|free)\s+(?:today|tomorrow|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d)/i,
];

const UNAUTHORISED_FINANCIAL_OUTCOME = [
  /\bwe(?:'ll| will| have|’ll)\s+(?:issue|process|provide|give|approve)\s+(?:(?:you|your)\s+)?(?:a\s+)?(?:full\s+|partial\s+)?(?:refund|voucher|compensation|credit)\b/i,
  /\byour\s+(?:refund|compensation|voucher|credit)\s+(?:is|has been)\s+(?:approved|confirmed|processed|issued)\b/i,
];

const LIABILITY_ADMISSION = [
  /\b(?:we|hera)\s+(?:accept|accepts|admit|admits)\s+(?:full\s+)?(?:legal\s+)?(?:liability|fault|negligence)\b/i,
  /\b(?:we|hera)\s+(?:caused|were responsible for|are responsible for)\s+(?:your|the)\s+(?:injury|damage|burn|hair loss)\b/i,
];

const MEDICAL_DIAGNOSIS = [
  /\byou\s+(?:have|are suffering from)\s+(?:an?\s+)?(?:allergic reaction|chemical burn|infection|dermatitis|alopecia|scalp disease)\b/i,
  /\bthis\s+is\s+(?:definitely|clearly|certainly)\s+(?:an?\s+)?(?:allergic reaction|chemical burn|infection|dermatitis)\b/i,
];

const CURRENT_EMERGENCY = [
  /\bi\s+(?:cannot|can't|can’t)\s+breathe\b/i,
  /\bmy\s+(?:face|lips|tongue|throat|eyes?)\s+(?:is|are)\s+(?:swollen|burning|closing|blistering)\b/i,
  /\bchemical\s+(?:is|went|got)\s+in\s+my\s+eyes?\b/i,
  /\bi\s+(?:feel|am feeling)\s+(?:faint|dizzy)\s+(?:right now|now|currently|at the moment)\b/i,
];

const URGENT_GUIDANCE = [
  /\bseek\s+(?:urgent|immediate|emergency)\s+medical\s+(?:care|attention|help)\b/i,
  /\bcall\s+(?:995|emergency services)\b/i,
  /\bgo\s+to\s+(?:the\s+)?(?:nearest\s+)?(?:a&e|emergency department|hospital)\b/i,
];

function hasAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function citedIds(decision: WebsiteConciergeDecision): Set<string> {
  return new Set(decision.verifiedFactsUsed.map((item) => item.sourceId));
}

export function validateWebsiteConciergeDecision(input: {
  decision: WebsiteConciergeDecision;
  evidence: WebsiteConciergeEvidenceBundle;
}): WebsiteConciergeValidation {
  const reply = input.decision.reply.trim();
  const issues: string[] = [];

  if (reply.length < 1 || reply.length > 4000) {
    issues.push("The website reply must contain between 1 and 4,000 characters.");
  }
  if (hasAny(reply, INTERNAL_LANGUAGE)) {
    issues.push("The reply exposes internal system terminology.");
  }
  if (hasAny(reply, FALSE_OPERATIONAL_OUTCOME)) {
    issues.push("The reply claims unverified live availability or a completed booking action.");
  }
  if (hasAny(reply, UNAUTHORISED_FINANCIAL_OUTCOME)) {
    issues.push("The reply promises or confirms a refund, compensation, voucher or credit.");
  }
  if (hasAny(reply, LIABILITY_ADMISSION)) {
    issues.push("The reply admits liability, fault or causation.");
  }
  if (hasAny(reply, MEDICAL_DIAGNOSIS)) {
    issues.push("The reply makes a medical diagnosis.");
  }
  if (
    hasAny(input.evidence.visitorMessage, CURRENT_EMERGENCY) &&
    !hasAny(reply, URGENT_GUIDANCE)
  ) {
    issues.push("A current emergency lacks clear urgent medical guidance.");
  }

  const available = new Set(input.evidence.knowledge.map((item) => item.id));
  const cited = citedIds(input.decision);
  for (const id of cited) {
    if (!available.has(id)) {
      issues.push(`The reply cites an unavailable Hera evidence source: ${id}.`);
    }
  }

  if (/\b(?:S\$|SGD|\$)\s*\d/i.test(reply)) {
    const linkedPrice = input.evidence.knowledge.some(
      (item) => item.category === "price" && cited.has(item.id),
    );
    if (!linkedPrice) {
      issues.push("A stated price is not linked to approved Hera price evidence.");
    }
  }

  if (
    input.evidence.outletClarificationOperationallyRelevant &&
    input.decision.resolvedOutlet === "unspecified" &&
    !input.decision.needsOutletClarification
  ) {
    issues.push("An outlet-dependent request did not request the needed outlet clarification.");
  }

  if (
    input.decision.resolvedOutlet === "sentosa" &&
    input.decision.suggestedActions.includes("contact_tanglin")
  ) {
    issues.push("The suggested contact action conflicts with the resolved Sentosa outlet.");
  }
  if (
    input.decision.resolvedOutlet === "tanglin" &&
    input.decision.suggestedActions.includes("contact_sentosa")
  ) {
    issues.push("The suggested contact action conflicts with the resolved Tanglin outlet.");
  }

  const unique = [...new Set(issues)].slice(0, 12);
  return {
    passed: unique.length === 0,
    issues: unique,
    policyVersion: WEBSITE_CONCIERGE_VALIDATOR_VERSION,
    checkedAt: new Date().toISOString(),
  };
}
