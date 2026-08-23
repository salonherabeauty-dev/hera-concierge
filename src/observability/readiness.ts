import type { OperationalSnapshot } from "../types.js";

export const ATTENTION_QUEUE_AGE_MS = 5 * 60 * 1000;
export const CRITICAL_QUEUE_AGE_MS = 10 * 60 * 1000;

export type ReadinessLevel = "healthy" | "attention" | "critical";

export interface OperationalReadiness {
  level: ReadinessLevel;
  cutoverEligible: boolean;
  reasons: string[];
  oldestJobAgeMs: number | null;
  oldestOutboxAgeMs: number | null;
}

function queueAge(
  createdAt: string | null,
  nowMs: number,
): { ageMs: number | null; invalid: boolean } {
  if (createdAt === null) return { ageMs: null, invalid: false };
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || timestamp > nowMs + 60_000) {
    return { ageMs: null, invalid: true };
  }
  return { ageMs: Math.max(0, nowMs - timestamp), invalid: false };
}

export function assessOperationalReadiness(
  snapshot: OperationalSnapshot,
  nowMs = Date.now(),
): OperationalReadiness {
  const reasons: string[] = [];
  let level: ReadinessLevel = "healthy";
  const jobAge = queueAge(snapshot.oldestActiveJobCreatedAt, nowMs);
  const outboxAge = queueAge(snapshot.oldestActiveOutboxCreatedAt, nowMs);

  const critical = (reason: string): void => {
    level = "critical";
    reasons.push(reason);
  };
  const attention = (reason: string): void => {
    if (level === "healthy") level = "attention";
    reasons.push(reason);
  };

  if (snapshot.deadJobs > 0) critical("dead_jobs_present");
  if (snapshot.deadOutbox > 0) critical("dead_outbox_present");
  if (snapshot.blackIncidents > 0) critical("black_incident_open");
  else if (snapshot.openIncidents > 0) attention("incident_attention_required");

  if (jobAge.invalid) critical("invalid_job_queue_timestamp");
  else if (jobAge.ageMs !== null && jobAge.ageMs >= CRITICAL_QUEUE_AGE_MS) {
    critical("job_queue_critical_age");
  } else if (jobAge.ageMs !== null && jobAge.ageMs >= ATTENTION_QUEUE_AGE_MS) {
    attention("job_queue_attention_age");
  }

  if (outboxAge.invalid) critical("invalid_outbox_queue_timestamp");
  else if (
    outboxAge.ageMs !== null &&
    outboxAge.ageMs >= CRITICAL_QUEUE_AGE_MS
  ) {
    critical("outbox_queue_critical_age");
  } else if (
    outboxAge.ageMs !== null &&
    outboxAge.ageMs >= ATTENTION_QUEUE_AGE_MS
  ) {
    attention("outbox_queue_attention_age");
  }

  return {
    level,
    cutoverEligible: level === "healthy",
    reasons,
    oldestJobAgeMs: jobAge.ageMs,
    oldestOutboxAgeMs: outboxAge.ageMs,
  };
}
