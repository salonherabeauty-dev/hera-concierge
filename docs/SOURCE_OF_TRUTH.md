# Source-of-Truth Register

## Precedence

1. Immediate safety and legal constraints in the deterministic policy engine
2. The approved Hera Service Constitution with its version and effective date
3. Other explicit operator-approved policies with a version and effective date
4. Approved documents in `ai_knowledge_documents`
5. Hera Concierge approved knowledge base v4
6. Approved official-website snapshots
7. General model hairdressing knowledge, for explanation only

Draft website documents never affect an answer. General world knowledge may explain balayage, porosity or maintenance, but it cannot invent a Hera price, policy, award, stylist, outlet, promotion or appointment.

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
- before/after audit;
- confirmed provider response;
- financial ceiling where applicable;
- rollback or reconciliation path.

## Financial authority

- AI: no refund, compensation, voucher, discount or complimentary-service authority.
- Receptionist: no refund or compensation authority.
- Salon manager: policy-based complimentary refinement and the stated 10% waiting-time recovery.
- Managing director or owner: refunds, vouchers, compensation and outside-policy exceptions.

The AI may route the case and collect the necessary facts, but it must not predict or promise the decision.

## Photo and video consent

Separate explicit consent is required for capture and for external publication or use. Consent proof must be stored in an approved system. Withdrawal blocks future use and creates a privacy-officer review when material has already been published.

The AI must not claim that consent exists, has been withdrawn or has been actioned without a verified record.

## Knowledge-change rule

Official website changes are checksummed and versioned. A changed page returns to draft unless `AUTO_APPROVE_HERA_WEBSITE_KNOWLEDGE` is deliberately enabled after the knowledge-governance evaluation. This prevents an accidental web edit from silently changing client policy.

## Service Constitution governance

`governance/hera-service-constitution.json` and `docs/HERA_SERVICE_CONSTITUTION.md` contain the owner-approved constitution:

```text
Version:           hera-service-constitution-2026-08-25.1
Effective date:    25 August 2026
Approver:          Neo Chin Chuan, Owner
Runtime authority: Approved
Live use:          Still blocked by the remaining certification gates
```

The exact constitution version must be stored as an approved knowledge document and tested against the source-precedence, authority and hospitality contracts.

`governance/pre-production-gates.json` is the machine-readable release register. Stage 1 may pass while `liveProductionApproved` remains false, because Stages 2 through 7 still require independent evidence. Shadow mode remains mandatory until all required gates pass.
