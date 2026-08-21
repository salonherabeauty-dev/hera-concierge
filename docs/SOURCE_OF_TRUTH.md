# Source-of-Truth Register

## Precedence

1. Immediate safety and legal constraints in the deterministic policy engine
2. Explicit operator-approved policies with a version and effective date
3. Approved documents in ai_knowledge_documents
4. Hera Concierge approved knowledge base v4
5. Approved official-website snapshots
6. General model hairdressing knowledge, for explanation only

Draft website documents never affect an answer. General world knowledge may explain balayage, porosity or maintenance, but it cannot invent a Hera price, policy, award, stylist, outlet, promotion or appointment.

## Confirmed operational rules

- More than 10 minutes beyond the agreed appointment time: stated 10% service-recovery discount. The AI may explain it but cannot claim a bill was changed without transaction confirmation.
- Failed strand test: no bleach.
- Published prices are before 9% GST unless stated otherwise.
- Colour requires consultation, quotation and consent before starting.
- Hair services include complimentary wash, blow-dry and professional styling unless stated otherwise.
- Live availability must never be invented.

## Conflict requiring Neo's decision before live launch

The current approved Concierge knowledge says service concerns should be raised within 7 working days. Earlier operator context describes a 7-day complimentary refinement/concern window. These are not equivalent.

Production launch requires one signed policy:

- calendar days or working days;
- whether the window starts at appointment completion;
- services covered and exclusions;
- whether it guarantees only review or also complimentary adjustment;
- who may authorise exceptions.

Until resolved, the existing approved knowledge remains retrievable, while deterministic complaint containment avoids promising a remedy.

## Missing transaction authority

The agent can read existing Timely-derived booking records but Timely has no available write API in this system. It therefore cannot truthfully confirm a new slot, reschedule, cancellation, refund, discount posting or compensation payment.

Add each action only as a scoped tool with:

- explicit eligibility rules;
- idempotency key;
- before/after audit;
- confirmed provider response;
- financial ceiling where applicable;
- rollback or reconciliation path.

## Knowledge-change rule

Official website changes are checksummed and versioned. A changed page returns to draft unless AUTO_APPROVE_HERA_WEBSITE_KNOWLEDGE is deliberately enabled after the knowledge-governance evaluation. This prevents an accidental web edit from silently changing client policy.
