# Hera AI Receptionist — Authoritative Build Checkpoint

**Checkpoint date:** 24 August 2026, Singapore  
**Environment:** isolated Vercel Preview + isolated Singapore Supabase staging  
**Customer delivery mode:** shadow only

This file is the concise continuity record for the Hera AI receptionist project. GitHub,
Vercel, Supabase and 360dialog remain the technical sources of truth; a ChatGPT thread
is not the source of truth.

## Protected production baseline

- Production branch: `main`
- Last approved Production foundation commit: `20484d73f92b46732a0d7a8469bc9537b2ec584d`
- The 360dialog Coexistence, chronology, historical-backfill and shadow-quality work has
  **not** been merged into `main`.
- Production environment variables, Virtual Stylist and pre-consultation systems remain
  untouched by this phase.

## Authoritative development line

- Branch: `feat/hera-ai-receptionist-foundation`
- Historical-backfill safety merge immediately before this checkpoint:
  `e32697904a44366b8d13fe56002594065facf2ba`
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
- Three pre-existing active backfill jobs were safely completed as suppressed

### Shadow quality evidence

- Forced-RLS `ai_shadow_reviews` table
- Service-role-only review, review-queue and aggregate-snapshot RPCs
- Fail-closed nine-dimension `hera-shadow-quality-v1` rubric
- Private bearer-protected `/api/internal/shadow-quality` endpoint returning aggregate
  evidence only
- Real, synthetic, operational and historical case classes
- Synthetic/operational and automated reviews cannot inflate human launch metrics
- Initial automated forensic reviews remain recorded outside launch metrics

## Latest verified engineering gates

- Strict TypeScript checking: pass
- Complete automated suite: 97/97 pass
- Credential scan: pass across 85 tracked files
- Production dependency audit: 0 vulnerabilities
- Authoritative Vercel Preview: READY
- Staging migrations: applied and validated
- Recent-versus-backfill validation: passed in a rolled-back transaction
- Active staging jobs: 0
- Active staging outbox: 0
- Provider send records: 0

## Non-negotiable safety state

- `WHATSAPP_SEND_MODE=shadow`
- `WHATSAPP_LIVE_CONFIRMATION` absent
- No AI-generated WhatsApp message has been sent
- 360dialog **Send via API** remains unused
- No Production deployment or main-number autonomous reply activation

## Gate 4 evidence position

The authenticated private quality endpoint passed with HTTP 200, `mode=shadow`,
`rubricVersion=hera-shadow-quality-v1`, zero provider sends and zero duplicate candidates.
The evidence set subsequently reached 18 preserved candidates:

- 15 operational Coexistence backfill candidates;
- 2 synthetic test candidates;
- 1 genuinely real-time real-client candidate.

There are still zero named human reviews and therefore zero launch-metric cases. This is
intentional: automated assessment is not misrepresented as human approval.

## Required next actions

1. Begin named human review with the one genuinely real-time candidate; only an explicit
   Hera human decision may enter launch metrics.
2. Continue collecting new real-time shadow candidates while the backfill guard remains
   active.
3. Decide and regression-test the standalone-sticker policy, using the preserved sticker
   case as operational evidence rather than a real-client launch case.
4. Build the representative Gate 4 corpus: 200 historical, 500 adversarial/edge,
   100 high-risk, 50 multilingual/voice and a 24-hour retry/concurrency soak.
5. Resolve every source-of-truth conflict and obtain a clean launch report before any
   limited live pilot.
6. Before Production launch, resolve the existing `main` cron configuration error for
   `CRON_SECRET`; do not change Production during shadow evaluation merely to silence it.

## Explicitly prohibited next steps

- Do not set `WHATSAPP_SEND_MODE=live`.
- Do not create `WHATSAPP_LIVE_CONFIRMATION`.
- Do not merge the feature line into `main`.
- Do not regenerate the 360dialog Number API Key.
- Do not remove failed, backfilled or superseded quality evidence.
- Do not expose review-queue client content through a public endpoint.
