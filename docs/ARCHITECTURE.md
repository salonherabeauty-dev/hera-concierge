# Hera AI Receptionist Architecture

## Request topology

Meta WhatsApp Cloud API sends a signed webhook to the durable Supabase inbox. A Hera reasoning agent retrieves evidence, an independent Claude verifier and deterministic policy engine inspect the candidate, and an ordered outbox returns the approved reply through Meta.

## Component responsibilities

| Component | Responsibility | Failure behaviour |
|---|---|---|
| Signed webhook | Verify Meta HMAC, parse all supported message types, ingest atomically, acknowledge quickly | Invalid signatures fail closed; duplicate Meta IDs create no second job |
| Inbox and jobs | Preserve ordering, retry work and recover abandoned locks | Exponential retry, five-attempt dead letter and client-safe fallback |
| Media interpreter | Download authenticated Meta media, transcribe voice notes and pass photos/PDFs to vision-capable models | Size limits, URL allowlist and explicit unsupported-media response |
| Reasoning agent | Search approved sources, read the current client's appointments and draft a structured reply | Gateway provider/model fallback and no write-capable booking or payment tool |
| Independent verifier | Check the candidate against the retrieved evidence and non-negotiable rules | Unsafe replies are corrected before policy evaluation |
| Policy engine | Apply deterministic risk escalation and block unauthorised actions | Black-risk reply is deterministic and does not depend on a model |
| Outbox | Separate decision completion from delivery and suppress duplicate sends | Shadow by default; retry failed Meta calls; process destinations in order |
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

Each request is tagged for Hera WhatsApp observability and uses a one-way hash of the WhatsApp ID for cost attribution rather than sending the phone number as the tracking identifier.

## Delivery semantics

Database operations are exactly-once for a provider message ID and idempotent for reply creation. Meta delivery is at-least-once across the unavoidable boundary between Meta accepting a send and the database recording its response. The ordered outbox and lock timeout make duplication rare, auditable and recoverable; no API can honestly promise mathematical exactly-once delivery without provider idempotency support.
