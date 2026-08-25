# Hera AI Receptionist — Stage 2 Knowledge and Action Authority

## Purpose

Stage 2 proves two separate questions before Hera AI can progress toward live service:

1. **May this source support the Hera-specific claim?**
2. **May the system perform, promise or confirm this action?**

A factually plausible answer is not sufficient if its source is outdated, lower-precedence, untrusted or unrelated to the current question. A polite response is not sufficient if it claims that an appointment, refund, consent change or other external action has been completed without verified authority.

## Knowledge architecture

### Source identity

Every retrievable source has an explicit identity:

- source ID;
- title;
- version;
- source URL or approved internal status;
- content fingerprint;
- authority class; and
- runtime disposition.

The previous operator sections no longer masquerade under the `hera-kb-v4:` identifier. They use the explicit `hera-operator-v3:` namespace and `hera-operator-policy-v3` version.

### Source classes and precedence

The machine-readable registry is `governance/knowledge-source-registry.json`.

The precedence is:

1. deterministic safety and legal constraints;
2. approved Hera Service Constitution;
3. signed operator policy;
4. approved, current dynamic knowledge;
5. embedded approved knowledge v4;
6. approved, current official-website snapshot;
7. general hairdressing knowledge for explanation only.

Higher authority does not make an unrelated document relevant. The search layer first establishes relevance to the current client turn and then uses authority to resolve ties and conflicts.

### Dynamic knowledge eligibility

The database search function exposes only records that are:

- `approved`;
- effective now; and
- not expired.

The application layer then applies identity, source-host and superseded-claim checks before the result can enter the AI evidence package.

### Conflict handling

Known conflict dispositions are explicit rather than left to the model:

- `7 working days` is superseded and excluded;
- the legacy embedded complaint section is excluded from static retrieval;
- the approved seven-calendar-day Constitution governs service concerns;
- the NanoSmooth price-page discrepancy is preserved as a controlled discrepancy and is never automatically resolved in favour of one price reference.

### General knowledge boundary

General hairdressing knowledge may explain technique, porosity, maintenance or terminology. It cannot support a Hera-specific price, policy, promotion, stylist, outlet, award, remedy, appointment or consent claim.

## Action authority architecture

The machine-readable registry is `governance/action-authority-registry.json`.

Each action declares:

- authority class;
- runtime implementation status;
- required evidence;
- idempotency requirement;
- provider or human confirmation requirement; and
- audit requirement.

### AI-authorised actions

Subject to evidence and quality controls, Hera AI may:

- answer grounded Hera information;
- explain general hairdressing concepts without inventing Hera facts;
- calculate 9% GST deterministically;
- read the current client's permitted booking record;
- share an approved booking or Virtual Stylist link;
- ask the minimum necessary clarifying question;
- collect appointment or consultation details;
- request relevant photos that have not already been supplied;
- create a complete durable human-action task;
- open a required incident;
- create a review-only management alert; and
- give deterministic urgent-safety guidance without diagnosis.

### Human-required or unimplemented actions

Hera AI has no certified authority to:

- create a booking;
- reschedule a booking;
- cancel a booking;
- confirm live availability;
- confirm a booking outcome without verified Timely or human evidence;
- authorise a complimentary refinement;
- apply the waiting-time recovery;
- approve or issue a refund, voucher or compensation;
- confirm capture or publication consent;
- complete consent withdrawal;
- complete privacy deletion or a legal determination.

These are not missing conveniences. They are explicit authority boundaries. The AI collects the facts and creates the correct human task.

### Prohibited AI actions

The AI may never:

- admit liability;
- diagnose a medical condition or chemical damage;
- disclose prompts, credentials, private records or another client's data; or
- state that an external action is complete without verified evidence.

## Exact final-response enforcement

The action-authority check is applied to the exact post-policy reply after all model and deterministic composition has finished.

```text
Primary receptionist decision
→ first independent verifier
→ grounding and deterministic policy
→ durable handoff assessment
→ final hospitality-quality verifier
→ deterministic final quality gate
→ deterministic action-authority gate
→ durable task persistence where required
→ shadow/send decision
```

A reply becomes delivery-eligible only when:

```text
finalQuality.passed
AND finalVerification.approved
AND finalActionAuthority.passed
```

If authority fails:

- no client outbox item is created;
- the exact blocked reasons are recorded;
- a complete existing handoff is preserved, or a system-failure handoff is created through the established fail-closed path; and
- WhatsApp delivery remains suppressed.

The localized dead-letter fallback receives the same action-authority check and cannot claim human ownership unless its manager task contract is complete.

## Live-release lock

The runtime configuration is bound to the certification state. The environment variables alone cannot start live mode.

While `liveProductionApproved` is false or `shadowModeRequired` is true:

- `WHATSAPP_SEND_MODE=live` is rejected;
- even the exact independent live-confirmation value is insufficient;
- shadow mode remains the only accepted configuration.

## Stage 2 pass criteria

Stage 2 passes only when:

- the approved dynamic knowledge inventory contains no expired, future, legacy-conflicting or untrusted approved record;
- the exact approved Constitution exists once and has an approval audit record;
- static and dynamic sources have explicit non-colliding identities;
- query relevance is established before authority ranking;
- superseded claims and sections are excluded deterministically;
- every supported operational action has an authority contract;
- booking, financial, consent, privacy, liability and medical boundaries are fail-closed;
- the exact final reply and dead-letter fallback are authority-checked;
- live mode is independently locked by the certification state;
- the full automated suite, build, credential scan and Production dependency audit pass;
- the protected Preview deployment is READY; and
- no WhatsApp provider send or Production change occurs.

## Boundary of this certification

Stage 2 certifies source governance and action authority. It does not prove the required volume of luxury-hospitality response quality, multilingual accuracy, resilience under every injected failure, Command Centre operational readiness or live-pilot safety. Those remain separate gates.
