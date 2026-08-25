from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


FINAL_QUALITY = dedent(r'''
import type {
  AgentDecision,
  PolicyAssessment,
  RiskLevel,
} from "../types.js";
import type { HumanHandoffAssessment } from "./handoff.js";

export const FINAL_RESPONSE_QUALITY_POLICY_VERSION =
  "hera-final-response-quality-1.0.0";

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
  /\b(?:handoff|human-action task|internal queue|priority queue|workflow|verifier|model name|policy rule|backend|system prompt)\b/i;
const GENERIC_HUMAN_ACKNOWLEDGEMENT =
  /certainly\.?\s+i(?:'|’)ve sent your request to hera(?:'|’)s team for direct assistance\.?\s+a staff member will continue with you as soon as available\.?/i;
const BOOKING_COMPLETION =
  /\b(?:i|we)(?:'|’)ve\s+(?:booked|confirmed|reserved|secured)|\b(?:appointment|booking|slot)\s+(?:is|has been|was)\s+(?:booked|confirmed|reserved|secured)\b/i;
const FINANCIAL_COMPLETION =
  /\b(?:refund|compensation|credit|voucher)\s+(?:is|has been|was|will be)\s+(?:approved|processed|issued|given|applied)\b|\b(?:i|we)(?:'|’)ve\s+(?:approved|processed|issued)\s+(?:a\s+)?(?:refund|compensation|credit|voucher)\b/i;
const PRIVACY_COMPLETION =
  /\b(?:your|the)\s+(?:data|number|photo|record)s?\s+(?:has|have)\s+been\s+(?:deleted|removed|erased)\b/i;
const LIABILITY_ADMISSION =
  /\b(?:we|hera|our stylist)\s+(?:damaged|destroyed|ruined|caused|were at fault|are liable)|\bour fault\b|\bwe accept liability\b/i;
const GUARANTEED_REMEDY =
  /\b(?:guaranteed|definitely|certainly)\s+(?:fix|resolve|refund|redo)|\b(?:free|complimentary)\s+(?:redo|service|treatment|correction)\b/i;
const EMPATHY =
  /\b(?:sorry|understand|appreciate|thank you for explaining|unhappy|concern|disappointed|frustrating|experience)\b/i;
const OWNERSHIP =
  /\b(?:manager|management|authorised team|privacy team|technical lead|reception team|outlet team|hera(?:'|’)s team|staff member)\b/i;
const NEXT_STEP =
  /\b(?:review|assess|check|verify|advise|confirm|contact|share|send|seek|arrange|coordinate|update|next step)\b/i;
const URGENT_SAFETY =
  /\b(?:urgent medical attention|emergency medical attention|emergency services|call 995|seek medical attention|stop using|stop the service|breathing difficulty|severe swelling|eye exposure)\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

function normalized(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
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
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter(Boolean).length;
}

function taskType(input: {
  decision: AgentDecision;
  handoff: HumanHandoffAssessment;
}): string | null {
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
  const type = taskType(input);
  const facts = input.handoff.collectedFacts;

  if (!reply) issues.push("The final client reply is empty.");
  if (reply.length > 4000) issues.push("The final client reply exceeds the delivery limit.");
  if (INTERNAL_LANGUAGE.test(reply)) {
    issues.push("The final client reply exposes internal operational terminology.");
  }
  if (EMOJI.test(reply) || reply.includes("!")) {
    issues.push("The final client reply uses an emoji or exclamation mark.");
  }
  if (sentenceCount(reply) > 6) {
    issues.push("The final client reply is unnecessarily long.");
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

  if (type === "complaint_review") {
    if (!EMPATHY.test(reply)) {
      issues.push("The complaint reply does not acknowledge the client’s experience or concern.");
    }
    if (!/\b(?:salon manager|manager|management)\b/i.test(reply)) {
      issues.push("The complaint reply does not identify management ownership.");
    }
    if (!/\b(?:review|assess|advise|next step)\b/i.test(reply)) {
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
    if (!/\bcheck\b/i.test(reply) || !/\b(?:live\s+)?availability\b/i.test(reply)) {
      issues.push("The booking reply does not state that live availability still requires checking.");
    }
    if (!includesKnownFact(reply, facts.service) || !includesKnownFact(reply, facts.outlet)) {
      issues.push("The booking reply omits known booking details.");
    }
  }

  if (type === "appointment_change") {
    if (!/\b(?:verify|check|review)\b/i.test(reply)) {
      issues.push("The appointment-change reply does not state that the existing booking will be verified.");
    }
    if (!/\b(?:confirm|alternative|available|outcome)\b/i.test(reply)) {
      issues.push("The appointment-change reply does not explain how the verified outcome will be confirmed.");
    }
  }

  if (type === "refund_finance") {
    if (!/\b(?:authorised|finance|management|transaction)\b/i.test(reply)) {
      issues.push("The financial reply does not identify authorised review.");
    }
    if (!/\b(?:verify|review|assess|confirm)\b/i.test(reply)) {
      issues.push("The financial reply does not explain the verification step.");
    }
  }

  if (type === "medical_safety") {
    if ((input.risk === "black" || input.handoff.scope === "emergency") && !URGENT_SAFETY.test(reply)) {
      issues.push("The emergency reply does not preserve urgent safety guidance.");
    }
    if (/\bdiagnos(?:e|ed|is)|medically safe\b/i.test(reply)) {
      issues.push("The safety reply makes a diagnosis or medical-safety claim.");
    }
  }

  if (type === "privacy_legal") {
    if (!/\b(?:authorised|privacy|management|preserve|review)\b/i.test(reply)) {
      issues.push("The privacy or legal reply does not identify authorised handling.");
    }
  }

  if (type === "arrival_issue") {
    if (!/\b(?:outlet|reception|team|coordinate|contact)\b/i.test(reply)) {
      issues.push("The arrival reply does not explain direct outlet coordination.");
    }
  }

  if (!input.handoff.createTask && GENERIC_HUMAN_ACKNOWLEDGEMENT.test(reply)) {
    issues.push("The final reply claims a human escalation that was not created.");
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
  const contextualEmpathy = type === "complaint_review" ? EMPATHY.test(reply) : true;
  const specificity =
    type === "complaint_review" || type === "booking_action"
      ? includesKnownFact(reply, facts.service) && includesKnownFact(reply, facts.outlet)
      : true;
  const ownership = input.handoff.createTask ? OWNERSHIP.test(reply) : true;
  const nextStep = NEXT_STEP.test(reply) || !input.handoff.createTask;
  const conciseTone = !EMOJI.test(reply) && !reply.includes("!") && sentenceCount(reply) <= 6;

  return {
    passed: issues.length === 0,
    issues,
    checks: {
      complete,
      clientFacing,
      safeAuthority,
      contextualEmpathy,
      specificity,
      ownership,
      nextStep,
      conciseTone,
    },
  };
}
''').lstrip()

