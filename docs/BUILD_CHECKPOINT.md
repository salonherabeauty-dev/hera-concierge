# Hera AI Receptionist — Authoritative Build Checkpoint

**Checkpoint date:** 25 August 2026, Singapore  
**Environment:** isolated Vercel Preview + isolated Singapore Supabase staging  
**Customer delivery mode:** shadow only

This file is the concise continuity record for the Hera AI receptionist project. GitHub,
Vercel, Supabase and 360dialog remain the technical sources of truth; a ChatGPT thread
is not the source of truth.

## Protected production baseline

- Production branch: `main`
- Last approved Production foundation commit: `20484d73f92b46732a0d7a8469bc9537b2ec584d`
- The 360dialog Coexistence, chronology, historical-backfill, incident-persistence,
  shadow-quality, Command Centre and automatic-handoff work has **not** been merged into
  `main`.
- Production environment variables, Virtual Stylist and pre-consultation systems remain
  untouched by this phase.

## Authoritative development line

- Branch: `feat/hera-ai-receptionist-foundation`
- Automatic human-handoff merge: `86b019e81bff0d64097302a688aaff090be99956`
- Current cleaned Preview commit after the controlled recovery and removal of temporary
  diagnostics: `e8498b02f4f1fbf405b769e685afd0fc436e5fed`
- Current stable Preview alias:
  `hera-concierge-git-feat-hera-ai-rece-3023b8-hera-concierge-team.vercel.app`

## Completed and verified

### Hardened receptionist foundation

- Durable Supabase inbox, ordered jobs and durable outbox
- Idempotent inbound and outbound records
- GPT-5.6 Sol response model with independent Claude Opus 5 verification
- Deterministic grounding, complaint, privacy, legal, medical-safety and action controls
- Read-only current-client appointment lookup
- Approved Hera knowledge retrieval and website knowledge workflow
- Media support, retries, dead letters, audit records and private readiness reporting

### 360dialog Coexistence

- Dedicated authenticated `/api/whatsapp/360dialog` webhook
- Vercel automation bypass plus independent Basic Authorization
- 360dialog Direct API text and media transport
- Coexistence history and app-state events excluded from the ordinary client parser
- WhatsApp Business App staff echoes recorded as human outbound messages
- Two-hour human takeover, client-message suppression during takeover and automatic
  handback to AI
- Just-before-send human-takeover authorization guard
- Real inbound, staff takeover, takeover suppression and handback tests passed

### Message chronology

- Provider timestamps govern conversation chronology rather than webhook arrival time
- Delayed older inbound messages are suppressed before an AI job is inserted
- Pending/recovered jobs are re-checked at claim time
- Stale client candidates are re-checked immediately before any provider send
- Suppressed messages remain preserved with audit evidence
- The live delayed `2 mins` case is classified as superseded; the later
  `Coming up in the lift.` message is not superseded

### Historical Coexistence backfill

- Messages arriving more than 60 minutes after their provider timestamps are preserved
  as operational evidence but are not treated as live enquiries
- Backfill jobs are suppressed at insert and recovery/claim time
- A final backfill check runs immediately before any future provider send
- The one-hour rule uses recorded arrival delay rather than current message age, so a
  genuinely live message does not become historical merely because processing takes time
- Previously generated backfill candidates and automated reviews remain preserved and
  are classified as operational, outside launch metrics
- Pre-guard active and dead backfill jobs were safely reconciled to completed suppression

### Incident persistence and risk reconciliation

- Incident idempotency now uses an inferable database UNIQUE constraint matching
  `(source_message_id, category)`
- Duplicate incident upserts were validated to produce one durable incident record
- The original partial-index failure and dead job remain preserved in audit evidence
- Backfill-only incidents can close with an explicit reconciliation resolution
- Backfill-only elevated conversation risk is recalculated without weakening genuine
  non-backfill policy or incident risk
- The one historical dead job was reconciled and two backfill-only amber conversations
  returned to green

### Shadow quality evidence

- Forced-RLS `ai_shadow_reviews` table
- Service-role-only review, review-queue and aggregate-snapshot RPCs
- Fail-closed nine-dimension `hera-shadow-quality-v1` rubric
- Private bearer-protected `/api/internal/shadow-quality` endpoint returning aggregate
  evidence only
- Real, synthetic, operational and historical case classes
- Synthetic/operational and automated reviews cannot inflate human launch metrics
- Initial automated forensic reviews remain recorded outside launch metrics

### Command Centre foundation

- Forced-RLS staff, handoff-task, handoff-event, internal-note and SLA-policy tables are
  installed in the isolated staging project
