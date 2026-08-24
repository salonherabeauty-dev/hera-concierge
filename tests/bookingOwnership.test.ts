import assert from "node:assert/strict";
import test from "node:test";
import {
  RESPONSE_INSTRUCTIONS,
  RESPONSE_PROMPT_VERSION,
  VERIFIER_INSTRUCTIONS,
  VERIFIER_PROMPT_VERSION,
} from "../src/ai/receptionist.js";
import {
  BOOKING_OWNERSHIP_PRINCIPLE,
  BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE,
  bookingDecisionRequiresApprovedEvidence,
} from "../src/policy/bookingExperience.js";
import { assessGrounding } from "../src/policy/grounding.js";
import type { AgentDecision } from "../src/types.js";

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "Certainly — I can help with this.",
    intent: "booking",
    risk: "green",
    confidence: 0.95,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["ask_clarifying_question"],
    requiresManagementNotification: false,
    rationale: "Booking ownership regression fixture.",
    ...overrides,
  };
}

test("response and verifier prompts enforce the approved booking ownership principle", () => {
  assert.equal(RESPONSE_PROMPT_VERSION, "hera-receptionist-response-1.4.0");
  assert.equal(VERIFIER_PROMPT_VERSION, "hera-receptionist-verifier-1.4.0");
  assert.ok(RESPONSE_INSTRUCTIONS.includes(BOOKING_OWNERSHIP_PRINCIPLE));
  assert.ok(
    VERIFIER_INSTRUCTIONS.includes(BOOKING_OWNERSHIP_VERIFIER_PRINCIPLE),
  );
  assert.match(RESPONSE_INSTRUCTIONS, /lead with a positive acknowledgement/i);
  assert.match(RESPONSE_INSTRUCTIONS, /single missing detail needed next/i);
  assert.match(RESPONSE_INSTRUCTIONS, /do not open with a system limitation/i);
  assert.match(RESPONSE_INSTRUCTIONS, /subject to live system confirmation/i);
  assert.match(VERIFIER_INSTRUCTIONS, /reject a response that opens with inability/i);
});

test("the approved ownership-first booking clarification does not require invented evidence", () => {
  const approvedCorrection = decision({
    intent: "availability",
    reply:
      "Good morning. Certainly — may I confirm which Friday you mean and your preferred time in the afternoon? I’ll then help you select the correct root-colour touch-up and toner appointment with Irene, subject to her live availability.",
    factualBasis: ["client_provided_fact"],
    proposedActions: ["ask_clarifying_question"],
  });

  assert.equal(
    bookingDecisionRequiresApprovedEvidence(approvedCorrection),
    false,
  );
  const grounding = assessGrounding(
    "Good morning, I would like to take an appointment with Irene to dye my root and toning. Is it possible Friday afternoon?",
    approvedCorrection,
  );
  assert.equal(grounding.required, false);
  assert.equal(grounding.grounded, true);
  assert.equal(grounding.replyOverride, null);
});

test("a booking link remains blocked unless the approved digital tool supplied it", () => {
  const unverifiedLink = decision({
    reply:
      "Please book here: https://bookings.gettimely.com/herabeauty1/bb/book",
    factualBasis: ["approved_hera_source"],
    proposedActions: ["share_booking_link"],
  });

  assert.equal(bookingDecisionRequiresApprovedEvidence(unverifiedLink), true);
  const blocked = assessGrounding("Can I book online?", unverifiedLink);
  assert.equal(blocked.grounded, false);
  assert.ok(
    blocked.flags.includes("booking_guidance_without_approved_tool_evidence"),
  );
  assert.match(blocked.replyOverride ?? "", /^Certainly/u);
  assert.doesNotMatch(blocked.replyOverride ?? "", /https?:\/\//i);

  const verifiedLink = assessGrounding(
    "Can I book online?",
    decision({
      reply:
        "Certainly. You can use Hera’s secure booking page to view the available options.",
      sources: [
        { id: "hera-digital-tools", title: "Hera official digital tools" },
      ],
      factualBasis: ["approved_hera_source"],
      proposedActions: ["share_booking_link"],
    }),
  );
  assert.equal(verifiedLink.grounded, true);
});

test("reviewed booking fallback leads with ownership and asks only for missing detail", () => {
  const fallback = assessGrounding(
    "Can Irene do my roots this Friday afternoon?",
    decision({
      intent: "availability",
      reply: "Irene is available this Friday afternoon.",
      factualBasis: ["approved_hera_source"],
      proposedActions: ["answer"],
    }),
  );

  assert.equal(fallback.grounded, false);
  assert.match(fallback.replyOverride ?? "", /^Certainly/u);
  assert.match(fallback.replyOverride ?? "", /only the booking detail still missing/i);
  assert.match(fallback.replyOverride ?? "", /subject to live availability/i);
  assert.doesNotMatch(
    fallback.replyOverride ?? "",
    /I can help, but|I won’t invent|unable to verify/i,
  );
});
