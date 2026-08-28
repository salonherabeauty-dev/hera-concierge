interface ModelUsagePart {
  stage: string;
  modelId: string;
  usage: unknown;
}

export const STAGE3R_FAILED_ATTEMPT_RESERVE_USD = 1;

export interface Stage3rAttemptAccounting {
  costUsd: number | null;
  issue: string | null;
  usageEvidence: unknown;
}

export const PRIORITY_PRICE_SNAPSHOT_2026_08_27: Readonly<
  Record<string, { input: number; output: number; basis: string }>
> = {
  "openai/gpt-5.6-sol": {
    input: 0.000004,
    output: 0.00002,
    basis: "Vercel AI Gateway priority tier",
  },
  "openai/gpt-5.6-terra": {
    input: 0.000004,
    output: 0.000024,
    basis: "Vercel AI Gateway priority tier",
  },
  "anthropic/claude-opus-5": {
    input: 0.00001,
    output: 0.00005,
    basis: "Vercel AI Gateway fast-tier conservative ceiling",
  },
  "anthropic/claude-sonnet-5": {
    input: 0.000003,
    output: 0.000015,
    basis: "Vercel AI Gateway maximum listed provider rate on 2026-08-27",
  },
};

export function stage3rUsageTokens(value: unknown): {
  input: number;
  output: number;
  total: number;
} {
  let input = 0;
  let output = 0;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      typeof record.inputTokens === "number" &&
      typeof record.outputTokens === "number"
    ) {
      input += record.inputTokens;
      output += record.outputTokens;
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return { input, output, total: input + output };
}

export function estimateStage3rAttemptCost(
  modelId: string,
  usage: unknown,
): { costUsd: number | null; issue: string | null } {
  const price = PRIORITY_PRICE_SNAPSHOT_2026_08_27[modelId];
  if (!price) {
    return { costUsd: null, issue: `missing_price:${modelId}` };
  }
  const tokens = stage3rUsageTokens(usage);
  if (tokens.total <= 0) {
    return { costUsd: null, issue: `missing_usage:${modelId}` };
  }
  const rawCost = tokens.input * price.input + tokens.output * price.output;
  return {
    // Match the ledger's NUMERIC(18,12) precision so binary floating-point
    // noise cannot make equivalent attempts compare or persist differently.
    costUsd: Number(rawCost.toFixed(12)),
    issue: null,
  };
}

export function accountStage3rAttempt(input: {
  modelId: string;
  usage: unknown;
  outcome: "completed" | "failed";
}): Stage3rAttemptAccounting {
  const estimate = estimateStage3rAttemptCost(input.modelId, input.usage);
  const missingUsage = estimate.issue === `missing_usage:${input.modelId}`;
  if (
    input.outcome !== "failed" ||
    estimate.costUsd !== null ||
    !missingUsage
  ) {
    return {
      ...estimate,
      usageEvidence: input.usage ?? null,
    };
  }

  return {
    costUsd: STAGE3R_FAILED_ATTEMPT_RESERVE_USD,
    issue: `failed_attempt_reserve:${input.modelId}`,
    usageEvidence: {
      accountingMode: "failed_attempt_reserve",
      providerUsageAvailable: false,
      reportedUsage: input.usage ?? null,
      reserveUsd: STAGE3R_FAILED_ATTEMPT_RESERVE_USD,
    },
  };
}

export function estimatedPriorityCost(parts: readonly ModelUsagePart[]): {
  costUsd: number | null;
  issues: string[];
} {
  let total = 0;
  const issues: string[] = [];
  for (const part of parts) {
    const estimate = estimateStage3rAttemptCost(part.modelId, part.usage);
    if (estimate.costUsd === null) {
      issues.push(`${estimate.issue}:${part.stage}`);
      continue;
    }
    total += estimate.costUsd;
  }
  return { costUsd: issues.length === 0 ? total : null, issues };
}
