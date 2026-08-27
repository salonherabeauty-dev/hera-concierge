import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getStage3rJudgeConfigurations,
  stage3rJudgeScoreFields,
  STAGE3R_JUDGE_INSTRUCTIONS,
} from "../src/certification/stage3r/judge.js";
import {
  STAGE3R_CERTIFICATION_VERSION,
  STAGE3R_DIMENSIONS,
} from "../src/certification/stage3r/types.js";

const contractUrl = new URL(
  "../governance/stage3r-certification.json",
  import.meta.url,
);
const sourcesUrl = new URL(
  "../governance/stage3r-research-sources.json",
  import.meta.url,
);
const patternsUrl = new URL(
  "../governance/stage3r-salon-failure-patterns.json",
  import.meta.url,
);
const goldUrl = new URL(
  "../evals/stage3r-gold-cases.json",
  import.meta.url,
);
const gatesUrl = new URL(
  "../governance/pre-production-gates.json",
  import.meta.url,
);
const packageUrl = new URL("../package.json", import.meta.url);

type Contract = {
  version: string;
  status: string;
  approvedBy: { name: string; role: string; approvalMethod: string };
  manualPanel: {
    mandatory: boolean;
    replacement: string;
    ownerFinalAuthorisationStillRequired: boolean;
  };
  scope: {
    whatsappSendModeRequired: string;
    liveConfirmationRequiredAbsent: boolean;
    productionAndMainUntouched: boolean;
  };
  research: {
    sourceRegister: string;
    heraPolicyPrecedence: boolean;
    publicResearchMayOverrideHeraPolicy: boolean;
    rawThirdPartyReviewTextCommitted: boolean;
  };
  corpus: Record<string, unknown> & {
    minimumExactFinalResponses: number;
    minimumDistinctMessageFamilies: number;
  };
  judgeEnsemble: {
    minimumJudgeConfigurations: number;
    minimumModelProviders: number;
    generatorMayBeSoleJudge: boolean;
    blindModelIdentity: boolean;
    blindResponseLabels: boolean;
    orderReversalRequiredForPairwiseCases: boolean;
    repeatJudgingRequiredForDifficultCases: boolean;
  };
  dimensions: string[];
  runThresholds: Record<string, number | boolean>;
  releaseDecision: {
    stagePassRequiresAutomatedThresholds: boolean;
    stagePassRequiresOwnerFinalAuthorisation: boolean;
    stagePassEnablesLiveProduction: boolean;
    stage4Stage5Stage6Stage7RemainRequired: boolean;
  };
};

type ResearchSources = {
  globalRules: string[];
  sources: Array<{
    id: string;
    sourceClass: string;
    url: string;
    allowedUses: string[];
    prohibitedUses: string[];
  }>;
};

type GateRegister = {
  liveProductionApproved: boolean;
  shadowModeRequired: boolean;
  gates: Array<{
    id: string;
    status: string;
    evidence: Record<string, unknown>;
    blockers: string[];
  }>;
};

async function json<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

test("owner approval replaces the manual panel but preserves final owner authority", async () => {
  const contract = await json<Contract>(contractUrl);

  assert.equal(contract.version, STAGE3R_CERTIFICATION_VERSION);
  assert.equal(contract.status, "approved_in_progress");
  assert.equal(contract.approvedBy.name, "Neo Chin Chuan");
  assert.equal(contract.approvedBy.role, "Owner");
  assert.equal(
    contract.approvedBy.approvalMethod,
    "explicit_owner_approval_in_project_conversation",
  );
  assert.equal(contract.manualPanel.mandatory, false);
  assert.equal(
    contract.manualPanel.replacement,
    "research_calibrated_multi_provider_automated_certification",
  );
  assert.equal(contract.manualPanel.ownerFinalAuthorisationStillRequired, true);
  assert.equal(contract.releaseDecision.stagePassRequiresAutomatedThresholds, true);
  assert.equal(contract.releaseDecision.stagePassRequiresOwnerFinalAuthorisation, true);
  assert.equal(contract.releaseDecision.stagePassEnablesLiveProduction, false);
  assert.equal(contract.releaseDecision.stage4Stage5Stage6Stage7RemainRequired, true);
});

test("research calibration cannot override Hera policy or copy public reviews", async () => {
  const contract = await json<Contract>(contractUrl);
  const sources = await json<ResearchSources>(sourcesUrl);

  assert.equal(contract.research.heraPolicyPrecedence, true);
  assert.equal(contract.research.publicResearchMayOverrideHeraPolicy, false);
  assert.equal(contract.research.rawThirdPartyReviewTextCommitted, false);
  assert.ok(sources.sources.length >= 10);
  assert.ok(sources.globalRules.some((rule) => /Service Constitution/i.test(rule)));
  assert.ok(sources.globalRules.some((rule) => /review text/i.test(rule)));
  assert.ok(
    new Set(sources.sources.map((source) => source.sourceClass)).size >= 5,
  );
  for (const source of sources.sources) {
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.allowedUses.length > 0);
    assert.ok(source.prohibitedUses.length > 0);
  }
  assert.ok(sources.sources.some((source) => /nist/i.test(source.id)));
  assert.ok(sources.sources.some((source) => /ritz/i.test(source.id)));
  assert.ok(sources.sources.some((source) => /yelp/i.test(source.id)));
  assert.ok(sources.sources.some((source) => /position.bias/i.test(source.id)));
  assert.ok(sources.sources.some((source) => /self.preference/i.test(source.id)));
  assert.ok(sources.sources.some((source) => /beauty.service/i.test(source.id)));
});

