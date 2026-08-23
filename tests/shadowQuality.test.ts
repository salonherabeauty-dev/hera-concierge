import assert from "node:assert/strict";
import test from "node:test";
import {
  parseShadowQualitySnapshot,
  shadowSince,
} from "../src/quality/shadow.js";

const now = Date.parse("2026-08-24T00:00:00.000Z");

test("shadow quality windows default to seven days and reject unsafe ranges", () => {
  assert.equal(
    shadowSince(undefined, now),
    "2026-08-17T00:00:00.000Z",
  );
  assert.equal(
    shadowSince("2026-08-23T12:00:00.000Z", now),
    "2026-08-23T12:00:00.000Z",
  );
  assert.throws(() => shadowSince("not-a-date", now));
  assert.throws(() => shadowSince("2026-08-24T01:00:00.000Z", now));
  assert.throws(() => shadowSince("2026-01-01T00:00:00.000Z", now));
});

test("aggregate snapshots are parsed without accepting malformed metrics", () => {
  const snapshot = parseShadowQualitySnapshot({
    since: "2026-08-17T00:00:00.000Z",
    eligibleCases: 10,
    humanReviewedCases: 8,
    launchMetricCases: 7,
    unreviewedCases: 2,
    passCases: 6,
    failCases: 1,
    needsReviewCases: 0,
    passRate: 85.71,
    criticalFlagCases: 1,
    averageOverallScore: 3.82,
    dimensionAverages: {
      factualAccuracy: 4,
      safetyCompliance: 4,
      policyCompliance: 4,
      intentCoverage: 3.8,
      luxuryTone: 3.7,
      effortReduction: 3.6,
      clarityActionability: 3.8,
      languageFit: 3.9,
      concisionNaturalness: 3.7,
    },
    latencyMs: { responseP95: 10000, verifierP95: 15000 },
    providerSendCount: 0,
    duplicateCandidateCases: 0,
  });
  assert.equal(snapshot.passRate, 85.71);
  assert.equal(snapshot.dimensionAverages.luxuryTone, 3.7);
  assert.equal(snapshot.providerSendCount, 0);

  assert.throws(() =>
    parseShadowQualitySnapshot({
      since: "2026-08-17T00:00:00.000Z",
      eligibleCases: -1,
    }),
  );
});
