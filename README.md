# Hera AI Receptionist

Production-grade WhatsApp customer-service foundation for Hera Hair Beauty. It supports
the direct Meta WhatsApp Cloud API and a separately authenticated 360dialog Direct API
transport for Coexistence. WATI is not required.

## Current status

The core implementation is complete as an isolated, shadow-first foundation. The
360dialog Coexistence adapter in this branch is an implementation candidate pending the
complete test, migration and Preview handoff gates. It does not configure the live
360dialog webhook, enable autonomous replies or modify the existing Virtual Stylist or
pre-consultation automation.

- Provider selection that defaults to Meta and must be explicitly changed to 360dialog
- Direct Meta webhook verification using the exact raw body and X-Hub-Signature-256
- Dedicated 360dialog webhook protected by constant-time Basic Authorization
- 360dialog Direct API text and media transport using the Number API Key
- Coexistence `smb_message_echoes` isolation and time-limited human takeover control
- Just-before-send database guard preventing an AI reply while staff are handling a chat
- Atomic inbound deduplication, per-client ordering, retries, dead-letter handling and an idempotent outbound queue
- OpenAI-only text intelligence: GPT-5.6 Sol with `max` reasoning for response generation, independent verification and final luxury client-copy control
- Vercel AI Gateway restricted to the OpenAI provider for all text-response stages, with no cross-provider fallback
- Read-only access to the current client's Gmail-derived Timely appointment records
- Retrieval from the existing approved Concierge knowledge base, versioned Supabase documents and official Hera website snapshots
- Deterministic grounding gate that canonicalizes citations and blocks unsourced Hera prices, hours, stylist, booking and appointment claims
- Hair-photo vision, PDF input and WhatsApp voice-note transcription
- Deterministic English, Chinese, Malay and Tamil complaint, medical-safety, legal, privacy, booking and financial-action controls
- A strict final client-copy pass that treats 9/10 as the minimum for language and hospitality quality and 10/10 as mandatory for factuality, safety and Tanglin-channel consistency
- Shadow mode that records proposed replies without making any provider send request
- Automated tests plus PostgreSQL 17 syntax validation
- Two-key live-send interlock, permanent-vs-transient retry classification and privacy-safe structured operational events
- Fail-closed customer-service-window enforcement with a five-minute delivery safety margin; internal alerts cannot masquerade as client replies
- Bearer-protected aggregate readiness reporting with fail-closed queue, dead-letter and critical-incident thresholds

The isolated database gate, Preview-only credentials, signed Meta test webhook and
Vercel AI Gateway funding are complete. The remaining work is controlled validation:
verify this 360dialog branch, apply its migration only to staging, deploy the exact
Preview, pass the full shadow evaluation, resolve documented policy conflicts and
complete the limited human-approved pilot before any main-number transition.

## Request flow

1. The selected provider calls its dedicated webhook.
2. The function verifies Meta HMAC or the 360dialog webhook credential.
3. Supabase atomically stores the contact, conversation and message and creates one durable job unless a Coexistence human takeover is active.
4. The worker transcribes or downloads media when needed and retrieves approved Hera knowledge and matching appointment records.
5. OpenAI GPT-5.6 Sol with max reasoning produces a structured answer with evidence.
6. A separate OpenAI GPT-5.6 Sol max verification pass challenges the answer using only retrieved evidence as authoritative.
7. A deterministic grounding and authority gate blocks unsupported Hera facts or actions.
8. A final OpenAI GPT-5.6 Sol max client-copy controller rewrites and rechecks the exact post-policy message for natural language, cohesion, empathy, ownership, client effort, factuality, safety and Tanglin Mall channel consistency.
9. The reply enters the durable outbox. Shadow mode records it; client delivery still requires deliberate human review and approval in the Reception Desk.
10. Delivery receipts, model usage, evidence, grounding decisions, incidents and audit events remain traceable.

When a Hera employee replies through the WhatsApp Business App, the Coexistence echo is
stored as a human outbound message, pending AI work is suppressed and the conversation
enters management mode for the configured takeover period. The echo can never be
misclassified as a new client message.

## Autonomy boundaries

The AI prepares drafts automatically in the background. It does not autonomously send
client messages in the human-approved Reception Desk workflow. A named authorised Hera
staff member must review the exact text, may edit it, and must deliberately press Send.

The system never claims an appointment was booked, changed or cancelled without a
confirmed write integration. It never promises a refund, compensation or diagnosis.
Those are transaction and authority boundaries, not intelligence limitations.

This WhatsApp channel is owned by Tanglin Mall. Tanglin Mall is therefore established
context for every inbound conversation; the AI must not ask which outlet, offer Sentosa
as an alternative channel owner or route the response to Sentosa.

## Local verification

Run `npm ci` and then `npm test`. The test command performs strict TypeScript checking
and runs all unit and schema tests. Run `npm run credential:scan` before every push. The
repository requires Node.js 24.

## Required server-side configuration

Copy `.env.example` and configure values only in Vercel's encrypted environment
settings. Never paste access tokens into chat, source control or client-side code.

Required groups:

- Supabase URL and service-role key
- `WHATSAPP_PROVIDER=meta` or `WHATSAPP_PROVIDER=360dialog`
- Meta app/webhook credentials when Meta is selected
- 360dialog Number API Key and dedicated webhook credentials when 360dialog is selected
- Vercel AI Gateway authentication through Vercel OIDC or `AI_GATEWAY_API_KEY`
- OpenAI GPT-5.6 Sol text stages are code-locked to `max` reasoning; no text-provider environment selector is accepted
- `CRON_SECRET`
- `WHATSAPP_SEND_MODE=shadow` until launch approval
- `WHATSAPP_LIVE_CONFIRMATION` left empty until the separately approved live deployment

## Database

The database migrations begin with:

- `supabase/migrations/20260821000000_create_hera_ai_receptionist.sql`
- `supabase/migrations/20260821000001_add_ai_foreign_key_indexes.sql`
- `supabase/migrations/20260824000000_add_360dialog_coexistence.sql`

The first two were applied and verified in the isolated Singapore staging project
`hera-ai-receptionist-staging`. Later staging migrations must pass CI and a rolled-back
validation before they are applied. Production remains unchanged.

All new objects use the `ai_` prefix. Tables have RLS forced, anon and authenticated
privileges revoked, and service-role-only SECURITY DEFINER functions with an empty
search path.

Do not apply migrations to production before the remaining launch gates pass.
Supabase development branching is unavailable on Hera's current plan.

## Documentation

- `docs/ARCHITECTURE.md` — components, data sources and failure recovery
- `docs/360DIALOG_COEXISTENCE.md` — provider boundary, webhook security and human takeover
- `docs/LAUNCH_RUNBOOK.md` — exact staged rollout and kill-switch procedure
- `docs/SOURCE_OF_TRUTH.md` — knowledge hierarchy and unresolved policy conflicts
- `docs/EVALUATION_PLAN.md` — required quality and safety gates
- `docs/PRODUCTION_READINESS.md` — measurable operational SLOs, private readiness checks and required launch evidence

## Preserved existing systems

- Website Concierge endpoint remains backward compatible.
- Virtual Stylist code and public page remain untouched; WhatsApp can consume client photos and link to the official experience without calling its private image endpoint.
- The separate pre-consultation automation remains unchanged.
- Production defaults to the existing Meta provider unless an approved deployment explicitly selects 360dialog.
