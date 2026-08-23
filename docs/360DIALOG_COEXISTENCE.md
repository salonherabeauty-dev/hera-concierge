# 360dialog Direct API and WhatsApp Coexistence

## Status

This integration is a Preview-only implementation candidate. It does not activate the
real Hera number, configure the 360dialog webhook, enable live delivery or change
Production. `WHATSAPP_SEND_MODE=shadow` and an empty `WHATSAPP_LIVE_CONFIRMATION`
remain mandatory until the complete launch gates pass.

## Provider boundary

`WHATSAPP_PROVIDER` selects exactly one runtime transport:

- `meta` preserves the existing Meta Cloud API webhook and sender.
- `360dialog` enables the dedicated authenticated 360dialog webhook and Direct API
  transport.

The default is `meta`; merely storing a 360dialog Number API Key cannot change the
active provider. The disabled provider webhook returns `404`, preventing dual ingress
and duplicate processing.

## Outbound Direct API

`D360WhatsAppClient` implements the existing `WhatsAppTransport` contract. Text sends
use the official `/messages` endpoint with the `D360-API-KEY` header. Media metadata is
retrieved with the Number API Key; the returned lookaside path and query are then
requested through the approved 360dialog API host, also with the Number API Key.

The key remains server-side and is never returned, logged, stored in a prompt or placed
in client code.

## Inbound webhook authentication

The callback is `/api/whatsapp/360dialog`. It accepts `POST` only and requires the exact
Basic Authorization credentials configured in:

- `D360_WEBHOOK_USERNAME`
- `D360_WEBHOOK_PASSWORD`

Credential comparison is constant-time. Invalid authorization, oversized bodies,
invalid JSON and database failures fail closed with non-2xx responses so the provider
can retry. Logs contain counts and correlation identifiers, never raw message text,
media or credentials.

## Coexistence human takeover

When a Hera employee replies through the WhatsApp Business App, 360dialog sends an
`smb_message_echoes` event. The system treats this as an outbound human message, not a
new client message:

1. Store the manual message in the durable conversation history with
   `ai_generated=false`.
2. Put the conversation into `management` mode for the configured takeover window.
3. Complete pending AI jobs for that conversation.
4. Shadow pending or processing client outbox items.
5. Suppress new AI jobs while the takeover remains active.
6. Re-check the database immediately before every live 360dialog send.
7. Return to AI mode automatically when the takeover window has expired and a later
   inbound message arrives or a later send is authorised.

`history` and `smb_app_state_sync` events are acknowledged and audited by count only;
they cannot create AI reply jobs.

The default takeover window is 120 minutes. It can be changed only through
`D360_HUMAN_TAKEOVER_MINUTES` within the enforced range of 5 to 1440 minutes.

## Residual provider-boundary race

No external messaging provider offers a transaction that atomically locks Hera's
Supabase conversation and accepts a WhatsApp send. The implementation therefore uses
three controls: shadow mode, immediate cancellation when a human echo arrives and a
just-before-send database authorisation check. This makes a human/AI collision rare and
auditable, but it would be misleading to claim mathematical exactly-once behaviour
across the provider boundary.

## Required Preview configuration

- `WHATSAPP_PROVIDER=360dialog`
- `D360_API_KEY=<Number API Key>`
- `D360_API_BASE_URL=https://waba-v2.360dialog.io`
- `D360_WEBHOOK_USERNAME=hera-receptionist`
- `D360_WEBHOOK_PASSWORD=<new random value of at least 24 characters>`
- `D360_HUMAN_TAKEOVER_MINUTES=120`
- `WHATSAPP_SEND_MODE=shadow`
- `WHATSAPP_LIVE_CONFIRMATION=`

The webhook must remain unset in 360dialog until the exact Preview deployment has
passed type checking, the complete automated suite, PostgreSQL migration validation,
credential scanning, authenticated webhook fixtures and shadow-mode runtime checks.

## Handoff checks

Before providing a callback URL:

- apply the Coexistence migration only to the isolated staging database;
- verify valid Basic Authorization succeeds and invalid credentials fail;
- verify text, status and media payload parsing;
- prove duplicate inbound events create no duplicate reply;
- prove `smb_message_echoes` cannot enter the AI inbound queue;
- prove a human takeover shadows an already queued AI reply;
- prove shadow mode makes zero 360dialog send calls;
- verify the private readiness endpoint is non-critical;
- retain the exact commit and immutable Vercel Preview URL.
