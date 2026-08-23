# Hera AI Receptionist Architecture

## Request topology

Meta WhatsApp Cloud API sends a signed webhook to the durable Supabase inbox. A Hera reasoning agent retrieves evidence, an independent Claude verifier, deterministic grounding gate and risk policy inspect the candidate, and an ordered outbox returns the approved reply through Meta.

## Component responsibilities

| Component | Responsibility | Failure behaviour |
|---|---|---|
| Signed webhook | Verify Meta HMAC, parse all supported message types, ingest atomically, acknowledge quickly | Invalid signatures fail closed; duplicate Meta IDs create no second job |
| Inbox and jobs | Preserve ordering, retry work and recover abandoned locks | Exponential retry, five-attempt dead letter and client-safe fallback |
| Media interpreter | Download authenticated Meta media, transcribe voice notes and pass photos/PDFs to vision-capable models | Size limits, URL allowlist and explicit unsupported-media response |
| Reasoning agent | Search approved sources, read the current client's appointments and draft a structured reply | Gateway provider/model fallback and no write-capable booking or payment tool |
| Independent verifier | Check the candidate against the retrieved evidence and non-negotiable rules | Unsafe replies are corrected before policy evaluation |
| Grounding gate | Canonicalize source metadata and require tool evidence for Hera operations, prices, bookings and current-client records | Unsupported answers become reviewed, localized “unable to verify” responses with capped confidence |
| Policy engine | Apply deterministic risk escalation, preserve active conversation risk and block unauthorised actions | Black-risk reply is deterministic and does not depend on a model; later harmless wording cannot silently downgrade the case |
| Outbox | Separate decision completion from delivery and suppress duplicate sends | Shadow by default; fail closed outside the customer-service window; retry only transient Meta failures; process destinations in order |
| Knowledge sync | Fetch only official Hera HTTPS sitemap pages and version changes | New or changed pages default to draft and cannot affect answers |

## Data sources

| Source | Access | Permitted use |
|---|---|---|
| Concierge knowledge v4 | Imported read-only from api/concierge.js | Hera prices, services, locations, stylists and published policies |
| Operator policy v1 | Versioned static source | 10-minute wait recovery, strand-test rule, GST and quotation requirements |
| Official website | Allowlisted daily ingestion | Draft by default; approved snapshots become retrievable |
| Timely-derived bookings | Read-only Supabase RPC matched to current WhatsApp number | Confirm existing appointment facts; never invent availability |
| Virtual Stylist | Official public link and inbound photo interpretation | Inspiration only; no diagnosis, feasibility guarantee or exact-result promise |
| Model world knowledge | General explanation only | Never overrides a Hera source and never supplies a missing Hera-specific fact |

## Model routing

The default response model is openai/gpt-5.6-sol. Gateway fallbacks are anthropic/claude-opus-5 and openai/gpt-5.6-terra. The verifier defaults to anthropic/claude-opus-5 with GPT fallback. Model IDs are configurable because availability changes.

Each request is tagged for Hera WhatsApp observability and uses a one-way hash of the database contact UUID for cost attribution. The WhatsApp phone identifier is never used as the AI Gateway tracking identifier.

Both reasoning passes run at high reasoning effort. The response model must declare whether each answer relies on an approved Hera source, the current client record, a client-provided fact, a deterministic calculation, general hairdressing knowledge, safety policy or no factual claim. The independent verifier treats only the captured tool evidence—not model-written citations or rationale—as authoritative.

For multi-intent messages, the highest-consequence part governs the decision. A routine
question never cancels a complaint, medical, privacy, legal or messaging opt-out request.
Conversation risk is sticky for the active case: new text may add risk but does not lower
the recorded level merely because the client's next sentence is neutral. Deterministic
containment is based on the current message so an already-addressed emergency warning is
not needlessly repeated on every follow-up.

## Delivery semantics

Database operations are exactly-once for a provider message ID and idempotent for reply creation. Meta delivery is at-least-once across the unavoidable boundary between Meta accepting a send and the database recording its response. The ordered outbox and lock timeout make duplication rare, auditable and recoverable; no API can honestly promise mathematical exactly-once delivery without provider idempotency support.

Every ordinary client reply is tied to its source inbound message. Live delivery checks
that provider timestamp immediately before contacting Meta and allows at most 23 hours
55 minutes, leaving a five-minute safety margin inside Meta's 24-hour customer-service
window. Missing, malformed, future or expired timestamps fail closed. Internal
management alerts are not sent as ordinary WhatsApp text; they remain review-only until
a separately approved template or non-WhatsApp incident channel exists.
