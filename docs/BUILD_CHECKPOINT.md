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
- The 360dialog Coexistence, chronology and shadow-quality work has **not** been merged
  into `main`.
- Production environment variables, Virtual Stylist and pre-consultation systems remain
  untouched by this phase.

## Authoritative development line

- Branch: `feat/hera-ai-receptionist-foundation`
- Gate 4 quality merge immediately before this checkpoint:
  `c40329cd4a6a0e38375c3ccaa7be936f3c9d57a7`
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
- Coexistence history and app-state events excluded from client-message processing
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

### Shadow quality evidence

- Forced-RLS `ai_shadow_reviews` table
- Service-role-only review, review-queue and aggregate-snapshot RPCs
- Fail-closed nine-dimension `hera-shadow-quality-v1` rubric
- Private bearer-protected `/api/internal/shadow-quality` endpoint returning aggregate
  evidence only
- Real, synthetic, operational and historical case classes
- Synthetic/operational and automated reviews cannot inflate human launch metrics
- Six initial automated forensic reviews recorded outside launch metrics

## Latest verified engineering gates

- Strict TypeScript checking: pass
- Complete automated suite: 92/92 pass
- Credential scan: pass across 82 tracked files
- Production dependency audit: 0 vulnerabilities
- Combined Vercel Preview: READY
- Staging migrations: applied and validated
- Active staging jobs: 0
- Active staging outbox: 0
- Dead staging jobs/outbox: 0
- Open staging incidents: 0
- Provider send records: 0

## Non-negotiable safety state

- `WHATSAPP_SEND_MODE=shadow`
- `WHATSAPP_LIVE_CONFIRMATION` absent
- No AI-generated WhatsApp message has been sent
- 360dialog **Send via API** remains unused
- No Production deployment or main-number autonomous reply activation

## Gate 4 evidence position

Current aggregate evidence has six eligible shadow candidates and six automated baseline
reviews. There are zero named human reviews and therefore zero launch-metric cases. This
is intentional: model review is not misrepresented as human approval.

The initial baseline exposed and preserved:

- one context-appropriate real pass candidate;
- one standalone-sticker case requiring operational review;
- one critical delayed-message context failure, now fixed by the chronology safeguards;
- synthetic and operational cases excluded from launch metrics.

## Required next actions

1. Run an authenticated runtime smoke test of `/api/internal/shadow-quality` using the
   branch Preview's Vercel automation-bypass secret and `CRON_SECRET`.
2. Begin named human review of anonymised real candidates; only explicit human reviews
   may enter launch metrics.
3. Decide and regression-test the standalone-sticker policy (silent handling versus a
   context-sensitive reply).
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
- Do not remove failed or superseded quality evidence.
- Do not expose review-queue client content through a public endpoint.
