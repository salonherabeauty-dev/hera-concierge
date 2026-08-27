import {
  STAGE3R_DIMENSIONS,
  type Stage3rJudgeResult,
  type Stage3rPreference,
} from "./types.js";

/**
 * Gold anchors define the minimum send-ready standard. A blind tie therefore
 * establishes non-inferiority; only an explicit reference preference counts
 * against the candidate.
 *
 * The persisted field retains its original `candidatePreferenceRate` name for
 * database compatibility, but its governed meaning is candidate
 * non-inferiority rate (candidate or tie).
 */
export function candidateNonInferiorityRate(
  results: readonly Stage3rJudgeResult[],
): number | null {
  const pairwise = results.filter(
    (result) =>
      result.repeatedRun === 1 && result.preference !== "not_applicable",
  );
  if (pairwise.length === 0) return null;
  return pairwise.filter(
    (result) =>
      result.preference === "candidate" || result.preference === "tie",
  ).length / pairwise.length;
}

/**
 * A tie is an interval containing either decisive outcome. It is materially
 * compatible with candidate or reference, while candidate versus reference
 * is a real reversal. Raw preferences remain stored so strict agreement can
 * always be recomputed independently.
 */
export function materiallyCompatiblePreferences(
  preferences: readonly Stage3rPreference[],
): boolean {
  if (preferences.length === 0) return false;
  const decisive = new Set(
    preferences.filter(
      (preference) =>
        preference === "candidate" || preference === "reference",
    ),
  );
  if (decisive.size > 1) return false;
  const hasPointwise = preferences.includes("not_applicable");
  return hasPointwise
    ? preferences.every((preference) => preference === "not_applicable")
    : true;
}

function resultGroupKey(result: Stage3rJudgeResult): string {
  return `${result.judgeId}:${result.provider}:${result.modelId}`;
}

export function materiallyPositionConsistent(input: {
  hasReferenceResponse: boolean;
  results: readonly Stage3rJudgeResult[];
}): boolean {
  if (!input.hasReferenceResponse) return true;
  const pairwise = input.results.filter(
    (result) =>
      result.repeatedRun === 1 &&
      (result.order === "candidate_first" ||
        result.order === "reference_first"),
  );
  if (pairwise.length === 0) return false;

  const groups = new Map<string, Stage3rJudgeResult[]>();
  for (const result of pairwise) {
    const key = resultGroupKey(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

  for (const group of groups.values()) {
    const forward = group.filter(
      (result) => result.order === "candidate_first",
    );
    const reverse = group.filter(
      (result) => result.order === "reference_first",
    );
    if (forward.length !== 1 || reverse.length !== 1) return false;
    if (
      !materiallyCompatiblePreferences([
        forward[0]!.preference,
        reverse[0]!.preference,
      ])
    ) {
      return false;
    }
    for (const dimension of STAGE3R_DIMENSIONS) {
      if (
        Math.abs(
          forward[0]!.scores[dimension] - reverse[0]!.scores[dimension],
        ) > 1
      ) {
        return false;
      }
    }
  }
  return true;
}

export function materiallyRepeatedJudgeConsistent(input: {
  highConsequence: boolean;
  results: readonly Stage3rJudgeResult[];
}): boolean {
  if (!input.highConsequence) return true;
  const judgeKeys = new Set(input.results.map(resultGroupKey));
  if (judgeKeys.size === 0) return false;

  for (const judgeKey of judgeKeys) {
    const judgeResults = input.results.filter(
      (result) => resultGroupKey(result) === judgeKey,
    );
    const repeatedOrder = [
      "candidate_first",
      "reference_first",
      "pointwise",
    ].find(
      (order) =>
        judgeResults.some(
          (result) => result.order === order && result.repeatedRun === 1,
        ) &&
        judgeResults.some(
          (result) => result.order === order && result.repeatedRun === 2,
        ),
    );
    if (!repeatedOrder) return false;
    const repeats = judgeResults.filter(
      (result) => result.order === repeatedOrder,
    );
    if (
      repeats.length !== 2 ||
      new Set(repeats.map((result) => result.repeatedRun)).size !== 2 ||
      !materiallyCompatiblePreferences(
        repeats.map((result) => result.preference),
      )
    ) {
      return false;
    }
    for (const dimension of STAGE3R_DIMENSIONS) {
      const values = repeats.map((result) => result.scores[dimension]);
      if (Math.max(...values) - Math.min(...values) > 1) return false;
    }
    const flagSets = repeats.map((result) =>
      [...result.criticalFlags].sort().join("|"),
    );
    if (new Set(flagSets).size !== 1) return false;
  }
  return true;
}
