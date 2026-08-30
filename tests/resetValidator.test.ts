import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeResult } from "../src/types.js";
import type {
  ResetEvidencePacket,
  ResetModelDraft,
} from "../src/reset/types.js";
import {
  isGenuineCurrentEmergency,
  validateResetDraft,
} from "../src/reset/validator.js";

function evidence(knowledge: KnowledgeResult[] = []): ResetEvidencePacket {
  return {
    queries: [],
    knowledge,
    bookings: [],
    tanglinOnly: true,
    liveAvailabilityVerified: false,
    retrievalWarnings: [],
  };
}

function draft(overrides: Partial<ResetModelDraft> = {}): ResetModelDraft {
  return {
    replyRequired: true,
    finalReply:
      "Thank you for telling us. We will review the details carefully and continue the conversation with you here.",
    intent: "other",
    currentEmergency: false,
    reviewPriority: "care",
    requestedAction: null,
    factsStillMissing: [],
    usedEvidenceIds: [],
    ...overrides,
  };
}

test("a genuine first-person current emergency requires 995, urgency and no waiting", () => {
  const client =
    "I cannot breathe now and my face is swelling after the product. Please help.";
  assert.equal(isGenuineCurrentEmergency(client), true);

  const weak = validateResetDraft({
    clientTurnText: client,
    draft: draft({
      currentEmergency: true,
      reviewPriority: "emergency",
      finalReply: "I’m sorry. Please see a doctor when you can.",
    }),
    evidence: evidence(),
  });
  assert.equal(weak.passed, false);
  assert.ok(weak.issues.some((issue) => /995/.test(issue)));
  assert.ok(weak.issues.some((issue) => /not to wait/i.test(issue)));

  const strong = validateResetDraft({
    clientTurnText: client,
    draft: draft({
      currentEmergency: true,
      reviewPriority: "emergency",
      finalReply:
        "This may be an emergency. Please call 995 immediately or have someone take you to the nearest emergency department, and do not wait for the salon to respond before seeking urgent medical help.",
    }),
    evidence: evidence(),
  });
  assert.equal(strong.passed, true);
});

test("historical allegations in a legal letter are not misclassified as a current emergency", () => {
  const client =
    "Please find attached our Letter of Demand. Ms Rachel Lim alleges that she suffered a chemical burn on 8 August 2026 and was diagnosed with dermatitis and alopecia. Our legal reference is LQ/CIV/2026/0417.";
  assert.equal(isGenuineCurrentEmergency(client), false);

  const result = validateResetDraft({
    clientTurnText: client,
    draft: draft({
      intent: "legal_correspondence",
      reviewPriority: "urgent",
      finalReply:
        "Thank you for sending the letter. We recognise the seriousness of the matters raised and have recorded the legal reference. We will review the complete correspondence and continue the response with you here, without making any premature finding or admission.",
    }),
    evidence: evidence(),
  });
  assert.equal(result.passed, true);
  assert.doesNotMatch(result.issues.join(" "), /995|current emergency/i);
});

test("a model cannot label historical or third-party symptoms as current emergency", () => {
  const result = validateResetDraft({
    clientTurnText:
      "The doctor's report says my client suffered burning last month and was diagnosed with contact dermatitis.",
    draft: draft({
      currentEmergency: true,
      reviewPriority: "emergency",
      finalReply: "Please call 995 immediately and do not wait for the salon.",
    }),
    evidence: evidence(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /historical or reported symptoms/i.test(issue)));
});

test("false appointment completion, financial promises, liability and diagnosis are blocked", () => {
  const cases = [
    "We have rescheduled your appointment for Saturday.",
    "We will refund you today.",
    "Hera accepts full liability for causing this damage.",
    "You definitely have a chemical burn.",
  ];
  for (const finalReply of cases) {
    const result = validateResetDraft({
      clientTurnText: "Please help with my concern.",
      draft: draft({ finalReply }),
      evidence: evidence(),
    });
    assert.equal(result.passed, false, finalReply);
  }
});

test("Tanglin scope and natural client language remain mandatory", () => {
  const cases = [
    "Which Hera outlet did you visit, Tanglin or Sentosa?",
    "Our authorised management team will verify the appointment and payment records before providing a confirmed outcome.",
    "The backend handoff object has been placed in the internal queue.",
  ];
  for (const finalReply of cases) {
    const result = validateResetDraft({
      clientTurnText: "I need help with my balayage.",
      draft: draft({ finalReply }),
      evidence: evidence(),
    });
    assert.equal(result.passed, false, finalReply);
  }
});

test("prices and named staff require evidence retrieved in the same turn", () => {
  const noEvidence = validateResetDraft({
    clientTurnText: "How much is balayage and who is best for blonde?",
    draft: draft({
      finalReply:
        "Full-head balayage is S$270 before GST, and Monica would be an excellent blonde specialist.",
    }),
    evidence: evidence(),
  });
  assert.equal(noEvidence.passed, false);
  assert.ok(noEvidence.issues.some((issue) => /price or GST/i.test(issue)));
  assert.ok(noEvidence.issues.some((issue) => /Monica/i.test(issue)));

  const price: KnowledgeResult = {
    id: "price-balayage",
    title: "Hera official price — Balayage Full Head — Tanglin Mall",
    excerpt: "Full Head Balayage price S$270 before 9% GST.",
    sourceUrl: null,
    version: "hera-service-price-expertise-master-v1.2-2026-08-27",
    score: 1,
  };
  const staff: KnowledgeResult = {
    id: "staff-monica",
    title: "Hera current team expertise — Monica Babchina",
    excerpt:
      "Staff: Monica Babchina. Primary approved specialties: Blonding; dimensional colour; sun-kissed colour.",
    sourceUrl: null,
    version: "hera-service-price-expertise-master-v1.2-2026-08-27",
    score: 1,
  };
  const supported = validateResetDraft({
    clientTurnText: "How much is balayage and who is best for blonde?",
    draft: draft({
      finalReply:
        "Full-head balayage is S$270 before 9% GST. Monica specialises in blonding and dimensional colour; live availability still needs to be checked.",
      usedEvidenceIds: [price.id, staff.id],
    }),
    evidence: evidence([price, staff]),
  });
  assert.equal(supported.passed, true);
});

test("the model cannot invent evidence identifiers", () => {
  const result = validateResetDraft({
    clientTurnText: "Tell me about curly haircuts.",
    draft: draft({ usedEvidenceIds: ["invented-source"] }),
    evidence: evidence(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /invented-source/.test(issue)));
});