write("src/policy/finalResponseQuality.ts", FINAL_QUALITY)

FINAL_QUALITY_TESTS = dedent(r'''
import assert from "node:assert/strict";
import test from "node:test";
import { assessFinalResponseQuality } from "../src/policy/finalResponseQuality.js";
import type { HumanHandoffAssessment } from "../src/policy/handoff.js";
import type { AgentDecision, PolicyAssessment } from "../src/types.js";

const emptyFacts = {
  service: null,
  stylist: null,
  outlet: null,
  date: null,
  time: null,
  flexibility: null,
  appointmentReference: null,
  desiredOutcome: null,
  symptoms: null,
  photos: null,
  other: null,
};

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "Thank you.",
    intent: "service_advice",
    risk: "green",
    confidence: 0.9,
    language: "English",
    sources: [],
    factualBasis: ["no_factual_claim"],
    proposedActions: ["answer"],
    requiresManagementNotification: false,
    rationale: "fixture",
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

function handoff(overrides: Partial<HumanHandoffAssessment> = {}): HumanHandoffAssessment {
  return {
    createTask: false,
    taskType: null,
    scope: null,
    priority: null,
    assignedRole: null,
    assignedOutlet: null,
    summary: null,
    requestedAction: null,
    collectedFacts: { ...emptyFacts },
    missingFacts: [],
    clientReplyOverride: null,
    clientVisibleStatus: null,
    dedupeKey: null,
    reason: "fixture",
    ...overrides,
  };
}

test("blocks the crude generic manager handoff that escaped the earlier verifier", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "My curly haircut is uneven and I want the salon manager to review it.",
    reply: "Certainly. I’ve sent your request to Hera’s team for direct assistance. A staff member will continue with you as soon as available.",
    decision: decision({ intent: "complaint", risk: "amber" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    risk: "amber",
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
        outlet: "Tanglin Mall",
        other: "uneven layers",
      },
    }),
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((issue) => /crude generic/i.test(issue)));
  assert.ok(result.issues.some((issue) => /experience or concern/i.test(issue)));
});

test("passes a specific, empathetic and non-liability complaint acknowledgement", () => {
  const result = assessFinalResponseQuality({
    clientMessage: "My curly haircut is uneven and I want the salon manager to review it.",
    reply: "Thank you for explaining this, and I’m sorry this experience has left you unhappy. I’ve placed your concern regarding your curly haircut at Tanglin Mall with Hera’s salon manager for a careful review. Please share clear photos of the result if convenient; they will help the manager review it carefully. The manager will assess the details and advise the appropriate next step after the review.",
    decision: decision({ intent: "complaint", risk: "amber" }),
    policy: policy({ risk: "amber", requiresIncident: true }),
    risk: "amber",
    handoff: handoff({
      createTask: true,
      taskType: "complaint_review",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: "Tanglin Mall",
      collectedFacts: {
        ...emptyFacts,
        service: "curly haircut",
        outlet: "Tanglin Mall",
        other: "uneven layers",
      },
    }),
  });
  assert.equal(result.passed, true);
});

test("blocks false booking completion and accepts live-availability ownership", () => {
  const booking = handoff({
    createTask: true,
    taskType: "booking_action",
    scope: "task_only",
    priority: "normal",
    assignedRole: "receptionist",
    assignedOutlet: "Tanglin Mall",
    collectedFacts: {
      ...emptyFacts,
      service: "root colour",
      outlet: "Tanglin Mall",
      date: "Friday",
      time: "2 pm",
    },
  });
  const bad = assessFinalResponseQuality({
    clientMessage: "Root colour at Tanglin Mall Friday 2 pm.",
    reply: "Your booking is confirmed at Tanglin Mall for root colour on Friday at 2 pm.",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: booking,
    risk: "green",
  });
  assert.equal(bad.passed, false);
  const good = assessFinalResponseQuality({
    clientMessage: "Root colour at Tanglin Mall Friday 2 pm.",
    reply: "Thank you. I’ve noted root colour at Tanglin Mall on Friday at 2 pm. Our reception team will check live availability and confirm the actual outcome with you.",
    decision: decision({ intent: "booking" }),
    policy: policy(),
    handoff: booking,
    risk: "green",
  });
  assert.equal(good.passed, true);
});

test("blocks internal queue language and unverified privacy completion", () => {
  const internal = assessFinalResponseQuality({
    clientMessage: "I am at the salon.",
    reply: "I’ve placed this in our internal priority queue for the outlet workflow.",
    decision: decision({ intent: "other" }),
    policy: policy(),
    handoff: handoff({
      createTask: true,
      taskType: "arrival_issue",
      scope: "task_only",
      priority: "urgent",
      assignedRole: "salon_manager",
    }),
    risk: "green",
  });
  assert.equal(internal.passed, false);
  const privacy = assessFinalResponseQuality({
    clientMessage: "Delete my data.",
    reply: "Your personal data has been deleted.",
    decision: decision({ intent: "privacy_legal", risk: "red" }),
    policy: policy({ risk: "red" }),
    handoff: handoff({
      createTask: true,
      taskType: "privacy_legal",
      scope: "full_takeover",
      priority: "urgent",
      assignedRole: "privacy_officer",
    }),
    risk: "red",
  });
  assert.equal(privacy.passed, false);
});

test("requires emergency guidance and allows a direct routine service answer", () => {
  const emergency = assessFinalResponseQuality({
    clientMessage: "I cannot breathe and my face is swelling.",
    reply: "A staff member will contact you as soon as available.",
    decision: decision({ intent: "medical_safety", risk: "black" }),
    policy: policy({ risk: "black", requiresIncident: true }),
    handoff: handoff({
      createTask: true,
      taskType: "medical_safety",
      scope: "emergency",
      priority: "emergency",
      assignedRole: "technical_lead",
    }),
    risk: "black",
  });
  assert.equal(emergency.passed, false);
  const routine = assessFinalResponseQuality({
    clientMessage: "Do you offer curly haircuts at Tanglin Mall?",
    reply: "Yes. Hera’s Tanglin Mall atelier offers specialist curly haircuts for waves, curls and coils. Share a current hair photo and the shape you would like us to address, and we’ll guide you to the most suitable next step.",
    decision: decision({ intent: "service_advice" }),
    policy: policy(),
    handoff: handoff(),
    risk: "green",
  });
  assert.equal(routine.passed, true);
});
''').lstrip()
write("tests/finalResponseQuality.test.ts", FINAL_QUALITY_TESTS)

