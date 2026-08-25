import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTION_AUTHORITY_VERSION,
  getActionAuthorityContract,
  renderActionAuthorityPrompt,
  RUNTIME_ACTION_AUTHORITY_CONTRACTS,
} from "../src/governance/actionAuthority.js";
import {
  isBlockedLegacyKnowledge,
  knowledgeAuthorityRank,
  orderKnowledgeByAuthority,
} from "../src/governance/knowledgeAuthority.js";
import { searchStaticKnowledge } from "../src/knowledge/search.js";
import type { KnowledgeResult } from "../src/types.js";

const knowledgeCatalogUrl = new URL(
  "../governance/knowledge-authority-catalog.json",
  import.meta.url,
);
const actionContractsUrl = new URL(
  "../governance/action-authority-contracts.json",
  import.meta.url,
);
const constitutionUrl = new URL(
  "../governance/hera-service-constitution.json",
  import.meta.url,
);
const searchSourceUrl = new URL("../src/knowledge/search.ts", import.meta.url);

type KnowledgeCatalog = {
  constitutionVersion: string;
  sourcePrecedence: Array<{
    rank: number;
    sourceClass: string;
    runtimeEligible: boolean;
    conflictRule: string;
  }>;
  runtimeEligibility: {
    allowedStatuses: string[];
    blockedStatuses: string[];
    expiredRecordsBlocked: boolean;
    conflictsResolvedByPrecedence: boolean;
  };
  canonicalClaims: Array<{
    claimKey: string;
    authoritySource: string;
  }>;
  conflictSignaturesBlockedFromApprovedRuntime: string[];
};

type ActionCatalog = {
  version: string;
  globalRules: {
    unknownAction: string;
    liveProviderSend: string;
    externalMutationWithoutContract: string;
  };
  contracts: Array<{
    actionKey: string;
    authority: string;
    responsibleRole: string | null;
    taskType: string | null;
    requiredEvidence: string[];
    prohibitedClaims: string[];
  }>;
};

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function result(
  version: string,
  excerpt: string,
  score = 1,
): KnowledgeResult {
  return {
    id: `${version}:${score}`,
    title: version,
    excerpt,
    sourceUrl: null,
    version,
    score,
  };
}

test("knowledge authority catalogue is complete, ordered and fail closed", async () => {
  const catalogue = await readJson<KnowledgeCatalog>(knowledgeCatalogUrl);
  const constitution = await readJson<{ version: string; status: string }>(
    constitutionUrl,
  );

  assert.equal(catalogue.constitutionVersion, constitution.version);
  assert.equal(constitution.status, "approved_runtime_authoritative");
  assert.deepEqual(
    catalogue.sourcePrecedence.map((source) => source.rank),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.ok(catalogue.sourcePrecedence.every((source) => source.runtimeEligible));
  assert.deepEqual(catalogue.runtimeEligibility.allowedStatuses, ["approved"]);
  assert.ok(catalogue.runtimeEligibility.blockedStatuses.includes("draft"));
  assert.ok(catalogue.runtimeEligibility.blockedStatuses.includes("retired"));
  assert.equal(catalogue.runtimeEligibility.expiredRecordsBlocked, true);
  assert.equal(catalogue.runtimeEligibility.conflictsResolvedByPrecedence, true);
  assert.ok(catalogue.canonicalClaims.length >= 9);
  assert.ok(
    catalogue.canonicalClaims.every(
      (claim) => claim.authoritySource === constitution.version,
    ),
  );
  assert.ok(
    catalogue.conflictSignaturesBlockedFromApprovedRuntime.some((value) =>
      /7 working days/i.test(value),
    ),
  );
});

test("every external action is explicitly bounded and unknown action remains prohibited", async () => {
  const catalogue = await readJson<ActionCatalog>(actionContractsUrl);
  const keys = catalogue.contracts.map((contract) => contract.actionKey);

  assert.equal(catalogue.version, "2026-08-25.1");
  assert.equal(catalogue.globalRules.unknownAction, "prohibited");
  assert.equal(catalogue.globalRules.externalMutationWithoutContract, "prohibited");
  assert.match(catalogue.globalRules.liveProviderSend, /blocked/i);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.length >= 24);

  for (const contract of catalogue.contracts) {
    assert.ok(contract.requiredEvidence.length > 0 || contract.authority === "prohibited");
    assert.ok(contract.prohibitedClaims.length > 0);
    if (contract.authority === "human_required") {
      assert.ok(contract.responsibleRole);
      assert.ok(contract.taskType);
    }
  }

  for (const action of [
    "quote_live_availability",
    "create_booking",
    "reschedule_booking",
    "cancel_booking",
    "confirm_booking_outcome",
  ]) {
    assert.equal(
      catalogue.contracts.find((contract) => contract.actionKey === action)?.authority,
      "human_required",
    );
  }

  for (const action of ["approve_refund", "approve_voucher", "approve_compensation"]) {
    const contract = catalogue.contracts.find(
      (candidate) => candidate.actionKey === action,
    );
    assert.equal(contract?.authority, "human_required");
    assert.equal(contract?.responsibleRole, "managing_director_or_owner");
  }

  assert.equal(
    catalogue.contracts.find(
      (contract) => contract.actionKey === "send_ai_generated_whatsapp_reply",
    )?.authority,
    "prohibited",
  );
});

