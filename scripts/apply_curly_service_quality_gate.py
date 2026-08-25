from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise RuntimeError(f"Expected patch anchor was not found in {path}: {old[:180]!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


service_information = ROOT / "src/policy/serviceInformation.ts"
service_information.write_text(
    '''import type { AgentDecision, PolicyAssessment } from "../types.js";

export const SERVICE_INFORMATION_POLICY_VERSION = "hera-service-information-1.0.0";
export const CURL_SERVICE_SOURCE_ID = "hera-operator-curly-service-matrix-v2";

export interface ServiceInformationAssessment {
  matched: boolean;
  reply: string | null;
  reason: string;
  sourceIds: string[];
}

const CURL_TERMS = /\\b(?:curly|curl|curls|wavy|waves|coily|coils|textured hair)\\b/i;
const SERVICE_TERMS = /\\b(?:haircut|haircuts|cut|cuts|service|services|specialist|specialise|specialize|offer|offers|provide|provides|have|has|do)\\b/i;
const SPECIALIST_MATCH = /(?:\\b(?:who|which|recommend|recommended|best|most suitable|specialist|stylist)\\b.{0,80}\\b(?:curly|curl|curls|wavy|waves|coily|coils)\\b|\\b(?:curly|curl|curls|wavy|waves|coily|coils)\\b.{0,80}\\b(?:specialist|stylist|recommend|best|most suitable)\\b)/i;
const BOOKING_OR_LIVE_ACTION = /\\b(?:book|booking|appointment|reserve|reservation|schedule|slot|slots|available|availability|reschedule|cancel|change my appointment|today|tomorrow|this friday|this saturday|this sunday|next week|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b/i;
const HUMAN_AUTHORITY = /\\b(?:human|person|receptionist|manager|owner|staff member|take over|speak to|talk to|call me)\\b/i;
const HIGH_CONSEQUENCE = /\\b(?:complaint|unhappy|refund|compensation|damage|damaged|burn|burning|pain|allergy|allergic|swelling|rash|hair loss|lawyer|legal|cctv|privacy|pdpa|delete my data|chargeback)\\b/i;
const PRICE_TERMS = /\\b(?:price|prices|pricing|cost|how much|gst)\\b/i;

const TANGIN = /\\btanglin(?: mall)?\\b/i;
const SENTOSA = /\\b(?:sentosa(?: cove)?|quayside(?: isle)?)\\b/i;

function noMatch(reason: string): ServiceInformationAssessment {
  return { matched: false, reply: null, reason, sourceIds: [] };
}

function curlyServiceReply(message: string): string {
  if (TANGIN.test(message)) {
    return "Yes. Hera’s Tanglin Mall atelier offers specialist curly haircuts for waves, curls and coils, with curl-defining and hydration care available where suitable. For the most accurate stylist match, share a current hair photo and the shape or concern you would like us to address.";
  }
  if (SENTOSA.test(message)) {
    return "Yes. Hera’s Quayside Isle, Sentosa Cove atelier offers specialist curly haircuts for waves, curls and coils, with curl-defining and hydration care available where suitable. For the most accurate stylist match, share a current hair photo and the shape or concern you would like us to address.";
  }
  return "Yes. Hera offers specialist curly haircuts at both Tanglin Mall and Quayside Isle, Sentosa Cove, with curl-defining and hydration care available where suitable. Share a current hair photo and the shape or concern you would like us to address, and we’ll guide you to the most suitable curl specialist.";
}

function curlySpecialistReply(): string {
  return "Among Hera’s team members specifically profiled for curl work, Alina is Rëzocut-certified and known for curl architecture; Phoeve is REZO Cut and Cadō Academy certified; and Irene is known for precision cutting and curl transformations. The most suitable match depends on your curl pattern, desired shape and maintenance preferences; live schedules and atelier assignments still need confirmation.";
}

export function assessServiceInformation(input: {
  message: string;
  decision: AgentDecision;
  policy: PolicyAssessment;
}): ServiceInformationAssessment {
  const message = input.message.replace(/[\\r\\n]+/g, " ").replace(/\\s+/g, " ").trim();
  if (!message) return noMatch("No current client message was supplied.");
  if (
    input.policy.risk !== "green" ||
    input.policy.requiresIncident ||
    input.policy.requiresManagementNotification ||
    input.decision.requiresManagementNotification
  ) {
    return noMatch("Higher-consequence policy handling takes precedence.");
  }
  if (
    BOOKING_OR_LIVE_ACTION.test(message) ||
    HUMAN_AUTHORITY.test(message) ||
    HIGH_CONSEQUENCE.test(message) ||
    PRICE_TERMS.test(message)
  ) {
    return noMatch("The current turn requests an action, authority or additional answer beyond pure service information.");
  }
  if (!CURL_TERMS.test(message)) {
    return noMatch("The current turn is not a curly-service information question.");
  }

  if (SPECIALIST_MATCH.test(message)) {
    return {
      matched: true,
      reply: curlySpecialistReply(),
      reason: "Answered a pure curl-specialist matching question from the operator-approved service matrix.",
      sourceIds: [CURL_SERVICE_SOURCE_ID],
    };
  }

  if (!SERVICE_TERMS.test(message)) {
    return noMatch("The current turn does not ask whether Hera provides a curly service.");
  }

  return {
    matched: true,
    reply: curlyServiceReply(message),
    reason: "Answered a pure curly-service-at-outlet question directly from the operator-approved service matrix.",
    sourceIds: [CURL_SERVICE_SOURCE_ID],
  };
}
''',
    encoding="utf-8",
)

knowledge = ROOT / "src/knowledge/search.ts"
replace_once(
    knowledge,
    '''export const HERA_OPERATOR_POLICIES = String.raw`
HERA OPERATOR-APPROVED POLICIES - VERSION 1
- If a client has waited more than 10 minutes beyond the agreed appointment time, Hera's stated service-recovery policy is a 10% discount. The AI may explain the policy and record the concern, but must not claim the discount has been applied to a bill unless a transaction system confirms it.
- If a strand test fails, do not proceed with bleach. Hair and client safety override the requested colour result and any sales objective.
- Published service prices are before 9% GST unless explicitly stated otherwise.
- Every colour service requires consultation, a clear quotation and client consent before work begins.
`;
''',
    '''export const HERA_OPERATOR_POLICIES = String.raw`
HERA OPERATOR-APPROVED POLICIES - VERSION 2
- If a client has waited more than 10 minutes beyond the agreed appointment time, Hera's stated service-recovery policy is a 10% discount. The AI may explain the policy and record the concern, but must not claim the discount has been applied to a bill unless a transaction system confirms it.
- If a strand test fails, do not proceed with bleach. Hair and client safety override the requested colour result and any sales objective.
- Published service prices are before 9% GST unless explicitly stated otherwise.
- Every colour service requires consultation, a clear quotation and client consent before work begins.

HERA OPERATOR-APPROVED CURL SERVICE MATRIX - VERSION 2
- Hera offers specialist curly haircuts at both Tanglin Mall and Quayside Isle, Sentosa Cove.
- Curly services include curly haircuts, curl-defining and hydration care for waves, curls and coils, subject to consultation.
- A pure service-at-outlet question must be answered directly. Do not create a receptionist handoff unless the current client turn asks to book, check live availability, change an appointment or speak to a person.
- Do not claim a named stylist's live schedule or current atelier assignment without live confirmation.
- Curl-specialist guidance: Alina is Rëzocut-certified and known for curl architecture; Phoeve is REZO Cut and Cadō Academy certified; Irene is known for precision cutting and curl transformations.
`;
''',
)
replace_once(
    knowledge,
    '        ? "hera-operator-policy-v1"\n',
    '        ? "hera-operator-policy-v2"\n',
)

handoff = ROOT / "src/policy/handoff.ts"
replace_once(
    handoff,
    '''} from "../types.js";

export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.2.0";
''',
    '''} from "../types.js";
import {
  assessServiceInformation,
  SERVICE_INFORMATION_POLICY_VERSION,
} from "./serviceInformation.js";

export const HUMAN_HANDOFF_POLICY_VERSION = "hera-human-handoff-1.2.1";
''',
)
replace_once(
    handoff,
    '''  const requestedHuman = HUMAN_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const taskType = taskTypeFor({
''',
    '''  const requestedHuman = HUMAN_REQUEST_PATTERNS.some((pattern) =>
    pattern.test(input.message),
  );
  const serviceInformation = assessServiceInformation({
    message: input.message,
    decision: input.decision,
    policy: input.policy,
  });
  if (serviceInformation.matched && serviceInformation.reply) {
    return {
      createTask: false,
      taskType: null,
      scope: null,
      priority: null,
      assignedRole: null,
      assignedOutlet: null,
      summary: null,
      requestedAction: null,
      collectedFacts: { ...EMPTY_FACTS },
      missingFacts: [],
      clientReplyOverride: serviceInformation.reply,
      clientVisibleStatus: null,
      dedupeKey: null,
      reason: `${serviceInformation.reason} Policy ${SERVICE_INFORMATION_POLICY_VERSION}; sources ${serviceInformation.sourceIds.join(", ")}.`,
    };
  }
  const taskType = taskTypeFor({
''',
)

receptionist = ROOT / "src/ai/receptionist.ts"
replace_once(
    receptionist,
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.6.0";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.6.0";',
    'export const RESPONSE_PROMPT_VERSION = "hera-receptionist-response-1.6.1";\nexport const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.6.1";',
)
replace_once(
    receptionist,
    '''  "The latest client turn governs the current intent. Conversation history is reference only: never resurrect an earlier or completed booking, handoff, date, time, stylist or service unless the latest client message explicitly continues that action. A service-information question such as ‘Do you offer this service?’ is not a booking or live-availability request.",
''',
    '''  "The latest client turn governs the current intent. Conversation history is reference only: never resurrect an earlier or completed booking, handoff, date, time, stylist or service unless the latest client message explicitly continues that action. A service-information question such as ‘Do you offer this service?’ is not a booking or live-availability request.",
  "When approved knowledge confirms that a service is offered at a named Hera atelier, answer the service question directly and confidently. Do not invent uncertainty or send it to reception merely because an earlier turn contained a booking. Create a handoff only when the current turn requests booking, live availability, appointment action or a person.",
  "Do not list or recommend named stylists unless the client asks for a stylist match. When asked, distinguish only the expertise supported by approved evidence and never claim a live schedule or current atelier assignment without live confirmation.",
''',
)
replace_once(
    receptionist,
    '''  "The latest client turn controls whether a new action exists. Reject any handoff that resurrects an earlier booking, date, time, stylist, outlet or service when the latest message is only a new informational question. ‘Do you offer this service?’ is not permission to reopen a completed booking task.",
''',
    '''  "The latest client turn controls whether a new action exists. Reject any handoff that resurrects an earlier booking, date, time, stylist, outlet or service when the latest message is only a new informational question. ‘Do you offer this service?’ is not permission to reopen a completed booking task.",
  "When approved evidence confirms a service at the requested Hera atelier, reject unnecessary uncertainty and unnecessary reception handoff. The corrected reply should answer directly, then offer one useful next step without claiming live availability.",
  "Do not approve unsolicited named-stylist recommendations. When the client asks for a stylist match, every distinction must be supported by approved evidence and must not claim a live schedule or current atelier assignment.",
''',
)

booking_test = ROOT / "tests/bookingOwnership.test.ts"
text = booking_test.read_text(encoding="utf-8")
text = text.replace('"hera-receptionist-response-1.6.0"', '"hera-receptionist-response-1.6.1"')
text = text.replace('"hera-receptionist-verifier-1.6.0"', '"hera-receptionist-verifier-1.6.1"')
booking_test.write_text(text, encoding="utf-8")

automatic_test = ROOT / "tests/automaticHandoff.test.ts"
text = automatic_test.read_text(encoding="utf-8")
text = text.replace(
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.2.0");',
    'assert.equal(HUMAN_HANDOFF_POLICY_VERSION, "hera-human-handoff-1.2.1");',
    1,
)
old_assertions = '''  assert.match(result.reason, /stale booking proposal/i);
  assert.equal(result.clientReplyOverride, "Yes, Hera offers curly haircuts.");
  assert.doesNotMatch(result.clientReplyOverride ?? "", /Irene|2 pm|reception|live availability/i);
'''
new_assertions = '''  assert.match(result.reason, /operator-approved service matrix/i);
  assert.match(result.clientReplyOverride ?? "", /Tanglin Mall atelier offers specialist curly haircuts/i);
  assert.match(result.clientReplyOverride ?? "", /waves, curls and coils/i);
  assert.match(result.clientReplyOverride ?? "", /current hair photo/i);
  assert.doesNotMatch(result.clientReplyOverride ?? "", /Irene|2 pm|reception|live availability/i);
  assert.deepEqual(result.missingFacts, []);
'''
if old_assertions not in text:
    raise RuntimeError("The existing handback regression assertions were not found")
text = text.replace(old_assertions, new_assertions, 1)
automatic_test.write_text(text, encoding="utf-8")

knowledge_test = ROOT / "tests/knowledge.test.ts"
with knowledge_test.open("a", encoding="utf-8") as handle:
    handle.write(
        '''

test("retrieves the operator-approved curly service and specialist matrix", () => {
  const service = searchStaticKnowledge(
    "Does Hera offer curly haircuts at Tanglin Mall?",
    3,
  );
  assert.ok(
    service.some(
      (result) =>
        result.version === "hera-operator-policy-v2" &&
        /both Tanglin Mall and Quayside Isle/i.test(result.excerpt),
    ),
  );

  const specialist = searchStaticKnowledge("Who is your curly specialist?", 3);
  assert.ok(
    specialist.some(
      (result) =>
        /Alina is Rëzocut-certified/i.test(result.excerpt) &&
        /Phoeve is REZO Cut and Cadō Academy certified/i.test(result.excerpt) &&
        /Irene is known for precision cutting and curl transformations/i.test(
          result.excerpt,
        ),
    ),
  );
});
'''
    )

service_test = ROOT / "tests/serviceInformation.test.ts"
service_test.write_text(
    '''import assert from "node:assert/strict";
import test from "node:test";
import {
  assessServiceInformation,
  CURL_SERVICE_SOURCE_ID,
  SERVICE_INFORMATION_POLICY_VERSION,
} from "../src/policy/serviceInformation.js";
import type { AgentDecision, PolicyAssessment } from "../src/types.js";

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "I could not verify this.",
    intent: "service_advice",
    risk: "green",
    confidence: 0.9,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    rationale: "Service information test fixture.",
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyAssessment> = {}): PolicyAssessment {
  return {
    risk: "green",
    canAutoSend: true,
    requiresManagementNotification: false,
    requiresIncident: false,
    blockedActions: [],
    securityFlags: [],
    replyOverride: null,
    ...overrides,
  };
}

test("answers a Tanglin curly service question directly and professionally", () => {
  const result = assessServiceInformation({
    message: "Does Hera offer curly haircuts at Tanglin Mall?",
    decision: decision(),
    policy: policy(),
  });

  assert.equal(SERVICE_INFORMATION_POLICY_VERSION, "hera-service-information-1.0.0");
  assert.equal(result.matched, true);
  assert.deepEqual(result.sourceIds, [CURL_SERVICE_SOURCE_ID]);
  assert.match(result.reply ?? "", /^Yes\./);
  assert.match(result.reply ?? "", /Tanglin Mall atelier offers specialist curly haircuts/i);
  assert.match(result.reply ?? "", /waves, curls and coils/i);
  assert.match(result.reply ?? "", /current hair photo/i);
  assert.doesNotMatch(result.reply ?? "", /reception|live availability|Irene|2 pm/i);
});

test("answers Sentosa and no-outlet curly questions with the correct atelier scope", () => {
  const sentosa = assessServiceInformation({
    message: "Do you provide curly cuts at Sentosa Cove?",
    decision: decision(),
    policy: policy(),
  });
  assert.equal(sentosa.matched, true);
  assert.match(sentosa.reply ?? "", /Quayside Isle, Sentosa Cove atelier/i);

  const both = assessServiceInformation({
    message: "Do you offer curly haircuts?",
    decision: decision(),
    policy: policy(),
  });
  assert.equal(both.matched, true);
  assert.match(both.reply ?? "", /both Tanglin Mall and Quayside Isle, Sentosa Cove/i);
});

test("provides a supported curl-specialist comparison only when asked", () => {
  const result = assessServiceInformation({
    message: "Which stylist would you recommend for curly hair?",
    decision: decision({ intent: "stylist_matching" }),
    policy: policy(),
  });

  assert.equal(result.matched, true);
  assert.match(result.reply ?? "", /Alina is Rëzocut-certified/i);
  assert.match(result.reply ?? "", /Phoeve is REZO Cut and Cadō Academy certified/i);
  assert.match(result.reply ?? "", /Irene is known for precision cutting and curl transformations/i);
  assert.match(result.reply ?? "", /live schedules and atelier assignments still need confirmation/i);
});

test("does not intercept booking, pricing, human-authority or safety turns", () => {
  const booking = assessServiceInformation({
    message: "Do you have availability this Friday at 2 pm for a curly haircut?",
    decision: decision({ intent: "availability" }),
    policy: policy(),
  });
  assert.equal(booking.matched, false);

  const pricing = assessServiceInformation({
    message: "Do you offer curly cuts at Tanglin Mall and how much are they?",
    decision: decision({ intent: "pricing" }),
    policy: policy(),
  });
  assert.equal(pricing.matched, false);

  const human = assessServiceInformation({
    message: "Can I speak to a receptionist about a curly haircut?",
    decision: decision(),
    policy: policy(),
  });
  assert.equal(human.matched, false);

  const safety = assessServiceInformation({
    message: "Do you specialise in curls? My scalp is burning after colour.",
    decision: decision({
      intent: "medical_safety",
      risk: "red",
      requiresManagementNotification: true,
    }),
    policy: policy({
      risk: "red",
      canAutoSend: false,
      requiresManagementNotification: true,
      requiresIncident: true,
    }),
  });
  assert.equal(safety.matched, false);
});
''',
    encoding="utf-8",
)

evals = ROOT / "evals/scenarios-expanded.json"
eval_text = evals.read_text(encoding="utf-8")
if '"id": "curly-tanglin-service-information"' not in eval_text:
    insertion = '  { "id": "curly-tanglin-service-information", "category": "curly_hair", "message": "Thank you. Does Hera offer curly haircuts at Tanglin Mall?", "minimumRisk": "green" }'
    end = eval_text.rfind("\n]")
    if end < 0:
        raise RuntimeError("Could not find the end of evals/scenarios-expanded.json")
    prefix = eval_text[:end].rstrip()
    if not prefix.endswith(","):
        prefix += ","
    evals.write_text(prefix + "\n" + insertion + "\n]\n", encoding="utf-8")

print("Applied curly service quality gate patches")