# AI final-response verifier.
replace_once(
    "src/ai/receptionist.ts",
    'import { canonicalizeSources } from "../policy/grounding.js";\n',
    'import { canonicalizeSources } from "../policy/grounding.js";\nimport type { HumanHandoffAssessment } from "../policy/handoff.js";\n',
)
replace_once(
    "src/ai/receptionist.ts",
    '  type JobContext,\n} from "../types.js";',
    '  type JobContext,\n  type PolicyAssessment,\n} from "../types.js";',
)
replace_once(
    "src/ai/receptionist.ts",
    'export const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.6.1";\n',
    'export const VERIFIER_PROMPT_VERSION = "hera-receptionist-verifier-1.6.1";\nexport const FINAL_RESPONSE_VERIFIER_PROMPT_VERSION =\n  "hera-final-response-verifier-1.0.0";\n',
)
replace_once(
    "src/ai/receptionist.ts",
    dedent('''
    export interface VerificationResult {
      approved: boolean;
      correctedReply: string | null;
      handoffApproved: boolean;
      correctedHandoff: AgentDecision["handoff"] | null;
      risk: (typeof RISK_LEVELS)[number];
      issues: string[];
      modelId: string;
      usage: JsonValue;
      latencyMs: number;
    }
    ''').lstrip(),
    dedent('''
    export interface VerificationResult {
      approved: boolean;
      correctedReply: string | null;
      handoffApproved: boolean;
      correctedHandoff: AgentDecision["handoff"] | null;
      risk: (typeof RISK_LEVELS)[number];
      issues: string[];
      modelId: string;
      usage: JsonValue;
      latencyMs: number;
    }

    export interface FinalResponseVerificationResult {
      approved: boolean;
      correctedReply: string | null;
      issues: string[];
      scores: {
        empathy: number;
        specificity: number;
        ownership: number;
        nextStep: number;
        factuality: number;
        safety: number;
        tone: number;
        clientEffort: number;
      };
      summary: string;
      modelId: string;
      usage: JsonValue;
      latencyMs: number;
    }
    ''').lstrip(),
)
replace_once(
    "src/ai/receptionist.ts",
    'export const RESPONSE_INSTRUCTIONS = [\n',
    dedent('''
    const finalResponseVerificationSchema = z
      .object({
        approved: z.boolean(),
        correctedReply: z.string().trim().min(1).max(3500).nullable(),
        issues: z.array(z.string().trim().min(1).max(180)).max(12),
        scores: z.object({
          empathy: z.number().int().min(0).max(2),
          specificity: z.number().int().min(0).max(2),
          ownership: z.number().int().min(0).max(2),
          nextStep: z.number().int().min(0).max(2),
          factuality: z.number().int().min(0).max(2),
          safety: z.number().int().min(0).max(2),
          tone: z.number().int().min(0).max(2),
          clientEffort: z.number().int().min(0).max(2),
        }),
        summary: z.string().trim().min(1).max(240),
      })
      .superRefine((value, context) => {
        const scoreValues = Object.values(value.scores);
        if (value.approved && (value.issues.length > 0 || scoreValues.some((score) => score !== 2))) {
          context.addIssue({
            code: "custom",
            path: ["approved"],
            message: "Approval requires no issues and perfect scores on every final-response dimension.",
          });
        }
        if (!value.approved && !value.correctedReply) {
          context.addIssue({
            code: "custom",
            path: ["correctedReply"],
            message: "A rejected final response requires a complete corrected reply.",
          });
        }
      });

    export const RESPONSE_INSTRUCTIONS = [
    ''').lstrip(),
)
replace_once(
    "src/ai/receptionist.ts",
    'export const VERIFIER_INSTRUCTIONS = [\n',
    'export const VERIFIER_INSTRUCTIONS = [\n',
)
verifier_end = '].join("\\n");\n\nfunction anonymousUserId(contactId: string): string {'
if read("src/ai/receptionist.ts").count(verifier_end) != 1:
    raise RuntimeError("Could not find verifier instruction terminator")
