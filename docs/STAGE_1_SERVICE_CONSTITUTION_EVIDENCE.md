# Hera AI Receptionist — Stage 1 Service Constitution Evidence

**Evidence date:** 25 August 2026  
**Environment:** protected Vercel Preview  
**Authoritative branch:** `feat/hera-ai-receptionist-foundation`  
**Staging database:** `hera-ai-receptionist-staging` (`zjnbheohgwfzkmbnjqjr`)  
**WhatsApp provider:** 360dialog Coexistence  
**Delivery mode:** shadow  
**Production/main changed:** no

## Owner approval

Neo Chin Chuan, Owner, explicitly approved the recommended Hera Service Constitution package on 25 August 2026 at 9:38 pm Singapore time.

The approved decisions are:

1. a service concern or refinement request should be raised within **seven calendar days from completion of the appointment**;
2. an eligible client receives a careful management review and a complimentary refinement only when the salon manager confirms that the concern relates to the original service and can be corrected safely;
3. the salon manager may authorise an eligible refinement within policy, while an outside-policy or exceptional case requires the managing director or owner;
4. Timely remains the booking source of truth, Hera AI collects the complete request, and reception checks or updates Timely before confirming the verified outcome;
5. Hera AI and reception have no refund or compensation authority, the salon manager controls policy-based refinement and the stated waiting-time recovery, and the managing director or owner controls refunds, vouchers, compensation and exceptions;
6. separate explicit consent is required for capture and external publication or use of photos and video, with privacy review when consent is withdrawn after publication.

## Versioned constitution

```text
Version:             hera-service-constitution-2026-08-25.1
Effective date:      25 August 2026
Approver:            Neo Chin Chuan, Owner
Runtime authority:   approved
Live use:            blocked by remaining certification gates
Unresolved policies: 0
```

The approved owner-readable record is `docs/HERA_SERVICE_CONSTITUTION.md`. The machine-readable authority record is `governance/hera-service-constitution.json`. The superseded draft records were removed so they cannot remain as competing policy authorities.

## Runtime knowledge correction

The receptionist's operator policy was advanced to `hera-operator-policy-v3` and now contains the approved service concern, booking, financial and consent rules.

The earlier seven-working-day text was replaced in the Concierge knowledge source. The legacy complaint section is also excluded from the receptionist's lower-precedence static retrieval path, while the approved Constitution is ranked above other operator knowledge.

## Code and review evidence

**Pull request:** #24 — Approve and activate the Hera Service Constitution in staging  
**Merge commit:** `a82babd8120650c1e59428d643d346e715245da6`

The pull-request verification completed successfully, including:

- strict TypeScript validation;
- the exact Vercel deployment build;
- generated Command Centre asset verification;
- the complete automated suite;
- credential scanning;
- Production dependency audit.

The protected feature Preview for the reviewed change reached `READY` before merge.

## Staging knowledge activation proof

A one-time activation ran only on the authoritative protected Preview and required:

- exact branch `feat/hera-ai-receptionist-foundation`;
- Vercel Preview environment;
- staging project reference `zjnbheohgwfzkmbnjqjr`;
- `WHATSAPP_SEND_MODE=shadow`;
- live confirmation disabled;
- exact owner, version, effective date and unresolved-policy contract;
- zero approved dynamic knowledge record containing the superseded seven-working-day sentence.

**Activation commit:** `97abc10d296e2bc79414fb993389ab18523a6421`  
**Activation deployment:** `hera-concierge-qp5lnmeh4-hera-concierge-team.vercel.app`  
**Vercel deployment ID:** `dpl_J3tibc37TWj1nosxGgymEH4xTwNG`  
**Deployment state:** `READY`

Verified machine-readable result:

```text
Document key:                       hera-service-constitution-2026-08-25.1
Version:                            hera-service-constitution-2026-08-25.1
Status:                             approved
Checksum:                           a71e2cab56b9668542917bc1e2d495e27ae134129769ae2ebdefb3c642125555
Runtime authoritative:              true
Live use allowed:                   false
Approved legacy conflict remaining: 0
Approval audit record:              present
WhatsApp provider send attempted:   no
Production touched:                 no
```

The idempotent migration is retained at `supabase/migrations/20260825000000_approve_hera_service_constitution.sql` for reproducibility.

## Clean deployment restoration

The activation tool and temporary `postbuild` hook were removed immediately after the database proof.

**Clean runtime commit:** `8c36c6ae1bd7bca7c104786c9f22763f6a617de0`  
**Clean deployment:** `hera-concierge-hp1tgibnm-hera-concierge-team.vercel.app`  
**Vercel deployment ID:** `dpl_2khQRQvLYryCpU7vSMjmYNUjvcgX`  
**Deployment state:** `READY`  
**Merged-branch CI:** passed

The normal deterministic build was restored. No one-time activation code remains in the runtime tree.

## Stage 1 decision

**Stage 1 — Hera Service Constitution: PASSED.**

This approval is not a live-launch decision. WhatsApp remains shadow-only, `liveProductionApproved` remains false, and Stages 2 through 7 continue to require independent evidence.
