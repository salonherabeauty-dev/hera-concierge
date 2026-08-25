# Source-of-Truth Register

## Precedence

1. Immediate safety and legal constraints in the deterministic policy engine
2. The approved Hera Service Constitution with its version and effective date
3. Other explicit operator-approved policies with a version and effective date
4. Approved, current documents in `ai_knowledge_documents`
5. Hera Concierge approved knowledge base v4
6. Approved, current official-website snapshots
7. General model hairdressing knowledge, for explanation only

Draft, retired, expired and future-dated knowledge documents never affect a reply. General world knowledge may explain balayage, porosity or maintenance, but it cannot invent or determine a Hera price, policy, award, stylist, outlet, promotion, remedy, consent status or appointment outcome.

The machine-readable implementation is `governance/knowledge-source-registry.json`. Every retrieved source is classified, identity-checked, conflict-filtered and ranked only after its relevance to the current client question is established.

## Confirmed operational rules

- More than 10 minutes beyond the agreed appointment time: stated 10% service-recovery discount. The AI may explain it but cannot claim a bill was changed without transaction confirmation.
- Failed strand test: no bleach.
- Published prices are before 9% GST unless stated otherwise.
- Colour requires consultation, quotation and consent before starting.
- Hair services include complimentary wash, blow-dry and professional styling unless stated otherwise.
- Live availability must never be invented.

## Approved service concern and refinement policy

The previous seven-working-day versus seven-day conflict was resolved by Neo Chin Chuan, Owner, on 25 August 2026.

The approved rule is:

- a concern or refinement request should be raised within **seven calendar days from completion of the appointment**;
- an eligible client receives a careful management review;
- a complimentary refinement may be authorised only when the salon manager confirms that the concern relates to the original service and can be corrected safely;
- the policy does not automatically guarantee a refund, compensation, a completely different result or an entirely new service;
- the salon manager may authorise an eligible refinement within the policy;
- the managing director or owner must approve an outside-policy or exceptional case.

The AI may explain the process and create the salon-manager task, but it must not promise eligibility or a remedy before the authorised review.

The superseded phrase `7 working days` is prohibited from runtime knowledge retrieval even when it appears lexically relevant. The legacy embedded complaint section is excluded from the lower-precedence static source.

## Booking transaction authority

Timely remains the booking source of truth. The agent can read permitted Timely-derived booking records but has no certified write authority in this system.

The approved workflow is:

- the AI collects the complete request and creates a receptionist task;
- the receptionist checks or updates Timely;
- the receptionist records and confirms the verified outcome;
- the AI never claims that an appointment was created, changed, cancelled or confirmed until a certified write integration or verified human outcome exists.

Add any future action only as a scoped tool with:

- explicit eligibility rules;
- idempotency key;
- before-and-after audit;
- confirmed provider response;
- financial ceiling where applicable;
- rollback or reconciliation path.

The absence of a Timely write integration is an explicit **human-required** authority boundary. It is never permission for the model to improvise completion.

## Financial authority

- AI: no refund, compensation, voucher, discount or complimentary-service authority.
- Receptionist: no refund or compensation authority.
- Salon manager: policy-based complimentary refinement and the stated 10% waiting-time recovery.
- Managing director or owner: refunds, vouchers, compensation and outside-policy exceptions.

The AI may route the case and collect the necessary facts, but it must not predict or promise the decision.

## Photo and video consent

Separate explicit consent is required for capture and for external publication or use. Consent proof must be stored in an approved system. Withdrawal blocks future use and creates a privacy-officer review when material has already been published.

The AI must not claim that consent exists, has been withdrawn or has been actioned without a verified record.

## Controlled price discrepancy

The approved knowledge records that the main service pricelist and the individual keratin/NanoSmooth page may show different references or promotions. The AI may explain that discrepancy and arrange confirmation, but it must not decide which reference applies to a client without an approved current source or authorised confirmation.

This is registered as `nanosmooth_price_references` with automatic resolution prohibited.

## Knowledge-change rule

Official website changes are checksummed and versioned. A changed page returns to draft unless `AUTO_APPROVE_HERA_WEBSITE_KNOWLEDGE` is deliberately enabled after the knowledge-governance evaluation. This prevents an accidental web edit from silently changing client policy.

Dynamic retrieval is restricted by the database function to records that are:

- `approved`;
- effective now; and
- not expired.

The Stage 2 knowledge gate additionally rejects invalid or untrusted source hosts, superseded claims, incomplete source identities and unknown source classes.

## Action authority governance

`governance/action-authority-registry.json` is the machine-readable authority contract for every operational action.

The exact final post-policy client reply is checked after the primary model, first verifier, deterministic policy, handoff composition and final hospitality verifier. A client reply is eligible only when:

```text
Final deterministic quality: PASS
Final independent verifier:  APPROVED
Final action authority:       PASS
```

The action-authority gate blocks unverified claims that Hera has:

- created, confirmed, rescheduled or cancelled an appointment;
- confirmed a live slot;
- approved or processed a refund, voucher, compensation or discount;
- guaranteed a complimentary refinement;
- recorded or withdrawn consent;
- completed privacy deletion;
- admitted liability; or
- diagnosed a medical condition or chemical damage.

A statement that a manager, receptionist or privacy officer is handling a matter also requires a complete durable handoff contract. Database persistence must succeed before any client acknowledgement can be queued.

## Release authority

`src/governance/preProduction.ts` binds the runtime send configuration to the certification state. Even the correct live confirmation value cannot start live mode while the machine-readable certification register states that live Production is not approved or shadow mode is required.

## Service Constitution governance

`governance/hera-service-constitution.json` and `docs/HERA_SERVICE_CONSTITUTION.md` contain the owner-approved constitution:

```text
Version:           hera-service-constitution-2026-08-25.1
Effective date:    25 August 2026
Approver:          Neo Chin Chuan, Owner
Runtime authority: Approved
Live use:          Still blocked by the remaining certification gates
```

The exact constitution version is stored as an approved knowledge document and tested against the source-precedence, authority and hospitality contracts.

`governance/pre-production-gates.json` is the machine-readable release register. Stage 2 may pass while `liveProductionApproved` remains false, because Stages 3 through 7 still require independent evidence. Shadow mode remains mandatory until every required gate passes.