FINAL_INSTRUCTIONS = dedent(r'''
].join("\n");

export const FINAL_RESPONSE_VERIFIER_INSTRUCTIONS = [
  "You are Hera’s final client-response quality controller. Review the exact post-policy text that would reach the WhatsApp client after every model, template, safety rule and handoff override has finished.",
  "Approve only when the text is ready to send unchanged. This is a stricter gate than the earlier safety verifier: every score must be 2 and issues must be empty.",
  "Use only the supplied client message, conversation history, approved evidence, decision, deterministic policy and persisted-handoff plan. Never introduce a Hera fact, appointment outcome, remedy, financial decision, privacy completion or medical conclusion that is not supported.",
  "The latest client turn controls the current intent. Remove stale booking, stylist, outlet, date or time details that do not belong to the current request.",
  "For a complaint, the exact final reply must recognise the client’s experience, preserve relevant known service and outlet details, identify management ownership, explain the review or useful next step, and remain neutral. Never admit liability, assign blame or promise a refund, compensation, complimentary redo or outcome.",
  "For booking or appointment action, never claim completion. State that live records or availability must be checked and that the verified outcome will be confirmed.",
  "For refund or finance, identify authorised verification without promising an outcome. For privacy or legal requests, identify authorised handling without claiming deletion or legal conclusions. For urgent safety, preserve immediate medical or emergency guidance before salon follow-up.",
  "A specialised task must never be reduced to a generic ‘a staff member will continue’ message. Name the appropriate human ownership and explain the next useful step without exposing internal queues, tasks, handoffs, policy, model names or backend terminology.",
  "Use warm, calm, precise luxury-hospitality language. No emojis, exclamation marks, sales pressure, cold bureaucracy or needless repetition. Keep the reply normally within 2 to 5 concise sentences.",
  "Score each dimension from 0 to 2, where 2 means fully send-ready for this exact context. If anything is below 2, set approved false and provide one complete correctedReply containing only client-facing text.",
  "The summary must be a concise quality-control reason, not private chain-of-thought.",
].join("\n");

function anonymousUserId(contactId: string): string {
''').lstrip()
write("src/ai/receptionist.ts", read("src/ai/receptionist.ts").replace(verifier_end, FINAL_INSTRUCTIONS, 1))

FINAL_VERIFIER_FUNCTION = dedent(r'''

export async function verifyFinalClientReply(input: {
  originalMessage: string;
  history: ConversationMessage[];
  draftReply: string;
  decision: AgentDecision;
  evidence: JsonValue;
  policy: PolicyAssessment;
  handoff: HumanHandoffAssessment;
  deterministicDraftQuality: JsonValue;
  contactId: string;
  config: AiRuntimeConfig;
}): Promise<FinalResponseVerificationResult> {
  const verifier = new ToolLoopAgent({
    id: "hera-whatsapp-final-response-verifier",
    model: gateway(input.config.verifierModel),
    instructions: FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
    tools: {},
    output: Output.object({ schema: finalResponseVerificationSchema }),
    stopWhen: isStepCount(2),
    maxOutputTokens: 1400,
    temperature: 0,
    reasoning: "high",
    providerOptions: {
      gateway: {
        models: [input.config.primaryModel, ...input.config.fallbackModels],
        tags: ["hera", "whatsapp", "final-response-quality"],
        user: anonymousUserId(input.contactId),
        serviceTier: "priority",
        disallowPromptTraining: true,
      },
    },
  });

  const start = Date.now();
  const result = await verifier.generate({
    prompt: JSON.stringify({
      conversationHistory: input.history.map((message) => ({
        direction: message.direction,
        text: message.text.slice(0, 5000),
        createdAt: message.createdAt,
      })),
      clientMessage: input.originalMessage,
      proposedDecision: input.decision,
      approvedEvidence: input.evidence,
      deterministicPolicy: input.policy,
      finalHandoffAssessment: input.handoff,
      exactPostPolicyDraft: input.draftReply,
      deterministicDraftQuality: input.deterministicDraftQuality,
    }),
    timeout: 60_000,
  });

  return {
    ...result.output,
    modelId: result.response.modelId,
    usage: jsonValue(result.usage),
    latencyMs: Date.now() - start,
  };
}
''')
write("src/ai/receptionist.ts", read("src/ai/receptionist.ts").rstrip() + FINAL_VERIFIER_FUNCTION + "\n")

