# Hera AI Receptionist

Production-grade WhatsApp customer-service foundation for Hera Hair Beauty. It connects directly to Meta WhatsApp Cloud API; WATI is not required.

## Current status

The implementation is complete as an isolated, shadow-first foundation. It is not connected to Hera's live WhatsApp number and does not modify the existing Virtual Stylist or pre-consultation automation.

- Direct Meta webhook verification using the exact raw body and X-Hub-Signature-256
- Atomic inbound deduplication, per-client ordering, retries, dead-letter handling and an idempotent outbound queue
- GPT-5.6 Sol primary reasoning through Vercel AI Gateway, Claude Opus 5 independent verification, and model/provider fallback
- Read-only access to the current client's Gmail-derived Timely appointment records
- Retrieval from the existing approved Concierge knowledge base, versioned Supabase documents and official Hera website snapshots
- Deterministic grounding gate that canonicalizes citations and blocks unsourced Hera prices, hours, stylist, booking and appointment claims
- Hair-photo vision, PDF input and WhatsApp voice-note transcription
- Deterministic English, Chinese, Malay and Tamil complaint, medical-safety, legal, privacy, booking and financial-action controls
- Shadow mode that records proposed replies without making any Meta send request
- Thirty-two automated tests plus PostgreSQL 17 syntax validation

The isolated database gate, Preview-only credentials, signed Meta test webhook and Vercel AI Gateway funding are complete. The remaining work is controlled validation: deploy this hardened build, pass the full shadow evaluation, resolve the documented policy conflict and complete the limited-live pilot before any main-number transition.

## Request flow

1. Meta calls api/whatsapp/webhook.
2. The function verifies Meta's HMAC signature over the raw bytes.
3. Supabase atomically stores the contact, conversation and message and creates one durable job.
4. The worker transcribes or downloads media when needed and retrieves approved Hera knowledge and matching appointment records.
5. The primary agent produces a structured answer with evidence.
6. An independent verifier reviews the answer using only retrieved evidence as authoritative.
7. A deterministic grounding gate canonicalizes citations and replaces any unsupported Hera-specific answer with a reviewed safe response; the risk policy then overrides unsafe actions.
8. The reply enters the durable outbox. Shadow mode records it; live mode sends it through Meta.
9. Delivery receipts, model usage, evidence, grounding decisions, incidents and audit events remain traceable.

## Autonomy boundaries

Routine questions and ordinary service concerns are designed for automatic handling. Red or black cases receive an immediate safe containment response, create an incident and can notify management; they do not wait for a person before acknowledging the client.

The system never claims an appointment was booked, changed or cancelled without a confirmed write integration. It never promises a refund, compensation or diagnosis. Those are transaction and authority boundaries, not intelligence limitations.

## Local verification

Run npm install and then npm test. The test command performs strict TypeScript checking and runs all unit and schema tests. The repository requires Node.js 22 or newer.

## Required server-side configuration

Copy .env.example and configure values only in Vercel's encrypted environment settings. Never paste access tokens into chat, source control or client-side code.

Required groups:

- Supabase URL and service-role key
- Meta app secret, webhook verify token, Graph API version, access token, phone-number ID and WABA ID
- Vercel AI Gateway authentication through Vercel OIDC or AI_GATEWAY_API_KEY
- CRON_SECRET
- WHATSAPP_SEND_MODE=shadow until launch approval

## Database

The database migrations are:

- supabase/migrations/20260821000000_create_hera_ai_receptionist.sql
- supabase/migrations/20260821000001_add_ai_foreign_key_indexes.sql

They have been applied and verified in the isolated Singapore staging project `hera-ai-receptionist-staging`. Production remains unchanged.

All new objects use the ai_ prefix. Tables have RLS forced, anon and authenticated privileges revoked, and service-role-only SECURITY DEFINER functions with an empty search path.

Do not apply the migrations to production before the remaining launch gates pass. Supabase development branching is unavailable on Hera's current plan.

## Documentation

- docs/ARCHITECTURE.md — components, data sources and failure recovery
- docs/LAUNCH_RUNBOOK.md — exact staged rollout and kill-switch procedure
- docs/SOURCE_OF_TRUTH.md — knowledge hierarchy and unresolved policy conflicts
- docs/EVALUATION_PLAN.md — required quality and safety gates

## Preserved existing systems

- Website Concierge endpoint remains backward compatible.
- Virtual Stylist code and public page remain untouched; WhatsApp can consume client photos and link to the official experience without calling its private image endpoint.
- The separate pre-consultation automation remains unchanged.
