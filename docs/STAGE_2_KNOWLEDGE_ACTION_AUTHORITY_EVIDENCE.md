# Hera AI Receptionist — Stage 2 Knowledge and Action Authority Evidence

**Evidence date:** 25 August 2026  
**Environment:** protected Vercel Preview  
**Authoritative target branch:** `feat/hera-ai-receptionist-foundation`  
**Staging database:** `hera-ai-receptionist-staging` (`zjnbheohgwfzkmbnjqjr`)  
**Constitution:** `hera-service-constitution-2026-08-25.1`  
**WhatsApp provider:** 360dialog Coexistence  
**Delivery mode:** shadow  
**Production/main changed:** no

## Knowledge authority catalogue

Stage 2 adds `governance/knowledge-authority-catalog.json` and deterministic runtime ordering in `src/governance/knowledgeAuthority.ts`.

The certified precedence is:

1. deterministic safety and legal constraints;
2. the approved Hera Service Constitution;
3. another signed effective operator policy;
4. approved current non-expired dynamic knowledge;
5. Hera approved knowledge base v4;
6. an approved official-website snapshot;
7. general hairdressing knowledge for explanation only.

The runtime blocks the superseded seven-working-day concern wording and gives the approved Constitution and operator policy priority over lower sources. Draft, retired and expired dynamic records are not runtime eligible.

## Canonical claims

Nine high-consequence claims are registered under the approved Constitution:

- seven calendar days from appointment completion for a service concern;
- conditional complimentary refinement after salon-manager review;
- Timely as booking source of truth;
- verified live record required for availability;
- 10% waiting-time recovery after more than ten minutes beyond the agreed time;
- published prices before 9% GST unless explicitly stated otherwise;
- no bleach after a failed strand test;
- no AI or receptionist refund or compensation authority;
- separate explicit capture and external-use consent.

## Action authority catalogue

Stage 2 defines 25 explicit action contracts across:

- service information and deterministic GST calculation;
- booking record access, availability, creation, rescheduling, cancellation and confirmation;
- complaints, refinements and outside-policy exceptions;
- waiting-time recovery;
- refunds, vouchers and compensation;
- urgent safety, medical diagnosis and technical review;
- liability, privacy access and deletion;
- capture consent, publication consent and withdrawal;
- WhatsApp provider sending.

Authority is one of:

- `read_only`;
- `ai_authorised_no_external_side_effect`;
- `human_required`;
- `prohibited`.

An unknown external action is prohibited. Any future external mutation must have eligibility, idempotency, provider confirmation, before-and-after audit and reconciliation.

## Certified booking boundary

Timely write integration is not treated as a missing authority decision. It is deliberately certified as **human-required** until a separately scoped write tool passes its own transaction and resilience certification.

Hera AI may collect the request and create the correct receptionist task. It cannot state that availability was checked or that an appointment was created, changed, cancelled or confirmed until a verified Timely result or authorised human outcome exists.

## Database inventory and conflict audit

The isolated staging audit was fail-closed. It required:

- at least one approved knowledge document;
- exactly one approved runtime-authoritative Service Constitution;
- no expired approved document;
- no approved document with an empty key, title, body, version, checksum or invalid metadata;
- no approved document containing the superseded seven-working-day rule or an automatic refund, redo or compensation promise;
- HTTPS for every non-null approved source URL.

The audit activated the approved knowledge-and-action authority catalogue and recorded a metadata-only inventory snapshot without copying document bodies into the audit log.

The staging authority registry contains:

```text
Approved action contracts: 25
Canonical claims:            9
Expired approved documents:  0 required
Approved legacy conflicts:    0 required
External mutation contracts
without full controls:        0 required
WhatsApp provider sends:      0
Production touched:           no
```

The service-role-only health function is `ai_stage2_authority_health()`. Browser roles cannot read or mutate the authority registries.

## Runtime integration

`src/knowledge/search.ts` now appends the compact action-authority contract to receptionist evidence and orders merged static/dynamic results through deterministic authority ranking rather than model relevance alone.

The existing final-response, chronology, human-takeover and grounding gates remain in force. The action catalogue does not create a shortcut around those controls.

## Engineering controls

The release candidate must pass:

- strict TypeScript validation;
- the exact Vercel deployment build;
- generated Command Centre asset verification;
- the complete automated suite;
- credential scanning;
- Production dependency audit;
- a READY protected Preview deployment.

`tests/stage2KnowledgeAuthority.test.ts`, `tests/stage2AuthorityMigration.test.ts` and `tests/stage2KnowledgeConflictScan.test.ts` fail closed on precedence, source conflict, action coverage, booking authority, financial authority, privacy consent, provider-send lock and database least privilege.

## Stage 2 decision boundary

Stage 2 can pass when the pull-request checks, protected Preview deployment and merged-branch verification succeed. This certification does not enable live WhatsApp sending. Stages 3 through 7 remain independently required.

## Merged authoritative staging proof

```text
Authoritative verification commit: 096ead46283e4825838e198e1fbe49fd374d89b8
GitHub deployment ID:             6088872082
Protected Preview URL:            https://hera-concierge-o12qh241r-hera-concierge-team.vercel.app
Deployment state:                 success
Full merged-branch verification:  passed
WhatsApp provider sends:          0
Production touched:               no
```

The authoritative branch remained shadow-only and live Production remained locked.
