# Production Readiness Standard

## Current declaration

Status: **shadow candidate; not a production-performance claim**.

Meta App Review remains independent of this engineering work. The receptionist must
stay in shadow mode until every launch gate has evidence, the exact deployment is
approved and both live-send controls are deliberately enabled.

## Operational service levels

| Control | Target | Attention | Critical / launch blocker |
|---|---:|---:|---:|
| Valid signed webhook acknowledgements | at least 99.99% 2xx | below 99.99% | sustained failure or any lost inbound message |
| Webhook acknowledgement latency | p95 under 1 second, p99 under 3 seconds | p95 at least 1 second | p99 at least 3 seconds |
| Oldest active job or outbox item | under 5 minutes | 5–10 minutes | at least 10 minutes |
| Dead jobs or outbox items | 0 | n/a | any item |
| Duplicate external replies | 0 | n/a | any duplicate |
| Free-form replies outside Meta's service window | 0 | n/a | any send attempt |
| Shadow-mode Meta send calls | 0 | n/a | any call |
| Secrets, raw messages, prompts or media in logs | 0 | n/a | any disclosure |
| AI decision latency | p95 under 45 seconds, p99 under 120 seconds | p95 at least 45 seconds | p99 at least 120 seconds during pilot |

Targets become measured claims only after the evaluation report names the sample,
time window, commit, deployment and evidence source.

## Private readiness endpoint

`GET /api/internal/readiness` requires `Authorization: Bearer <CRON_SECRET>`.
It validates required configuration, reads aggregate operational state and returns
only counts, queue ages and machine-readable reason codes. It never returns client
content, identifiers, provider payloads, model prompts or credentials.

- `healthy` returns HTTP 200 and is the only state eligible for cutover review.
- `attention` returns HTTP 200 but blocks cutover until reviewed.
- `critical` returns HTTP 503 and requires containment before any live pilot.
- A failed database query, invalid timestamp or invalid configuration fails closed.

This endpoint proves configuration format and database state. It does not prove
Meta, Supabase or model-provider end-to-end connectivity; those require the signed
smoke tests and shadow soak in the launch runbook.

## Evidence required before limited live use

- exact Git commit and immutable Vercel deployment URL;
- passing strict type check and complete automated test result;
- signed Meta webhook verification and valid inbound/status fixtures;
- shadow evaluation meeting every threshold in `docs/EVALUATION_PLAN.md`;
- readiness response showing `healthy` immediately before approval;
- recorded kill-switch drill returning both controls to shadow;
- named operator, monitoring window and incident contact;
- approved daily AI/Meta spending cap and alert threshold;
- explicit written approval for the exact pilot number and deployment.

## Monitoring and containment

During a pilot, inspect the readiness endpoint and Vercel operational events before
opening traffic, after every deployment and at least every 15 minutes. Any critical
state triggers the rollback procedure in `docs/LAUNCH_RUNBOOK.md`. Keep webhook
ingestion active, preserve evidence and never delete queued or incident records to
make a dashboard appear healthy.
