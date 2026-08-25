# Hera AI Receptionist — Fresh Inbound Priority and Complaint Quality Proof

**Date:** 25 August 2026  
**Environment:** Protected Vercel Preview connected to `hera-ai-receptionist-staging`  
**Delivery mode:** Shadow  
**Production/main changed:** No

## Launch-blocking defect

A newly ingested WhatsApp message could create a durable job, but the webhook's one-slot background drain could claim an unrelated older retry from the global queue. The new message could remain pending long enough for a later client message to supersede it. The chronology guard prevented a stale reply, but the fresh client request was never processed.

## Permanent correction

The authoritative staging branch now:

1. Collects the exact job IDs returned by inbound ingestion.
2. Atomically claims those newly created jobs before unrelated backlog.
3. Uses remaining worker capacity for ordinary global queue recovery.
4. Rechecks inbound chronology before context load, after the primary/first verifier, after the final verifier, before changing conversation risk, before incidents, before handoff persistence and before outbound persistence.
5. Keeps duplicate delivery idempotent and keeps provider sending disabled in shadow mode.
6. Uses bounded structured-output fallback attempts rather than allowing malformed model output to strand fresh work.

## Controlled staging proof

A synthetic older retry and a fresh complaint were created in the isolated staging database. The worker was given only the fresh complaint job ID with a processing capacity of one.

### Priority result

- Fresh complaint job: **completed on its first hardened-runtime attempt**
- Unrelated older retry during that proof: **remained retry and was not allowed to take the fresh slot**
- Decision stages: **response, verification and policy**
- Primary model: `openai/gpt-5.6-sol`
- First verifier: `anthropic/claude-opus-5`
- Final verifier: `anthropic/claude-opus-5`

### Final client reply

> Thank you for explaining this. I’m sorry the layers from your curly haircut at Tanglin Mall yesterday have left you unhappy, especially as they look uneven and disconnected. I’ve placed your request with the Tanglin Mall salon manager, who will review the result and the service details with you. Please share a few clear photos of the layers when convenient, as this will help with the review. The manager will then advise the appropriate next step based on what they can assess.

### Final quality result

- Deterministic final-quality gate: **passed**
- Final verifier: **approved**
- Empathy: **2/2**
- Specificity: **2/2**
- Ownership: **2/2**
- Next step: **2/2**
- Factuality: **2/2**
- Safety: **2/2**
- Tone: **2/2**
- Client effort: **2/2**
- Final-verifier issues: **none**

### Handoff result

- Task type: `complaint_review`
- Scope: `full_takeover`
- Priority: `high`
- Assigned role: `salon_manager`
- Assigned outlet: `Tanglin Mall`
- Conversation mode after task creation: `management`

### Delivery result

- Client outbox state: `shadowed`
- Provider message ID: **none**
- WhatsApp provider send attempted: **no**
- Production touched: **no**

## Staging reconciliation completed

Before the proof, pre-hardening retry/dead-letter residue was reconciled under strict staging-only guards:

- one acknowledgement-only job under human handling was closed without a client reply;
- one acknowledgement-only retry was reprocessed successfully under the hardened structured-output runtime;
- the controlled Neo complaint incident was resolved after its named human-action task was already terminal;
- Neo's controlled test conversation was returned to AI through the audited Command Centre function;
- active/retry/dead job count after reconciliation and synthetic cleanup: **zero**.

Synthetic contacts and their cascaded proof records were deleted after the assertions. The durable engineering evidence is this checkpoint and the permanent automated regression suite.

## Release boundary

This proof closes the fresh-message starvation defect in protected staging. It does not by itself authorize a live WhatsApp launch. Production remains blocked until the wider shadow-quality, pricing-source, safety, service-recovery and operational-readiness gates are all explicitly passed.