test("runtime contracts cover the machine catalogue and produce an explicit prompt", async () => {
  const catalogue = await readJson<ActionCatalog>(actionContractsUrl);
  const runtimeKeys = new Set<string>(
    RUNTIME_ACTION_AUTHORITY_CONTRACTS.map((contract) => contract.actionKey),
  );

  assert.equal(ACTION_AUTHORITY_VERSION, "hera-action-authority-2026-08-25.1");
  for (const contract of catalogue.contracts) {
    assert.ok(runtimeKeys.has(contract.actionKey), `missing runtime contract ${contract.actionKey}`);
  }
  assert.equal(getActionAuthorityContract("unlisted_external_action"), null);
  const prompt = renderActionAuthorityPrompt();
  assert.match(prompt, /Unknown or unlisted external actions are prohibited/i);
  assert.match(prompt, /create_booking: human_required/i);
  assert.match(prompt, /approve_refund: human_required/i);
  assert.match(prompt, /send_ai_generated_whatsapp_reply: prohibited/i);
});

test("knowledge ordering gives the approved constitution precedence and blocks legacy conflict text", () => {
  const legacy = result("hera-approved-v4", "Service concerns should be raised within 7 working days.", 1000);
  const website = result("website-2026-08-25", "Website information", 900);
  const operator = result("hera-operator-policy-v3", "Approved operator policy", 1);
  const constitution = result(
    "hera-service-constitution-2026-08-25.1",
    "Seven calendar days from appointment completion.",
    1,
  );

  assert.equal(isBlockedLegacyKnowledge(legacy), true);
  assert.ok(knowledgeAuthorityRank(constitution) > knowledgeAuthorityRank(operator));
  assert.ok(knowledgeAuthorityRank(operator) > knowledgeAuthorityRank(website));
  assert.deepEqual(
    orderKnowledgeByAuthority([legacy, website, operator, constitution], 5).map(
      (item) => item.version,
    ),
    ["hera-service-constitution-2026-08-25.1", "hera-operator-policy-v3", "website-2026-08-25"],
  );
});

test("runtime retrieval exposes approved policy and excludes the superseded concern window", () => {
  const concern = searchStaticKnowledge(
    "How long do I have to raise a service concern and who approves a refinement?",
    8,
  );
  const combined = concern.map((item) => item.excerpt).join("\n");

  assert.match(combined, /seven calendar days/i);
  assert.match(combined, /salon manager/i);
  assert.doesNotMatch(combined, /seven working days/i);
  assert.ok(
    concern.some(
      (item) =>
        item.version === "hera-service-constitution-2026-08-25.1" ||
        item.version === "hera-operator-policy-v3",
    ),
  );
});

test("knowledge retrieval is wired to deterministic authority ordering and action contracts", async () => {
  const source = await readFile(searchSourceUrl, "utf8");
  assert.match(source, /renderActionAuthorityPrompt/);
  assert.match(source, /orderKnowledgeByAuthority/);
  assert.match(source, /hera-service-constitution-2026-08-25\.1/);
});
