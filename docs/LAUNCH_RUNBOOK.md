# Launch Runbook

## Gate 0 — protect existing systems

- Keep WHATSAPP_SEND_MODE=shadow.
- Do not register or migrate Hera's main phone number.
- Do not modify the Virtual Stylist or pre-consultation deployment.
- Use a Meta test number or a separate staging number.
- Keep all tokens in Vercel server-side environment settings.

## Gate 1 — database

Status: completed in the isolated Singapore project `hera-ai-receptionist-staging` (`zjnbheohgwfzkmbnjqjr`) at the connector-confirmed cost of US$0/month.

- Applied both receptionist migrations without touching production.
- Forced RLS on all nine `ai_` tables and revoked `anon` and `authenticated` access.
- Restricted all eight `ai_` RPC functions to `service_role`.
- Verified webhook idempotency, job claiming, appointment lookup and approved-knowledge retrieval in a rolled-back synthetic transaction.
- Added all six foreign-key indexes identified by the performance advisor.
- Security advisor findings are informational deny-all RLS notices; remaining performance notices are expected unused-index notices on a new empty database.

Never connect a preview to Hera's production Supabase credentials. Never apply these migrations to production before the remaining launch gates pass.

## Gate 2 — Meta staging

1. In Hera's Meta Business Portfolio, create or select a business app and add WhatsApp.
2. Use Meta's test phone number first.
3. Create a least-privilege system-user token for the required WhatsApp assets.
4. Set the callback to the Vercel preview URL ending in /api/whatsapp/webhook.
5. Set a long random verify token and subscribe to message events.
6. Confirm GET verification and a valid signed POST.
7. Send text, image, voice-note, document, interactive-response and status fixtures.

Before touching the current phone-app number, confirm in Meta's own onboarding UI whether Business App Coexistence is available for Hera's account and country. If it is unavailable, moving the number to Cloud API may stop use of the phone app. Schedule any cutover; never experiment on the live number.

WATI is not part of this architecture.

## Gate 3 — Vercel preview

Configure all variables in .env.example for Preview only. Use Vercel OIDC for AI Gateway where available. Confirm:

- webhook has a 300-second background budget while returning to Meta immediately;
- CRON_SECRET protects both internal endpoints;
- the five-minute recovery cron claims abandoned jobs;
- the daily website sync leaves changed pages in draft;
- logs contain no tokens, image bytes or raw prompts.

## Gate 4 — shadow evaluation

Run at least:

- 200 representative historical questions with identifiers removed;
- 500 adversarial and edge cases;
- 100 complaint, refund, legal, privacy and medical-safety cases;
- 50 multilingual and voice-note cases;
- 24 hours of duplicate, retry and concurrency soak testing.

No candidate reply is sent to a client in this gate. Review ai_decisions, ai_incidents, ai_outbox and ai_audit_log.

## Gate 5 — limited live pilot

1. Resolve every item in docs/SOURCE_OF_TRUTH.md.
2. Keep a dedicated staging number live for internal testers.
3. Change WHATSAPP_SEND_MODE to live only for the approved deployment.
4. Start with routine queries; monitor every result.
5. Test the emergency kill switch by returning to shadow and redeploying.
6. Verify Meta delivery/read/failure receipts and outbox recovery.

## Gate 6 — main-number transition

- Export and preserve necessary chat/business records according to Hera's privacy policy.
- Verify number ownership, display name, templates and quality rating.
- Confirm Coexistence or document the phone-app cutover impact.
- Schedule a low-volume window and prepare the tested rollback.
- Move traffic only after signed approval of the evaluation report.

## Rollback

1. Set WHATSAPP_SEND_MODE=shadow and redeploy the last known-good commit.
2. Keep webhook ingestion active so no client message is lost.
3. Drain or inspect pending jobs; do not delete them.
4. Revert Meta routing only through the documented number migration path.
5. Preserve audit records and record the incident.
