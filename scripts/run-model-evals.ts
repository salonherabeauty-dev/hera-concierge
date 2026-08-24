import { readFile } from "node:fs/promises";
import {
  generateReceptionistDecision,
  verifyReceptionistDecision,
} from "../src/ai/receptionist.js";
import { getAiConfig } from "../src/config.js";
import type { ReceptionistRepository } from "../src/db/repository.js";
import {
  assessPolicy,
  classifyDeterministicRisk,
  highestRisk,
} from "../src/policy/risk.js";
import { assessGrounding } from "../src/policy/grounding.js";
import type {
  AgentDecision,
  ConversationMessage,
  JobContext,
  RiskLevel,
} from "../src/types.js";

interface HistoryTurn {
  direction: "inbound" | "outbound";
  text: string;
}

interface Scenario {
  id: string;
  category: string;
  message: string;
  minimumRisk: RiskLevel;
  securityFlag?: string;
  expectedContainment?: string;
  intents?: string[];
  history?: HistoryTurn[];
  priorRisk?: RiskLevel;
}

const ranks: Record<RiskLevel, number> = { green: 0, amber: 1, red: 2, black: 3 };
const scenarioFiles = ["scenarios.json", "scenarios-expanded.json"];
const scenarios = (
  await Promise.all(
    scenarioFiles.map(async (filename) =>
      JSON.parse(
        await readFile(new URL(`../evals/${filename}`, import.meta.url), "utf8"),
      ) as Scenario[],
    ),
  )
).flat();
const limit = Math.max(1, Math.min(Number(process.env.EVAL_LIMIT ?? scenarios.length), scenarios.length));
const repository = {
  searchApprovedKnowledge: async () => [],
  lookupBookingsByWaId: async () => [],
} as unknown as ReceptionistRepository;
const config = getAiConfig();
let failures = 0;

for (const [index, scenario] of scenarios.slice(0, limit).entries()) {
  const now = new Date().toISOString();
  const messageId = `eval-message-${index}`;
  const context: JobContext = {
    job: {
      id: `eval-job-${index}`,
      kind: "process_inbound",
      sourceMessageId: messageId,
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    },
    message: {
      id: messageId,
      conversationId: `eval-conversation-${index}`,
      contactId: `eval-contact-${index}`,
      providerMessageId: `wamid.eval-${index}`,
      direction: "inbound",
      kind: "text",
      text: scenario.message,
      media: null,
      providerTimestamp: now,
      createdAt: now,
    },
    contact: {
      id: `eval-contact-${index}`,
      waId: `659000${String(index).padStart(4, "0")}`,
      profileName: "Evaluation Client",
      preferredLanguage: null,
    },
    conversationRisk: scenario.priorRisk ?? "green",
  };

  const history: ConversationMessage[] = [
    ...(scenario.history ?? []).map((turn, turnIndex) => ({
      id: `eval-history-${index}-${turnIndex}`,
      direction: turn.direction,
      kind: "text" as const,
      text: turn.text,
      createdAt: now,
    })),
    {
      id: messageId,
      direction: "inbound",
      kind: "text",
      text: scenario.message,
      createdAt: now,
    },
  ];

  try {
    const generated = await generateReceptionistDecision({
      repository,
      context,
      history,
      interpreted: { text: scenario.message },
      config,
    });
    const verification = await verifyReceptionistDecision({
      originalMessage: scenario.message,
      history,
      decision: generated.decision,
      evidence: generated.evidence,
      contactId: context.contact.id,
      config,
    });
    if (!verification.approved && !verification.correctedReply) {
      throw new Error("Verifier rejected the client reply without a correction");
    }
    if (!verification.handoffApproved && !verification.correctedHandoff) {
      throw new Error("Verifier rejected the human handoff without a correction");
    }
    const decision: AgentDecision = {
      ...generated.decision,
      reply: verification.approved
        ? generated.decision.reply
        : verification.correctedReply!,
      risk: highestRisk(generated.decision.risk, verification.risk),
      handoff: verification.handoffApproved
        ? generated.decision.handoff
        : verification.correctedHandoff!,
    };
    const grounding = assessGrounding(scenario.message, decision);
    if (!grounding.grounded && grounding.replyOverride) {
      decision.reply = grounding.replyOverride;
      decision.confidence = Math.min(
        decision.confidence,
        grounding.confidenceCap ?? decision.confidence,
      );
      decision.sources = [];
      decision.factualBasis = ["no_factual_claim"];
    }
    const policy = assessPolicy(
      scenario.message,
      decision,
      context.conversationRisk,
    );
    const deterministic = classifyDeterministicRisk(scenario.message);
    const passedRisk = ranks[policy.risk] >= ranks[scenario.minimumRisk];
    const passedSecurity =
      !scenario.securityFlag || deterministic.securityFlags.includes(scenario.securityFlag);
    const passed = passedRisk && passedSecurity;
    if (!passed) failures += 1;
    console.log(
      JSON.stringify({
        id: scenario.id,
        category: scenario.category,
        passed,
        expectedMinimumRisk: scenario.minimumRisk,
        priorConversationRisk: context.conversationRisk,
        finalRisk: policy.risk,
        intent: decision.intent,
        confidence: decision.confidence,
        responseModel: generated.modelId,
        verifierModel: verification.modelId,
        sources: decision.sources.map((source) => source.id),
        groundingRequired: grounding.required,
        grounded: grounding.grounded,
        groundingFlags: grounding.flags,
        reply: policy.replyOverride ?? decision.reply,
      }),
    );
  } catch (error) {
    failures += 1;
    console.error(
      JSON.stringify({
        id: scenario.id,
        passed: false,
        error: error instanceof Error ? error.message : "unknown evaluation error",
      }),
    );
  }
}

if (failures > 0) {
  console.error(`${failures} of ${limit} model evaluations failed.`);
  process.exitCode = 1;
} else {
  console.log(`All ${limit} model evaluations passed their minimum gates.`);
}
