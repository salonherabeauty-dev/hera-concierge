# Hera AI Command Centre — Secure Control-Plane Architecture

## Product promise

The Command Centre is the private operating system for Hera's AI receptionist. It hides backend complexity from salon staff while preserving human authority, traceability and safe failure behaviour.

The first Preview is deliberately non-sending. It can read conversations, organise durable human-action tasks, accept and lock tasks, record internal notes, place a conversation into human handling, return it to AI, display quality evidence and show system health. It cannot send a WhatsApp message or enable autonomous delivery.

## Non-negotiable boundaries

- Production and `main` remain untouched during Preview development.
- `WHATSAPP_SEND_MODE=shadow` remains mandatory.
- `WHATSAPP_LIVE_CONFIRMATION` remains absent.
- The browser never receives the Supabase secret/service-role key, 360dialog key, webhook password or CRON secret.
- Client phone numbers are reduced to the final four digits in list views.
- Raw provider payloads are not returned to the browser.
- Every state-changing request requires a validated staff session, same-origin request and CSRF token.
- Every operational mutation is enforced by a server-side database function and written to the durable audit trail.
- Handoff events are append-only to the application role.
- Concurrent task actions use optimistic version checks and row locks.
- A human takeover does not expire merely because a browser closes. The database remains the source of truth.

## Operator model

The interface presents four simple working queues:

1. **Needs Human Action** — staff must accept or perform a task.
2. **AI Handling** — the AI is safely managing the conversation.
3. **Waiting** — the next step depends on the client or internal confirmation.
4. **Completed** — durable evidence is retained and the task is closed.

Internally, a handoff records task type, scope, priority, assigned role, outlet, owner, collected facts, missing facts, requested action, client-visible status, due time, resolution and a monotonic version.

## Human-control levels

- `task_only`: a human performs a defined action while AI may answer unrelated safe questions.
- `full_takeover`: the conversation is placed into management mode and AI replies are suppressed.
- `emergency`: urgent containment and immediate human intervention are required.

## Roles

- Owner
- Managing Director
- Salon Manager
- Receptionist
- Technical Lead
- Finance & Administration
- Privacy & Legal
- Auditor

Role checks exist in both the API layer and the database functions. Browser UI visibility is never treated as authorization.

## Data model

### `ai_staff_profiles`
Links a confirmed Supabase Auth identity to a Hera role, outlet scope and account status.

### `ai_handoff_tasks`
The durable unit of human work. A unique dedupe key prevents duplicate tasks, while `version` prevents stale concurrent updates.

### `ai_handoff_events`
Append-only task history: created, assigned, accepted and transitioned states.

### `ai_command_centre_notes`
Internal notes that are never sent to the client.

### `ai_handoff_sla_policies`
Task-specific response targets and escalation roles.

## Authentication

A one-time, CRON-secret-protected bootstrap endpoint creates the first owner. Staff then sign in through Supabase Auth. Access and refresh tokens are stored only in Secure, SameSite=Strict, HttpOnly `__Host-` cookies. The SPA talks only to same-origin server APIs. The server validates every access token with Supabase Auth and refreshes the session when needed.

A readable `__Host-hera_cc_csrf` cookie is used only for the double-submit CSRF check; it contains no authentication credential.

## Fail-safe behaviour

- If session validation fails, the browser credentials are cleared.
- If a task changed elsewhere, the stale action receives a version-conflict response.
- If a database mutation fails, the UI cannot claim success.
- If the Command Centre is unavailable, the normal WhatsApp Business App and webhook ingestion remain independent.
- No GUI action in the first Preview can contact the WhatsApp provider.
- System health becomes `attention` or `critical` when queues, incidents or dead letters require intervention.

## Preview scope

The first Preview includes:

- secure login;
- overview and health metrics;
- human-action queue;
- task acceptance and resolution;
- conversation list and transcript;
- AI/human operating-mode controls;
- AI candidate visibility with explicit not-sent state;
- internal notes;
- shadow-quality metrics;
- recent audit events;
- responsive desktop, tablet and mobile layouts.

The following require separate release gates:

- automatic deterministic creation of handoff tasks from all takeover classes;
- assignment directory and staff administration;
- human reply sending from the Command Centre;
- Timely write integration;
- notifications and SLA escalation delivery;
- MFA/SSO, WAF rate limiting and production domain cutover;
- limited live AI pilot.

## Production gate

The Command Centre must pass role-boundary tests, migration/RLS checks, authentication tests, concurrent task tests, mobile usability review, accessibility review, security testing and a sustained shadow soak before it can become a Production control plane.
