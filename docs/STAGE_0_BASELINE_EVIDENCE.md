# Hera AI Receptionist — Stage 0 Baseline Evidence

**Evidence date:** 25 August 2026  
**Environment:** protected Vercel Preview  
**Authoritative branch:** `feat/hera-ai-receptionist-foundation`  
**Staging database:** `hera-ai-receptionist-staging`  
**WhatsApp provider:** 360dialog Coexistence  
**Delivery mode:** shadow  
**Production/main changed:** no

## Baseline-lock implementation

Stage 0 introduced permanent controls that:

- restore a deterministic deployment build with no one-time diagnostic dependency;
- make CI execute the same `npm run build` command used by Vercel;
- verify generated Command Centre assets are committed and reproducible;
- prevent temporary audit, repair or proof scripts from becoming part of the normal deployment build;
- retain strict TypeScript validation, the complete automated suite, credential scanning and production dependency auditing;
- define the full Pre-Production Certification Standard in `docs/PRE_PRODUCTION_CERTIFICATION.md`.

The baseline-lock pull request passed its full checks, was merged into the authoritative staging branch and produced a READY protected Preview deployment. `main`, Production, the Virtual Stylist and the pre-consultation system were not changed.

## Runtime residue discovered

The first authoritative runtime probe correctly failed Stage 0 closed. It found:

- one dead receptionist job;
- one retry job older than the critical queue threshold;
- four open amber incidents;
- no active or dead client outbox item;
- shadow mode active and live confirmation disabled.

Both failed jobs belonged to acknowledgement-only inbound messages and had failed structured-output generation before the hardened runtime existed. Neither had a WhatsApp provider-send record.

The four open incidents comprised:

- two appointment-change records;
- one media-follow-up record;
- one known controlled staging complaint whose named complaint task was already resolved.

## Guarded reconciliation

The reconciliation ran only on the staging Preview and required:

- exact authoritative Preview branch;
- `WHATSAPP_SEND_MODE=shadow`;
- live confirmation disabled;
- exact known job and source-message identifiers for queue residue;
- acknowledgement-only source-message validation;
- zero provider-send evidence;
- pre-baseline creation time;
- supported incident categories only;
- an active owner profile for audited Command Centre actions.

It then:

- completed the two acknowledgement-only residue jobs without creating or sending a client reply;
- cancelled two acknowledgement-only `system_failure` tasks through the audited task-transition function;
- returned two system-failure conversations to AI only after confirming no full-takeover or emergency blocker remained;
- created two durable human-review tasks for pre-baseline incidents that lacked ownership;
- linked or preserved existing human tasks for the remaining incidents;
- closed all four pre-baseline incident records with an explicit resolution and audit event;
- retained all substantive appointment, consent and technical work rather than deleting it to make readiness appear healthy.

## Runtime proof

**Proof commit:** `f1314a15acc0347b49df5f2258335ff7d57170f4`  
**Proof deployment:** `hera-concierge-2arovohlk-hera-concierge-team.vercel.app`  
**Vercel deployment ID:** `dpl_Fo4TPe6Fis2JPzSkdaWkJH8wkiug`  
**Deployment state:** READY

Final machine-readable readiness result:

```text
Provider:                  360dialog
Mode:                      shadow
Live confirmation:         disabled
Readiness:                 healthy
Cutover eligible by the
aggregate readiness check: true
Reasons:                   none
Active jobs:               0
Dead jobs:                 0
Active outbox:             0
Dead outbox:               0
Open incidents:            0
Open black incidents:      0
Oldest job age:            none
Oldest outbox age:         none
WhatsApp provider send:    not attempted
Production touched:        no
```

## Preserved human work

Eight open human-action tasks remained after the reconciliation. They were deliberately retained because Stage 0 must not cancel substantive client or operational work merely to improve a dashboard. The aggregate readiness endpoint does not treat those durable human-owned tasks as queue failures. Their ownership, SLA and resolution form part of the later Command Centre and operational certification gates.

Expired timed human-takeover records are released automatically when the next inbound message or outbound authorisation is evaluated. Active or indefinite takeovers are not bulk-reset without a task-aware, audited reason.

## Stage 0 decision

The engineering baseline, queue integrity, shadow-send protection and aggregate runtime readiness requirements have passed for the evidence deployment above.

This is **not** approval for live Production. Pre-Production Certification remains open for:

- the signed Hera Service Constitution and conflict-free source of truth;
- human-task ownership and SLA certification;
- the required shadow corpus and human scoring volumes;
- resilience and failure-injection testing;
- multilingual, voice-note, medical, legal, privacy, refund and service-recovery coverage;
- Command Centre operational certification;
- a limited live pilot with an approved immutable deployment and tested kill switch.