# Worker integration and fail-closed handling.
replace_once(
    "src/worker.ts",
    dedent('''
    import {
      generateReceptionistDecision,
      RESPONSE_PROMPT_VERSION,
      VERIFIER_PROMPT_VERSION,
      verifyReceptionistDecision,
      type AiRuntimeConfig,
    } from "./ai/receptionist.js";
    ''').lstrip(),
    dedent('''
    import {
      FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
      generateReceptionistDecision,
      RESPONSE_PROMPT_VERSION,
      VERIFIER_PROMPT_VERSION,
      verifyFinalClientReply,
      verifyReceptionistDecision,
      type AiRuntimeConfig,
    } from "./ai/receptionist.js";
    ''').lstrip(),
)
replace_once(
    "src/worker.ts",
    'import { assessCustomerCareWindow } from "./policy/customerCareWindow.js";\n',
    dedent('''
    import { assessCustomerCareWindow } from "./policy/customerCareWindow.js";
    import {
      assessFinalResponseQuality,
      FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    } from "./policy/finalResponseQuality.js";
    ''').lstrip(),
)
replace_once(
    "src/worker.ts",
    '  AgentDecision,\n  DrainSummary,',
    '  AgentDecision,\n  AgentHandoffFacts,\n  DrainSummary,',
)
replace_once(
    "src/worker.ts",
    dedent('''
    function cleanReply(value: string): string {
      return value
        .replace(/\*/g, "")
        .replace(/!/g, ".")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 4000);
    }
    ''').lstrip(),
    dedent('''
    function cleanReply(value: string): string {
      return value
        .replace(/\*/g, "")
        .replace(/!/g, ".")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 4000);
    }

    function emptyHandoffFacts(): AgentHandoffFacts {
      return {
        service: null,
        stylist: null,
        outlet: null,
        date: null,
        time: null,
        flexibility: null,
        appointmentReference: null,
        desiredOutcome: null,
        symptoms: null,
        photos: null,
        other: null,
      };
    }
    ''').lstrip(),
)
old_policy_block = dedent('''
  const handoff = assessHumanHandoff({
    message: interpreted.text,
    decision,
    policy,
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
  });
  const finalReply = cleanReply(
    handoff.clientReplyOverride ?? policy.replyOverride ?? decision.reply,
  );
  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "policy",
    modelId: null,
    promptVersion: RESPONSE_PROMPT_VERSION,
    policyVersion: POLICY_VERSION,
    risk: policy.risk,
    confidence: decision.confidence,
    output: asJson({
      policy,
      handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION,
      handoff,
      finalReply,
    }),
  });
  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);
''')
new_policy_block = dedent('''
  const handoff = assessHumanHandoff({
    message: interpreted.text,
    decision,
    policy,
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
  });
  const draftFinalReply = cleanReply(
    handoff.clientReplyOverride ?? policy.replyOverride ?? decision.reply,
  );
  const deterministicDraftQuality = assessFinalResponseQuality({
    clientMessage: interpreted.text,
    reply: draftFinalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const finalVerification = await verifyFinalClientReply({
    originalMessage: interpreted.text,
    history,
    draftReply: draftFinalReply,
    decision,
    evidence: responseEvidence,
    policy,
    handoff,
    deterministicDraftQuality: asJson(deterministicDraftQuality),
    contactId: context.contact.id,
    config: runtime.ai,
  });
  const finalReply = cleanReply(
    finalVerification.approved
      ? draftFinalReply
      : finalVerification.correctedReply!,
  );
  const finalQuality = assessFinalResponseQuality({
    clientMessage: interpreted.text,
    reply: finalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "policy",
    modelId: finalVerification.modelId,
    promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
    policyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    risk: policy.risk,
    confidence: finalQuality.passed ? decision.confidence : Math.min(decision.confidence, 0.2),
    output: asJson({
      responsePromptVersion: RESPONSE_PROMPT_VERSION,
      verifierPromptVersion: VERIFIER_PROMPT_VERSION,
      deterministicPolicyVersion: POLICY_VERSION,
      groundingPolicyVersion: GROUNDING_POLICY_VERSION,
      handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION,
      finalQualityPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
      policy,
      handoff,
      draftFinalReply,
      deterministicDraftQuality,
      finalVerification: {
        approved: finalVerification.approved,
        correctedReply: finalVerification.correctedReply,
        issues: finalVerification.issues,
        scores: finalVerification.scores,
        summary: finalVerification.summary,
        modelId: finalVerification.modelId,
        promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        latencyMs: finalVerification.latencyMs,
        usage: finalVerification.usage,
      },
      finalReply,
      finalQuality,
      deliveryEligible: finalQuality.passed,
    }),
    usage: finalVerification.usage,
    latencyMs: finalVerification.latencyMs,
  });
  await runtime.repository.updateConversationRisk(context.message.conversationId, policy.risk);
''')
replace_once("src/worker.ts", old_policy_block, new_policy_block)

old_queue = dedent('''
  if (policy.canAutoSend || handoff.createTask) {
    await runtime.repository.queueOutbound({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      toWaId: context.contact.waId,
      targetType: "client",
      body: finalReply,
      dedupeKey: clientReplyDedupeKey(context.message.id),
      authorization: "auto",
    });
  }

  if (policy.requiresManagementNotification && runtime.managementWaId) {
    const displayName = context.contact.profileName?.slice(0, 80) || "client";
    const summary = interpreted.text.replace(/[\r\n]+/g, " ").slice(0, 600);
    const containmentStatus =
      "The AI prepared a policy-checked containment response for the client.";
''')
new_queue = dedent('''
  if (!finalQuality.passed) {
    await runtime.repository.audit(
      "final_response_quality_blocked",
      "message",
      context.message.id,
      asJson({
        conversationId: context.message.conversationId,
        intent: decision.intent,
        risk: policy.risk,
        handoffTaskType: handoff.taskType,
        handoffScope: handoff.scope,
        issues: finalQuality.issues,
        finalVerifierModelId: finalVerification.modelId,
        finalVerifierPromptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        finalQualityPolicyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
      }),
    );

    if (!handoff.createTask || handoff.scope === "task_only") {
      await runtime.repository.upsertAutomaticHandoff({
        conversationId: context.message.conversationId,
        sourceMessageId: context.message.id,
        taskType: "system_failure",
        scope: "full_takeover",
        priority: "high",
        assignedRole: "salon_manager",
        assignedOutlet: handoff.assignedOutlet,
        summary: "Final client response failed Hera’s quality gate.",
        requestedAction:
          "Review the exact client message and prepare a safe, specific and service-led response before returning the conversation to AI.",
        collectedFacts: handoff.collectedFacts,
        missingFacts: [],
        clientVisibleStatus: null,
        dedupeKey: `final-response-quality:${context.message.id}`,
      });
    }
  }

  if (finalQuality.passed && (policy.canAutoSend || handoff.createTask)) {
    await runtime.repository.queueOutbound({
      conversationId: context.message.conversationId,
      sourceMessageId: context.message.id,
      toWaId: context.contact.waId,
      targetType: "client",
      body: finalReply,
      dedupeKey: clientReplyDedupeKey(context.message.id),
      authorization: "auto",
    });
  }

  if (policy.requiresManagementNotification && runtime.managementWaId) {
    const displayName = context.contact.profileName?.slice(0, 80) || "client";
    const summary = interpreted.text.replace(/[\r\n]+/g, " ").slice(0, 600);
    const containmentStatus = finalQuality.passed
      ? "The AI prepared a final quality-checked containment response for the client."
      : "The final client response was blocked by Hera’s quality gate and requires human handling.";
''')
replace_once("src/worker.ts", old_queue, new_queue)

