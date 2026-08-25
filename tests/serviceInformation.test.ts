import assert from "node:assert/strict";
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
