from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:140]!r}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src/ai/receptionist.ts",
    'export const FINAL_RESPONSE_VERIFIER_PROMPT_VERSION =\n  "hera-final-response-verifier-1.0.0";',
    'export const FINAL_RESPONSE_VERIFIER_PROMPT_VERSION =\n  "hera-final-response-verifier-1.1.0";',
)

replace_once(
    "src/worker.ts",
    '''import {
  assessHumanHandoff,
  HUMAN_HANDOFF_POLICY_VERSION,
} from "./policy/handoff.js";''',
    '''import {
  assessHumanHandoff,
  HUMAN_HANDOFF_POLICY_VERSION,
  type HumanHandoffAssessment,
} from "./policy/handoff.js";''',
)

replace_once(
    "src/worker.ts",
    '''import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "./policy/finalResponseQuality.js";''',
    '''import {
  assessFinalResponseQuality,
  FINAL_RESPONSE_QUALITY_POLICY_VERSION,
} from "./policy/finalResponseQuality.js";
import { detectSupportedClientLocale } from "./policy/locale.js";''',
)

replace_once(
    "src/worker.ts",
    '''  AgentHandoffFacts,
  DrainSummary,''',
    '''  AgentHandoffFacts,
  DrainSummary,
  PolicyAssessment,''',
)

old_verification = '''  const finalVerification = await verifyFinalClientReply({
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
  });'''

new_verification = '''  const initialFinalVerification = await verifyFinalClientReply({
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
    initialFinalVerification.approved
      ? draftFinalReply
      : initialFinalVerification.correctedReply!,
  );
  const finalQuality = assessFinalResponseQuality({
    clientMessage: interpreted.text,
    reply: finalReply,
    decision,
    policy,
    handoff,
    risk: policy.risk,
  });
  const finalVerification = initialFinalVerification.approved
    ? initialFinalVerification
    : await verifyFinalClientReply({
        originalMessage: interpreted.text,
        history,
        draftReply: finalReply,
        decision,
        evidence: responseEvidence,
        policy,
        handoff,
        deterministicDraftQuality: asJson(finalQuality),
        contactId: context.contact.id,
        config: runtime.ai,
      });
  const deliveryEligible = finalQuality.passed && finalVerification.approved;
  const verificationUsage = asJson({
    initial: initialFinalVerification.usage,
    exactFinal:
      finalVerification === initialFinalVerification
        ? null
        : finalVerification.usage,
  });
  const verificationLatencyMs =
    initialFinalVerification.latencyMs +
    (finalVerification === initialFinalVerification
      ? 0
      : finalVerification.latencyMs);
  await runtime.repository.recordDecision({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    stage: "policy",
    modelId: finalVerification.modelId,
    promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
    policyVersion: FINAL_RESPONSE_QUALITY_POLICY_VERSION,
    risk: policy.risk,
    confidence: deliveryEligible
      ? decision.confidence
      : Math.min(decision.confidence, 0.2),
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
      initialFinalVerification: {
        approved: initialFinalVerification.approved,
        correctedReply: initialFinalVerification.correctedReply,
        issues: initialFinalVerification.issues,
        scores: initialFinalVerification.scores,
        summary: initialFinalVerification.summary,
        modelId: initialFinalVerification.modelId,
        promptVersion: FINAL_RESPONSE_VERIFIER_PROMPT_VERSION,
        latencyMs: initialFinalVerification.latencyMs,
        usage: initialFinalVerification.usage,
      },
      finalReply,
      finalQuality,
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
      correctionReverified:
        initialFinalVerification.approved || finalVerification.approved,
      deliveryEligible,
    }),
    usage: verificationUsage,
    latencyMs: verificationLatencyMs,
  });'''

replace_once("src/worker.ts", old_verification, new_verification)