old_dead = dedent('''
async function queueDeadLetterFallback(
  repository: ReceptionistRepository,
  job: ReceptionistJob,
): Promise<void> {
  const context = await repository.getJobContext(job);
  await repository.queueOutbound({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    toWaId: context.contact.waId,
    targetType: "client",
    body:
      "Thank you for your message. I’m sorry—Hera’s concierge could not complete the check just now. Please resend your message in a few minutes, or use our secure booking page for bookings: https://bookings.gettimely.com/herabeauty1/bb/book. If this concerns breathing difficulty, severe swelling, eye exposure or another urgent symptom, seek urgent medical attention now.",
    dedupeKey: `dead-letter-reply:${context.message.id}`,
    authorization: "auto",
  });
  await repository.audit("job_dead_lettered", "job", job.id, {
    sourceMessageId: job.sourceMessageId,
  });
}
''')
new_dead = dedent('''
async function queueDeadLetterFallback(
  repository: ReceptionistRepository,
  job: ReceptionistJob,
): Promise<void> {
  const context = await repository.getJobContext(job);
  const fallbackReply =
    "Thank you for your message. I’m sorry, but I’m unable to complete the check safely just now. I’ve placed your message with Hera’s salon manager for direct review, and the team will assist you from here. If you are experiencing breathing difficulty, severe swelling, eye exposure or severe pain, please seek urgent medical attention immediately.";

  await repository.upsertAutomaticHandoff({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    taskType: "system_failure",
    scope: "full_takeover",
    priority: "high",
    assignedRole: "salon_manager",
    assignedOutlet: null,
    summary: "AI processing failed after all protected retries.",
    requestedAction:
      "Review the client’s exact message and respond directly before returning the conversation to AI.",
    collectedFacts: emptyHandoffFacts(),
    missingFacts: [],
    clientVisibleStatus: fallbackReply,
    dedupeKey: `dead-letter-handoff:${context.message.id}`,
  });
  await repository.queueOutbound({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    toWaId: context.contact.waId,
    targetType: "client",
    body: fallbackReply,
    dedupeKey: `dead-letter-reply:${context.message.id}`,
    authorization: "auto",
  });
  await repository.audit("job_dead_lettered", "job", job.id, {
    sourceMessageId: job.sourceMessageId,
    humanHandoffCreated: true,
  });
}
''')
replace_once("src/worker.ts", old_dead, new_dead)

