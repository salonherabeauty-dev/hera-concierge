import assert from "node:assert/strict";
import test from "node:test";
import {
  assessOperationalReadiness,
  ATTENTION_QUEUE_AGE_MS,
  CRITICAL_QUEUE_AGE_MS,
} from "../src/observability/readiness.js";
import type { OperationalSnapshot } from "../src/types.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

function snapshot(overrides: Partial<OperationalSnapshot> = {}): OperationalSnapshot {
  return {
    activeJobs: 0,
    deadJobs: 0,
    activeOutbox: 0,
    deadOutbox: 0,
    openIncidents: 0,
    blackIncidents: 0,
    oldestActiveJobCreatedAt: null,
    oldestActiveOutboxCreatedAt: null,
    ...overrides,
  };
}

test("empty queues with no unresolved incidents are healthy", () => {
  assert.deepEqual(assessOperationalReadiness(snapshot(), NOW), {
    level: "healthy",
    cutoverEligible: true,
    reasons: [],
    oldestJobAgeMs: null,
    oldestOutboxAgeMs: null,
  });
});

test("an open non-black incident requires attention but not a service outage", () => {
  const result = assessOperationalReadiness(snapshot({ openIncidents: 1 }), NOW);
  assert.equal(result.level, "attention");
  assert.equal(result.cutoverEligible, false);
  assert.deepEqual(result.reasons, ["incident_attention_required"]);
});

test("dead letters and open black incidents are critical", () => {
  const result = assessOperationalReadiness(
    snapshot({ deadJobs: 1, deadOutbox: 2, openIncidents: 1, blackIncidents: 1 }),
    NOW,
  );
  assert.equal(result.level, "critical");
  assert.equal(result.cutoverEligible, false);
  assert.deepEqual(result.reasons, [
    "dead_jobs_present",
    "dead_outbox_present",
    "black_incident_open",
  ]);
});

test("queue age moves from attention to critical at exact thresholds", () => {
  const attention = assessOperationalReadiness(
    snapshot({
      activeJobs: 1,
      oldestActiveJobCreatedAt: new Date(NOW - ATTENTION_QUEUE_AGE_MS).toISOString(),
    }),
    NOW,
  );
  assert.equal(attention.level, "attention");
  assert.equal(attention.oldestJobAgeMs, ATTENTION_QUEUE_AGE_MS);

  const critical = assessOperationalReadiness(
    snapshot({
      activeOutbox: 1,
      oldestActiveOutboxCreatedAt: new Date(NOW - CRITICAL_QUEUE_AGE_MS).toISOString(),
    }),
    NOW,
  );
  assert.equal(critical.level, "critical");
  assert.equal(critical.oldestOutboxAgeMs, CRITICAL_QUEUE_AGE_MS);
});

test("invalid and materially future queue timestamps fail closed", () => {
  const invalid = assessOperationalReadiness(
    snapshot({ activeJobs: 1, oldestActiveJobCreatedAt: "not-a-timestamp" }),
    NOW,
  );
  assert.equal(invalid.level, "critical");
  assert.deepEqual(invalid.reasons, ["invalid_job_queue_timestamp"]);

  const future = assessOperationalReadiness(
    snapshot({
      activeOutbox: 1,
      oldestActiveOutboxCreatedAt: new Date(NOW + 60_001).toISOString(),
    }),
    NOW,
  );
  assert.equal(future.level, "critical");
  assert.deepEqual(future.reasons, ["invalid_outbox_queue_timestamp"]);
});