replace_once(
    "src/worker.ts",
    "      clientVisibleStatus: finalQuality.passed ? finalReply : null,",
    "      clientVisibleStatus: deliveryEligible ? finalReply : null,",
)
replace_once(
    "src/worker.ts",
    "  if (!finalQuality.passed) {",
    "  if (!deliveryEligible) {",
)
replace_once(
    "src/worker.ts",
    '''        issues: finalQuality.issues,
        finalVerifierModelId: finalVerification.modelId,''',
    '''        deterministicIssues: finalQuality.issues,
        finalVerifierApproved: finalVerification.approved,
        finalVerifierIssues: finalVerification.issues,
        finalVerifierModelId: finalVerification.modelId,''',
)
replace_once(
    "src/worker.ts",
    "  if (finalQuality.passed && (policy.canAutoSend || handoff.createTask)) {",
    "  if (deliveryEligible && (policy.canAutoSend || handoff.createTask)) {",
)
replace_once(
    "src/worker.ts",
    "    const containmentStatus = finalQuality.passed",
    "    const containmentStatus = deliveryEligible",
)

fallback_helper = '''
function deadLetterFallbackReply(clientMessage: string): string {
  const locale = detectSupportedClientLocale(clientMessage);
  if (locale === "zh") {
    return "感谢您的消息。很抱歉，我目前无法安全地完成这项查询。我已将您的消息交给 Hera 的沙龙经理直接审核，团队将继续协助您。如果您出现呼吸困难、严重肿胀、眼睛接触化学品或剧烈疼痛，请立即就医。";
  }
  if (locale === "ms") {
    return "Terima kasih atas mesej anda. Maaf, saya tidak dapat melengkapkan semakan ini dengan selamat buat masa ini. Saya telah menyerahkan mesej anda kepada pengurus salon Hera untuk semak secara langsung, dan pasukan akan membantu anda seterusnya. Jika anda mengalami kesukaran bernafas, bengkak teruk, bahan kimia terkena mata atau sakit yang teruk, dapatkan rawatan perubatan segera.";
  }
  if (locale === "ta") {
    return "உங்கள் செய்திக்கு நன்றி. மன்னிக்கவும், இப்போது இந்தச் சரிபார்ப்பை பாதுகாப்பாக முடிக்க முடியவில்லை. உங்கள் செய்தியை நேரடி மதிப்பாய்விற்காக Hera சலூன் மேலாளரிடம் ஒப்படைத்துள்ளேன்; குழு தொடர்ந்து உங்களுக்கு உதவும். மூச்சுத் திணறல், கடுமையான வீக்கம், கண்ணில் இரசாயனம் படுதல் அல்லது கடுமையான வலி இருந்தால், உடனடியாக மருத்துவ உதவி பெறுங்கள்.";
  }
  return "Thank you for your message. I’m sorry, but I’m unable to complete the check safely just now. I’ve placed your message with Hera’s salon manager for direct review, and the team will assist you from here. If you are experiencing breathing difficulty, severe swelling, eye exposure or severe pain, please seek urgent medical attention immediately.";
}
'''

replace_once(
    "src/worker.ts",
    '''function emptyHandoffFacts(): AgentHandoffFacts {
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
''',
    '''function emptyHandoffFacts(): AgentHandoffFacts {
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
''' + fallback_helper,
)

old_fallback = '''  const context = await repository.getJobContext(job);
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
  });'''

