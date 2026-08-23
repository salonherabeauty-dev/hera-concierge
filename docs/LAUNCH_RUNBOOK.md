# Launch Runbook

## Gate 0 — protect existing systems

- Keep WHATSAPP_SEND_MODE=shadow.
- Keep WHATSAPP_LIVE_CONFIRMATION empty.
- Do not modify the Virtual Stylist or pre-consultation deployment.
- Keep all tokens in Vercel server-side environment settings.
- Keep human WhatsApp Business App takeover and handback controls enabled throughout shadow testing.

## Gate 1 — database

Status: completed in the isolated Singapore project `hera-ai-receptionist-staging` (`zjnbheohgwfzkmbnjqjr`) at the connector-confirmed cost of US$0/month.

- Applied the receptionist foundation, foreign-key index and 360dialog Coexistence migrations without touching production.
- Forced RLS on all `ai_` tables and revoked `anon` and `authenticated` access.
- Restricted all `ai_` RPC functions to `service_role`.
- Verified webhook idempotency, job claiming, appointment lookup, approved-knowledge retrieval, human takeover and send-time Coexistence authorization in rolled-back synthetic transactions.
- Added all foreign-key indexes identified by the performance advisor.
- Security advisor findings are informational deny-all RLS notices; remaining performance notices are expected unused-index notices on a new staging database.

Never connect a preview to Hera's production Supabase credentials. Never apply these migrations to production before the remaining launch gates pass.

## Gate 2 — 360dialog Coexistence staging

Status: Hera's Coexistence number is connected to the protected Vercel Preview endpoint with two independent authentication layers. Real inbound, staff echo, takeover suppression, automatic handback, status and history-isolation tests have passed in shadow mode.

- Use the phone-number-level 360dialog webhook.
- Preserve the Vercel automation-bypass header and separate Basic Authorization header.
- Keep the Number API Key server-side only.
- Do not regenerate the Number API Key without replacing the Vercel secret and revalidating the webhook.
- Keep Coexistence history, app-state sync and staff echoes outside the ordinary client-message parser.
- Never use the 360dialog send test to bypass Hera's outbox and safety interlocks.

WATI is not part of this architecture.

## Gate 3 — Vercel preview

Status: Preview-only Supabase, 360dialog, cron and shadow-mode variables are configured. AI Gateway has prepaid credit with automatic reload disabled. The secure 360dialog adapter, strict AI tool schema, history isolation and Coexistence controls are deployed to the authoritative feature Preview.

Confirm after every deployment:

- webhook has a 300-second background budget while returning to 360dialog promptly;
- CRON_SECRET protects internal endpoints;
- the five-minute recovery drain can claim abandoned jobs;
- the daily website sync leaves changed pages in draft;
- logs contain no tokens, image bytes or raw prompts;
- GET /api/internal/readiness with the CRON_SECRET returns non-critical aggregate state without exposing client content or identifiers;
- GET /api/internal/shadow-quality with the CRON_SECRET returns aggregate review evidence only.

## Gate 4 — shadow evaluation

Status: the durable validation infrastructure is defined in
`docs/SHADOW_QUALITY_VALIDATION.md`. It must be applied only to the isolated staging
database after its migration, automated tests, credential scan and Preview build pass.

Run at least:

- 200 representative historical questions with identifiers removed;
- 500 adversarial and edge cases;
- 100 complaint, refund, legal, privacy and medical-safety cases;
- 50 multilingual and voice-note cases;
- 24 hours of duplicate, retry and concurrency soak testing.

No candidate reply is sent to a client in this gate. Review `ai_decisions`,
`ai_incidents`, `ai_outbox`, `ai_audit_log` and `ai_shadow_reviews`.

For every completed shadow candidate:

1. label the case as real, synthetic, operational or historical;
2. score all nine dimensions under `hera-shadow-quality-v1`;
3. record critical flags and an optional corrected reply;
4. keep synthetic and operational cases outside real-client launch metrics;
5. add a regression fixture for every systemic failure;
6. preserve failed evidence rather than deleting it;
7. require all factual, safety and policy dimensions to score 4 before a case can pass.

Use `ai_list_shadow_review_queue(limit)` only through a trusted service-role process.
The private `/api/internal/shadow-quality` endpoint may be retained with the exact
commit and deployment as aggregate launch evidence.

## Gate 5 — limited live pilot

1. Resolve every item in docs/SOURCE_OF_TRUTH.md.
2. Keep a dedicated staging number live for internal testers.
3. Set WHATSAPP_LIVE_CONFIRMATION=ENABLE_HERA_WHATSAPP_LIVE only for the approved deployment.
4. Change WHATSAPP_SEND_MODE to live only for that same approved deployment. Both controls are required; either one missing prevents startup.
5. Start with routine queries; monitor every result.
6. Test the emergency kill switch by returning WHATSAPP_SEND_MODE to shadow, clearing WHATSAPP_LIVE_CONFIRMATION and redeploying.
7. Verify provider delivery/read/failure receipts and outbox recovery. Permanent provider 4xx rejections must dead-letter immediately; only transient failures are retried.
8. Confirm a queued client reply older than 23 hours 55 minutes is blocked before any provider send request. Ordinary free-form messages must never cross WhatsApp's 24-hour customer-service window.
9. Keep management alerts review-only until Hera configures a separately approved WhatsApp template or a non-WhatsApp incident channel.
10. Require a `healthy` private readiness result and retain it with the exact commit and deployment URL before requesting pilot approval.

## Gate 6 — main-number transition

- Export and preserve necessary chat/business records according to Hera's privacy policy.
- Verify number ownership, display name, templates and quality rating.
- Confirm Coexistence and document the phone-app operating procedure.
- Schedule a low-volume window and prepare the tested rollback.
- Move traffic only after signed approval of the evaluation report.

## Rollback

1. Set WHATSAPP_SEND_MODE=shadow, clear WHATSAPP_LIVE_CONFIRMATION and redeploy the last known-good commit.
2. Keep webhook ingestion active so no client message is lost.
3. Drain or inspect pending jobs; do not delete them.
4. Revert provider routing only through the documented 360dialog configuration path.
5. Preserve audit and shadow-review records and record the incident.