- Service-role-only database access and server-side staff capability checks
- Durable assignment, acceptance, optimistic locking, status transitions and audit history
- Private no-password Preview access remains read-only and protected by Vercel project
  access; it is not a Production authentication design
- Temporary diagnostic endpoints, workflows, files and one-time recovery scripts were
  removed after validation

### Deterministic automatic human handoff

- Server-enforced H0-H4 handoff assessment does not rely on model judgement alone
- Complete booking readiness requires service, outlet, date and time; stylist preference
  and flexibility are retained when supplied
- The system asks only for genuinely missing booking details
- Exactly one durable task is created for webhook retries or repeated processing
- Client acknowledgement is queued only after durable task persistence succeeds
- The AI cannot claim that an appointment was booked or confirmed
- Booking checks are task-only, allowing unrelated low-risk assistance while reception
  checks Timely
- Complaints, refunds, privacy/legal matters, explicit human requests and qualifying
  safety cases can force full takeover
- Highest-consequence routing prevents safety, privacy, refund or complaint cases from
  being downgraded by arrival wording or a generic manager request
- Accepted ownership and terminal task states survive retries

### Controlled real WhatsApp booking-handoff proof

A fresh controlled message requested Irene at Tanglin Mall for a root colour touch-up and
toner on Friday 28 August around 2 pm, with a 1 pm–4 pm flexibility range.

Verified result:

- inbound webhook accepted exactly once
- AI response, independent verification and deterministic policy decisions preserved
- one `booking_action` handoff task
- scope: `task_only`
- priority: `normal`
- status: `assigned`
- assigned role: `receptionist`
- assigned outlet: `Tanglin Mall`
- missing facts: `0`
- SLA due time present
- one client acknowledgement candidate recorded as `shadowed`
- provider message ID absent
- sent timestamp absent
- WhatsApp provider sends: `0`
- conversation remained in `ai` mode because the booking handoff is task-scoped
- original retry job completed with its prior attempt count preserved

## Latest verified engineering gates

- Strict TypeScript checking: pass
- Automatic-handoff final automated suite: 149/149 pass
- Command Centre build: pass
- Credential scan: pass
- Production dependency audit: 0 high/critical Production vulnerabilities
- Current cleaned Vercel Preview: READY
- Command Centre foundation and automatic-handoff staging migrations: installed and
  verified
- Controlled booking handoff: pass
- Controlled handoff provider sends: 0

## Non-negotiable safety state

- `WHATSAPP_SEND_MODE=shadow`
- `WHATSAPP_LIVE_CONFIRMATION` absent
- No AI-generated WhatsApp message has been sent
- 360dialog **Send via API** remains unused
- No Production deployment or main-number autonomous reply activation

## Gate 4 evidence position

The authenticated private quality endpoint passed with HTTP 200, `mode=shadow`,
`rubricVersion=hera-shadow-quality-v1`, zero provider sends and zero duplicate candidates.
The preserved candidate set was then forensically separated into:

- operational Coexistence backfill candidates;
- synthetic test candidates;
- genuinely real-time real-client candidates.

Automated assessment is not misrepresented as named-human approval. Launch metrics remain
restricted to explicit human review.

## Required next actions

1. Verify the controlled `booking_action` card is visible under **Needs Human Action** in
   the Command Centre with the correct structured details.
2. Run the real staff-engagement proof: a Hera staff member replies through the WhatsApp
   Business App, 360dialog records the human echo and the AI remains silent.
3. Resolve the booking task explicitly and prove controlled return to AI without reopening
   or duplicating the task.
4. Extend the same real shadow proof to complaints, refunds, safety, privacy/legal,
   same-day arrival and explicit-human-request cases.
5. Continue named human quality review and build the representative Gate 4 corpus:
   200 historical, 500 adversarial/edge, 100 high-risk, 50 multilingual/voice and a
   24-hour retry/concurrency soak.
6. Resolve every source-of-truth conflict and obtain a clean launch report before any
   limited live pilot.
7. Before Production launch, resolve the existing `main` cron configuration error for
   `CRON_SECRET`; do not change Production during shadow evaluation merely to silence it.

## Explicitly prohibited next steps

- Do not set `WHATSAPP_SEND_MODE=live`.
- Do not create `WHATSAPP_LIVE_CONFIRMATION`.
- Do not merge the feature line into `main`.
- Do not regenerate the 360dialog Number API Key.
- Do not remove failed, backfilled or superseded quality evidence.
- Do not expose review-queue client content through a public endpoint.
