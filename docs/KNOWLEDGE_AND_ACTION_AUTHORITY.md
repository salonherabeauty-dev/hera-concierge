# Hera AI Receptionist — Knowledge and Action Authority Standard

**Version:** `hera-knowledge-action-authority-2026-08-25.1`  
**Constitution:** `hera-service-constitution-2026-08-25.1`  
**Environment:** protected staging Preview  
**Live Production:** prohibited

## Purpose

This standard ensures that every Hera-specific statement has an approved source and every operational action has an explicit authority boundary. It prevents a capable model from inventing a salon fact, mistaking a client request for a completed transaction, or taking an external action merely because the wording sounds plausible.

## Knowledge authority

Runtime knowledge follows this order:

1. deterministic safety and legal constraints;
2. the approved Hera Service Constitution;
3. another signed operator policy with an effective date;
4. an approved, current and non-expired dynamic knowledge record;
5. Hera approved knowledge base v4;
6. an approved official-website snapshot;
7. general hairdressing knowledge for explanation only.

A lower source cannot override a higher source. Draft, retired, expired, source-less or unknown Hera-specific material is blocked. A changed official website page returns to draft until reviewed rather than silently changing client policy.

The superseded seven-working-day concern wording is not eligible for runtime use. The current policy is seven calendar days from appointment completion.

## Action authority classes

### Read-only

The system may retrieve permitted information but cannot change the external system. Example: reading the current client’s authorised booking record.

### AI-authorised without an external side effect

The system may answer grounded service information, calculate 9% GST deterministically and provide immediate safety containment. These actions still require factual, safety, policy and final-response quality controls.

### Human-required

A named authorised role must complete or verify the action. The AI may collect information, create the correct durable task and explain the next step. It cannot claim completion until a verified provider result or authorised human outcome exists.

### Prohibited

The AI cannot diagnose a medical condition, admit legal liability, use another client’s private record or send a WhatsApp provider reply while shadow mode or a mandatory release gate remains open.

## Booking authority

Timely remains the source of truth. Availability, new appointments, rescheduling, cancellation and confirmation are human-required until a separately certified write tool exists.

A future Timely write tool cannot be enabled merely by adding credentials. It must have:

- a precise eligibility rule;
- an idempotency key;
- provider confirmation;
- before-and-after audit;
- duplicate protection;
- a reconciliation path;
- tested failure and rollback behaviour.

## Financial authority

Hera AI and reception have no refund or compensation authority. A salon manager may authorise the approved conditional refinement and waiting-time recovery. Refunds, vouchers, compensation and outside-policy exceptions require managing-director or owner approval and verified transaction evidence.

## Complaint and technical authority

A complaint is owned by the salon manager under full takeover. The AI may acknowledge the concern and explain review, but cannot admit liability, assign blame or promise a remedy.

A technical damage or fault conclusion requires a qualified technical lead or salon-manager review of the service record and evidence. AI inference is not a technical finding.

## Medical and urgent safety authority

The AI may provide deterministic urgent-care containment and create emergency human ownership. It cannot diagnose, prescribe or delay urgent medical attention.

## Privacy and media consent authority

Privacy access and deletion require identity verification and privacy-officer action. Separate explicit records are required for capture consent and publication consent. Withdrawal blocks future use after verified action and triggers review of already-published material.

## Unknown-action rule

An action absent from the approved catalogue is prohibited. An external mutation is also prohibited unless its contract requires eligibility, idempotency, provider confirmation, before-and-after audit and reconciliation.

## Certification evidence

Stage 2 must prove:

- one complete inventory of approved dynamic knowledge;
- no expired approved record;
- no approved legacy conflict;
- source and version traceability for Hera claims;
- deterministic precedence in runtime retrieval;
- a contract for every supported action;
- correct task ownership and authority for booking, finance, complaint, safety, privacy and consent actions;
- a healthy staging authority report;
- zero WhatsApp provider sends;
- no modification to `main` or Production.