# Command Centre: expose exact model and final-quality trace.
replace_once(
    "src/command-centre/types.ts",
    dedent('''
    export interface CandidateReplyView {
      id: string;
      sourceMessageId: string | null;
      text: string;
      status: string;
      authorization: string;
      providerMessageId: string | null;
      createdAt: string;
    }

    export interface ConversationDetail {
    ''').lstrip(),
    dedent('''
    export interface CandidateReplyView {
      id: string;
      sourceMessageId: string | null;
      text: string;
      status: string;
      authorization: string;
      providerMessageId: string | null;
      createdAt: string;
    }

    export interface DecisionTraceView {
      id: string;
      sourceMessageId: string;
      stage: "response" | "verification" | "policy";
      modelId: string | null;
      promptVersion: string;
      policyVersion: string;
      risk: RiskLevel;
      confidence: number;
      output: JsonValue;
      latencyMs: number | null;
      createdAt: string;
    }

    export interface ConversationDetail {
    ''').lstrip(),
)
replace_once(
    "src/command-centre/types.ts",
    '  candidates: CandidateReplyView[];\n}',
    '  candidates: CandidateReplyView[];\n  decisions: DecisionTraceView[];\n}',
)
replace_once(
    "src/command-centre/repository.ts",
    '  CreateHandoffTaskInput,\n  HandoffPriority,',
    '  CreateHandoffTaskInput,\n  DecisionTraceView,\n  HandoffPriority,',
)
replace_once(
    "src/command-centre/repository.ts",
    'const [contactResult, messageResult, taskList, noteResult, incidentResult, outboxResult] = await Promise.all([',
    'const [contactResult, messageResult, taskList, noteResult, incidentResult, outboxResult, decisionResult] = await Promise.all([',
)
replace_once(
    "src/command-centre/repository.ts",
    dedent('''
      this.database
        .from("ai_outbox")
        .select("id,source_message_id,body,status,send_authorization,provider_message_id,created_at")
        .eq("conversation_id", conversationId)
        .eq("target_type", "client")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    ''').lstrip(),
    dedent('''
      this.database
        .from("ai_outbox")
        .select("id,source_message_id,body,status,send_authorization,provider_message_id,created_at")
        .eq("conversation_id", conversationId)
        .eq("target_type", "client")
        .order("created_at", { ascending: false })
        .limit(100),
      this.database
        .from("ai_decisions")
        .select("id,source_message_id,stage,model_id,prompt_version,policy_version,risk,confidence,output,latency_ms,created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    ''').lstrip(),
)
replace_once(
    "src/command-centre/repository.ts",
    '    if (outboxResult.error) throw new Error(`load conversation candidates: ${outboxResult.error.message}`);\n',
    '    if (outboxResult.error) throw new Error(`load conversation candidates: ${outboxResult.error.message}`);\n    if (decisionResult.error) throw new Error(`load conversation decision trace: ${decisionResult.error.message}`);\n',
)
replace_once(
    "src/command-centre/repository.ts",
    dedent('''
    const candidates: CandidateReplyView[] = array(outboxResult.data).map((value) => {
      const row = object(value, "outbox candidate");
      const body = row.body && typeof row.body === "object" ? object(row.body, "outbox body") : {};
      return {
        id: string(row.id, "outbox id"),
        sourceMessageId: optionalString(row.source_message_id),
        text: typeof body.text === "string" ? body.text : "",
        status: string(row.status, "outbox status"),
        authorization: string(row.send_authorization, "send authorization"),
        providerMessageId: optionalString(row.provider_message_id),
        createdAt: string(row.created_at, "outbox created_at"),
      };
    });

    return { conversation, messages, tasks, notes, incidents, candidates };
    ''').lstrip(),
    dedent('''
    const candidates: CandidateReplyView[] = array(outboxResult.data).map((value) => {
      const row = object(value, "outbox candidate");
      const body = row.body && typeof row.body === "object" ? object(row.body, "outbox body") : {};
      return {
        id: string(row.id, "outbox id"),
        sourceMessageId: optionalString(row.source_message_id),
        text: typeof body.text === "string" ? body.text : "",
        status: string(row.status, "outbox status"),
        authorization: string(row.send_authorization, "send authorization"),
        providerMessageId: optionalString(row.provider_message_id),
        createdAt: string(row.created_at, "outbox created_at"),
      };
    });

    const decisions: DecisionTraceView[] = array(decisionResult.data).map((value) => {
      const row = object(value, "decision trace");
      const stage = string(row.stage, "decision stage");
      if (stage !== "response" && stage !== "verification" && stage !== "policy") {
        throw new Error("Invalid decision stage");
      }
      return {
        id: string(row.id, "decision id"),
        sourceMessageId: string(row.source_message_id, "decision source message id"),
        stage,
        modelId: optionalString(row.model_id),
        promptVersion: string(row.prompt_version, "decision prompt version"),
        policyVersion: string(row.policy_version, "decision policy version"),
        risk: risk(row.risk),
        confidence: number(row.confidence, "decision confidence"),
        output: (row.output ?? {}) as JsonValue,
        latencyMs: row.latency_ms === null || row.latency_ms === undefined
          ? null
          : number(row.latency_ms, "decision latency"),
        createdAt: string(row.created_at, "decision created_at"),
      };
    });

    return { conversation, messages, tasks, notes, incidents, candidates, decisions };
    ''').lstrip(),
)

replace_once(
    "command-centre/src/types.ts",
    '  candidates: Array<{ id: string; text: string; status: string; authorization: string; providerMessageId: string | null; createdAt: string }>;\n}',
    dedent('''
      candidates: Array<{ id: string; sourceMessageId: string | null; text: string; status: string; authorization: string; providerMessageId: string | null; createdAt: string }>;
      decisions: Array<{
        id: string;
        sourceMessageId: string;
        stage: "response" | "verification" | "policy";
        modelId: string | null;
        promptVersion: string;
        policyVersion: string;
        risk: Risk;
        confidence: number;
        output: unknown;
        latencyMs: number | null;
        createdAt: string;
      }>;
    }
    ''').lstrip(),
)
replace_once(
    "command-centre/src/app.ts",
    dedent('''
    function humanize(value: string): string {
      return value
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
    ''').lstrip(),
    dedent('''
    function humanize(value: string): string {
      return value
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function record(value: unknown): Record<string, unknown> | null {
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    }

    function stringArray(value: unknown): string[] {
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    }
    ''').lstrip(),
)
replace_once(
    "command-centre/src/app.ts",
    dedent('''
    function renderConversationDrawer(detail: ConversationDetail): string {
      const conversation = detail.conversation;
      const activeTask = detail.tasks.find((task) => !["resolved", "cancelled"].includes(task.status));
      const latestCandidate = detail.candidates[0];
    ''').lstrip(),
    dedent('''
    function renderConversationDrawer(detail: ConversationDetail): string {
      const conversation = detail.conversation;
      const activeTask = detail.tasks.find((task) => !["resolved", "cancelled"].includes(task.status));
      const latestCandidate = detail.candidates[0];
      const latestInbound = [...detail.messages].reverse().find((message) => message.direction === "inbound");
      const traceSourceMessageId = latestCandidate?.sourceMessageId ?? latestInbound?.id ?? null;
      const currentTrace = traceSourceMessageId
        ? detail.decisions.filter((decision) => decision.sourceMessageId === traceSourceMessageId)
        : [];
      const responseTrace = currentTrace.find((decision) => decision.stage === "response");
      const verificationTrace = currentTrace.find((decision) => decision.stage === "verification");
      const policyTrace = currentTrace.find((decision) => decision.stage === "policy");
      const policyOutput = record(policyTrace?.output);
      const finalVerification = record(policyOutput?.finalVerification);
      const finalQuality = record(policyOutput?.finalQuality);
      const draftFinalReply = typeof policyOutput?.draftFinalReply === "string" ? policyOutput.draftFinalReply : null;
      const finalReply = typeof policyOutput?.finalReply === "string" ? policyOutput.finalReply : latestCandidate?.text ?? null;
      const qualityIssues = stringArray(finalQuality?.issues);
      const deliveryEligible = policyOutput?.deliveryEligible === true;
    ''').lstrip(),
)
replace_once(
    "command-centre/src/app.ts",
    '            ${latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Latest AI candidate</p><span class="pill">${escapeHtml(latestCandidate.status)}</span></div><p>${escapeHtml(latestCandidate.text)}</p><small>${latestCandidate.providerMessageId ? "Provider message exists" : "Not sent to WhatsApp"}</small></div>` : ""}\n',
    dedent('''
                ${latestCandidate ? `<div class="candidate-card"><div><p class="eyebrow">Latest AI candidate</p><span class="pill">${escapeHtml(latestCandidate.status)}</span></div><p>${escapeHtml(latestCandidate.text)}</p><small>${latestCandidate.providerMessageId ? "Provider message exists" : "Not sent to WhatsApp"}</small></div>` : ""}
                ${policyTrace ? `<div class="candidate-card"><div><p class="eyebrow">Final response quality</p><span class="pill ${deliveryEligible ? "pill--normal" : "pill--urgent"}">${deliveryEligible ? "Passed" : "Blocked"}</span></div>
                  <dl class="task-meta">
                    <div><dt>Primary model</dt><dd>${escapeHtml(responseTrace?.modelId ?? "Not recorded")}</dd></div>
                    <div><dt>First verifier</dt><dd>${escapeHtml(verificationTrace?.modelId ?? "Not recorded")}</dd></div>
                    <div><dt>Final verifier</dt><dd>${escapeHtml(String(finalVerification?.modelId ?? policyTrace.modelId ?? "Not recorded"))}</dd></div>
                    <div><dt>Policy</dt><dd>${escapeHtml(policyTrace.policyVersion)}</dd></div>
                  </dl>
                  ${draftFinalReply ? `<p><strong>Post-policy draft</strong><br>${escapeHtml(draftFinalReply)}</p>` : ""}
                  ${finalReply ? `<p><strong>Final client reply</strong><br>${escapeHtml(finalReply)}</p>` : ""}
                  <small>${qualityIssues.length ? escapeHtml(qualityIssues.join(" · ")) : escapeHtml(String(finalVerification?.summary ?? "Final response passed every quality dimension."))}</small>
                </div>` : ""}
    ''').lstrip(),
)