test("Stage 3-R has a broad salon pattern catalogue and owner-grounded multilingual gold cases", async () => {
  const patterns = await json<{ patterns: Array<{ id: string; domain: string }> }>(patternsUrl);
  const gold = await json<
    Array<{
      id: string;
      language: string;
      referenceResponse: string;
      requiredElements: string[];
      forbiddenClaims: string[];
    }>
  >(goldUrl);

  assert.ok(patterns.patterns.length >= 25);
  assert.equal(new Set(patterns.patterns.map((item) => item.id)).size, patterns.patterns.length);
  assert.ok(new Set(patterns.patterns.map((item) => item.domain)).size >= 15);
  assert.ok(gold.length >= 20);
  assert.deepEqual(
    new Set(gold.map((item) => item.language)),
    new Set(["en", "zh", "ms", "ta"]),
  );
  for (const item of gold) {
    assert.ok(item.referenceResponse.trim().length >= 80);
    assert.ok(item.requiredElements.length > 0);
    assert.ok(item.forbiddenClaims.length > 0);
  }
});

test("the judge ensemble is multi-provider, blind and resistant to self and position preference", async () => {
  const contract = await json<Contract>(contractUrl);
  const configurations = getStage3rJudgeConfigurations({
    HERA_STAGE3R_JUDGE_MODELS:
      "anthropic/claude-opus-5,openai/gpt-5.6-terra,anthropic/claude-opus-5",
  });

  assert.equal(contract.judgeEnsemble.minimumJudgeConfigurations, 3);
  assert.equal(contract.judgeEnsemble.minimumModelProviders, 2);
  assert.equal(contract.judgeEnsemble.generatorMayBeSoleJudge, false);
  assert.equal(contract.judgeEnsemble.blindModelIdentity, true);
  assert.equal(contract.judgeEnsemble.blindResponseLabels, true);
  assert.equal(contract.judgeEnsemble.orderReversalRequiredForPairwiseCases, true);
  assert.equal(contract.judgeEnsemble.repeatJudgingRequiredForDifficultCases, true);
  assert.equal(configurations.length, 3);
  assert.ok(new Set(configurations.map((item) => item.provider)).size >= 2);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /exact final client-facing response/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /placed first/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /your own writing style/i);
  assert.match(STAGE3R_JUDGE_INSTRUCTIONS, /not automatically correct/i);
  assert.deepEqual(stage3rJudgeScoreFields(), STAGE3R_DIMENSIONS);
});

test("the certification contract remains shadow-only and fail closed on critical outcomes", async () => {
  const contract = await json<Contract>(contractUrl);

  assert.equal(contract.scope.whatsappSendModeRequired, "shadow");
  assert.equal(contract.scope.liveConfirmationRequiredAbsent, true);
  assert.equal(contract.scope.productionAndMainUntouched, true);
  assert.equal(contract.corpus.minimumExactFinalResponses, 2000);
  assert.equal(contract.corpus.minimumDistinctMessageFamilies, 40);
  assert.equal(contract.runThresholds.unsupportedHeraFacts, 0);
  assert.equal(contract.runThresholds.safetyPolicyFailures, 0);
  assert.equal(contract.runThresholds.unauthorisedBookingCompletionClaims, 0);
  assert.equal(contract.runThresholds.unauthorisedFinancialOutcomeClaims, 0);
  assert.equal(contract.runThresholds.whatsappProviderSends, 0);
  assert.equal(contract.runThresholds.heraFactualGroundingRate, 1);
  assert.equal(contract.runThresholds.safetyPolicyAuthorityComplianceRate, 1);
  assert.equal(contract.runThresholds.allHighConsequenceCasesMustPass, true);
});

test("the gate register records Stage 3-R as approved but not passed or live", async () => {
  const register = await json<GateRegister>(gatesUrl);
  const stageThree = register.gates.find(
    (gate) => gate.id === "stage_3_luxury_hospitality_certification",
  );

  assert.equal(register.liveProductionApproved, false);
  assert.equal(register.shadowModeRequired, true);
  assert.equal(stageThree?.status, "in_progress");
  assert.equal(stageThree?.evidence.programme, "stage_3r_research_calibrated_automated_certification");
  assert.equal(stageThree?.evidence.mandatoryManualPanelReplaced, true);
  assert.equal(stageThree?.evidence.ownerFinalAuthorisationStillRequired, true);
  assert.equal(stageThree?.evidence.targetExactFinalResponses, 2010);
  assert.equal(stageThree?.evidence.databaseMigrationApplied, true);
  assert.equal(stageThree?.evidence.databaseMigrationLedgerVersion, "20260827083233");
  assert.ok(
    !stageThree?.blockers.includes("stage3r_database_migration_not_yet_applied"),
  );
  assert.ok(
    stageThree?.blockers.includes(
      "full_2010_case_release_candidate_run_not_yet_completed",
    ),
  );
  assert.ok(
    stageThree?.blockers.includes(
      "owner_final_stage3r_authorisation_not_yet_recorded",
    ),
  );
});

test("the Stage 3-R runner is permanent tooling without contaminating the deployment build", async () => {
  const packageJson = await json<{ scripts: Record<string, string> }>(packageUrl);

  assert.equal(packageJson.scripts.build, "npm run build:command-centre");
  assert.equal(
    packageJson.scripts["certify:stage3r"],
    "tsx src/certification/stage3r/run.ts",
  );
  assert.doesNotMatch(packageJson.scripts.build, /stage3r|certif|eval/i);
});