new_fallback = '''  const context = await repository.getJobContext(job);
  const fallbackReply = deadLetterFallbackReply(context.message.text);
  const fallbackFacts = emptyHandoffFacts();
  const fallbackHandoff: HumanHandoffAssessment = {
    createTask: true,
    taskType: "system_failure",
    scope: "full_takeover",
    priority: "high",
    assignedRole: "salon_manager",
    assignedOutlet: null,
    summary: "AI processing failed after all protected retries.",
    requestedAction:
      "Review the client’s exact message and respond directly before returning the conversation to AI.",
    collectedFacts: fallbackFacts,
    missingFacts: [],
    clientReplyOverride: fallbackReply,
    clientVisibleStatus: fallbackReply,
    dedupeKey: `dead-letter-handoff:${context.message.id}`,
    reason: "Protected AI processing could not complete after all retries.",
  };
  const fallbackDecision: AgentDecision = {
    reply: fallbackReply,
    intent: "other",
    risk: "amber",
    confidence: 1,
    language: "same as client where reliably supported",
    sources: [],
    factualBasis: ["safety_policy"],
    proposedActions: ["create_handoff_task"],
    requiresManagementNotification: true,
    handoff: {
      required: true,
      taskType: "system_failure",
      scope: "full_takeover",
      priority: "high",
      assignedRole: "salon_manager",
      assignedOutlet: null,
      summary: fallbackHandoff.summary,
      requestedAction: fallbackHandoff.requestedAction,
      collectedFacts: fallbackFacts,
      missingFacts: [],
      clientAcknowledgement: fallbackReply,
    },
    rationale: "Fail-closed human ownership after protected AI processing failed.",
  };
  const fallbackPolicy: PolicyAssessment = {
    risk: "amber",
    canAutoSend: true,
    requiresManagementNotification: true,
    requiresIncident: true,
    blockedActions: [],
    securityFlags: [],
    replyOverride: null,
  };
  const fallbackQuality = assessFinalResponseQuality({
    clientMessage: context.message.text,
    reply: fallbackReply,
    decision: fallbackDecision,
    policy: fallbackPolicy,
    handoff: fallbackHandoff,
    risk: "amber",
  });
  if (!fallbackQuality.passed) {
    throw new Error("Dead-letter fallback failed Hera’s deterministic quality gate");
  }

  await repository.upsertAutomaticHandoff({
    conversationId: context.message.conversationId,
    sourceMessageId: context.message.id,
    taskType: fallbackHandoff.taskType!,
    scope: fallbackHandoff.scope!,
    priority: fallbackHandoff.priority!,
    assignedRole: fallbackHandoff.assignedRole,
    assignedOutlet: fallbackHandoff.assignedOutlet,
    summary: fallbackHandoff.summary!,
    requestedAction: fallbackHandoff.requestedAction!,
    collectedFacts: fallbackHandoff.collectedFacts,
    missingFacts: fallbackHandoff.missingFacts,
    clientVisibleStatus: fallbackReply,
    dedupeKey: fallbackHandoff.dedupeKey!,
  });'''

replace_once("src/worker.ts", old_fallback, new_fallback)

replace_once(
    "tests/finalResponseVerifierContract.test.ts",
    'assert.equal(FINAL_RESPONSE_VERIFIER_PROMPT_VERSION, "hera-final-response-verifier-1.0.0");',
    'assert.equal(FINAL_RESPONSE_VERIFIER_PROMPT_VERSION, "hera-final-response-verifier-1.1.0");',
)

worker_contract = ROOT / "tests" / "automaticHandoffWorkerContract.test.ts"
contract_text = worker_contract.read_text(encoding="utf-8")
contract_text = contract_text.replace(
    'worker.indexOf("if (finalQuality.passed && (policy.canAutoSend || handoff.createTask))")',
    'worker.indexOf("if (deliveryEligible && (policy.canAutoSend || handoff.createTask))")',
)
contract_text = contract_text.replace(
    r'/clientVisibleStatus: finalQuality\.passed \? finalReply : null/',
    r'/clientVisibleStatus: deliveryEligible \? finalReply : null/',
)
extra_contract = '''

test("a corrected final reply is re-verified before becoming delivery eligible", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /initialFinalVerification/);
  assert.match(worker, /const finalVerification = initialFinalVerification\.approved/);
  assert.match(worker, /draftReply: finalReply/);
  assert.match(
    worker,
    /const deliveryEligible = finalQuality\.passed && finalVerification\.approved/,
  );
});

test("dead-letter client text is localized, deterministically checked and backed by a durable manager task", async () => {
  const worker = await readFile(
    new URL("../src/worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /deadLetterFallbackReply/);
  assert.match(worker, /detectSupportedClientLocale/);
  assert.match(worker, /Dead-letter fallback failed Hera’s deterministic quality gate/);
  assert.match(worker, /dead-letter-handoff/);
});
'''
if "a corrected final reply is re-verified before becoming delivery eligible" not in contract_text:
    contract_text = contract_text.rstrip() + extra_contract
worker_contract.write_text(contract_text.rstrip() + "\n", encoding="utf-8")

for relative in [
    "src/ai/receptionist.ts",
    "src/worker.ts",
    "tests/finalResponseVerifierContract.test.ts",
]:
    target = ROOT / relative
    target.write_text(target.read_text(encoding="utf-8").rstrip() + "\n", encoding="utf-8")

print("Applied exact final reply re-verification and protected fallback")