# Strengthen source-code contract tests.
replace_once(
    "tests/automaticHandoffWorkerContract.test.ts",
    dedent('''
    test("the worker records handoff evidence in the policy decision", async () => {
      const worker = await readFile(
        new URL("../src/worker.ts", import.meta.url),
        "utf8",
      );
      assert.match(worker, /handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION/);
      assert.match(worker, /automatic_handoff_created/);
      assert.match(worker, /automatic_handoff_refreshed/);
    });
    ''').lstrip(),
    dedent('''
    test("the worker records handoff evidence in the policy decision", async () => {
      const worker = await readFile(
        new URL("../src/worker.ts", import.meta.url),
        "utf8",
      );
      assert.match(worker, /handoffPolicyVersion: HUMAN_HANDOFF_POLICY_VERSION/);
      assert.match(worker, /automatic_handoff_created/);
      assert.match(worker, /automatic_handoff_refreshed/);
    });

    test("the exact post-policy reply receives a second verifier and fail-closed quality gate", async () => {
      const worker = await readFile(
        new URL("../src/worker.ts", import.meta.url),
        "utf8",
      );
      const verify = worker.indexOf("verifyFinalClientReply");
      const quality = worker.indexOf("assessFinalResponseQuality");
      const queue = worker.indexOf("if (finalQuality.passed && (policy.canAutoSend || handoff.createTask))");
      assert.ok(verify >= 0);
      assert.ok(quality >= 0);
      assert.ok(queue >= 0);
      assert.ok(verify < queue);
      assert.ok(quality < queue);
      assert.match(worker, /final_response_quality_blocked/);
      assert.match(worker, /taskType: "system_failure"/);
      assert.match(worker, /dead-letter-handoff/);
    });
    ''').lstrip(),
)

TRACE_TEST = dedent(r'''
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Command Centre exposes exact model, prompt and final-quality trace", async () => {
  const [repository, serverTypes, browserTypes, app] = await Promise.all([
    readFile(new URL("../src/command-centre/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/command-centre/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../command-centre/src/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../command-centre/src/app.ts", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /from\("ai_decisions"\)/);
  assert.match(repository, /DecisionTraceView/);
  assert.match(serverTypes, /decisions: DecisionTraceView\[\]/);
  assert.match(browserTypes, /stage: "response" \| "verification" \| "policy"/);
  assert.match(app, /Final response quality/);
  assert.match(app, /Primary model/);
  assert.match(app, /First verifier/);
  assert.match(app, /Final verifier/);
  assert.match(app, /Post-policy draft/);
  assert.match(app, /Final client reply/);
});
''').lstrip()
write("tests/commandCentreDecisionTrace.test.ts", TRACE_TEST)

VERIFIER_CONTRACT_TEST = dedent(r'''
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  FINAL_RESPONSE_VERIFIER_INSTRUCTIONS,
  FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
} from "../src/ai/receptionist.js";

test("the final verifier reviews the exact post-policy client text", async () => {
  assert.equal(FINAL_RESPONSE_VERIFIER_PROMPT_VERSION, "hera-final-response-verifier-1.0.0");
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /exact post-policy text/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /specialised task/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /complaint/i);
  assert.match(FINAL_RESPONSE_VERIFIER_INSTRUCTIONS, /every score must be 2/i);

  const source = await readFile(new URL("../src/ai/receptionist.ts", import.meta.url), "utf8");
  assert.match(source, /verifyFinalClientReply/);
  assert.match(source, /exactPostPolicyDraft/);
  assert.match(source, /finalResponseVerificationSchema/);
});
''').lstrip()
write("tests/finalResponseVerifierContract.test.ts", VERIFIER_CONTRACT_TEST)

print("Applied system-wide final response quality gate")
