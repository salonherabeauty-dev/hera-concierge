begin;

-- Supabase/PostgREST upsert inference requires a real UNIQUE constraint for
-- ON CONFLICT (source_message_id, category). The original partial unique index
-- could not be inferred and caused incident-opening jobs to retry and dead-letter.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.ai_incidents'::regclass
      and conname = 'ai_incidents_message_category_unique'
      and contype = 'u'
  ) then
    drop index if exists public.ai_incidents_message_category_unique;
    alter table public.ai_incidents
      add constraint ai_incidents_message_category_unique
      unique (source_message_id, category);
  end if;
end;
$$;

-- Close any operational incident that originated only from a preserved
-- historical Coexistence backfill message. The record remains available as
-- evidence and its resolution explains why it no longer represents a live case.
with close_candidates as materialized (
  select
    incident.id,
    incident.conversation_id,
    incident.source_message_id,
    incident.status as previous_status
  from public.ai_incidents as incident
  join public.ai_messages as message
    on message.id = incident.source_message_id
  where incident.status in ('open', 'monitoring')
    and public.ai_is_inbound_historical_backfill(message.id)
  for update of incident
),
closed as (
  update public.ai_incidents as incident
  set status = 'closed',
      resolution = coalesce(incident.resolution, '{}'::jsonb) || jsonb_build_object(
        'closureReason', 'historical_backfill_not_live_enquiry',
        'closedBy', 'hera_receptionist_backfill_reconciliation',
        'closedAt', now()
      ),
      updated_at = now()
  from close_candidates
  where incident.id = close_candidates.id
  returning
    incident.id,
    incident.conversation_id,
    incident.source_message_id,
    close_candidates.previous_status
),
incident_audit as (
  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  )
  select
    'system',
    'hera_receptionist',
    'historical_backfill_incident_closed',
    'incident',
    closed.id::text,
    jsonb_build_object(
      'conversationId', closed.conversation_id,
      'sourceMessageId', closed.source_message_id,
      'previousStatus', closed.previous_status,
      'reason', 'historical_backfill_not_live_enquiry'
    )
  from closed
  returning id
)
select count(*) from incident_audit;

-- Reconcile any backfill job that reached pending, retry, processing or dead
-- before the new insert/claim guard was installed. No message or decision is
-- deleted; the job becomes a completed suppression with its prior error audited.
with job_candidates as materialized (
  select
    job.id,
    job.source_message_id,
    job.status as previous_status,
    job.last_error as previous_error
  from public.ai_jobs as job
  join public.ai_messages as message
    on message.id = job.source_message_id
  where job.status in ('pending', 'retry', 'processing', 'dead')
    and public.ai_is_inbound_historical_backfill(message.id)
  for update of job
),
reconciled_jobs as (
  update public.ai_jobs as job
  set status = 'completed',
      completed_at = coalesce(job.completed_at, now()),
      locked_at = null,
      locked_by = null,
      last_error = 'historical_backfill_not_live_enquiry',
      updated_at = now()
  from job_candidates
  where job.id = job_candidates.id
  returning
    job.id,
    job.source_message_id,
    job_candidates.previous_status,
    job_candidates.previous_error
),
job_audit as (
  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  )
  select
    'system',
    'hera_receptionist',
    'historical_backfill_job_reconciled',
    'job',
    reconciled_jobs.id::text,
    jsonb_build_object(
      'sourceMessageId', reconciled_jobs.source_message_id,
      'previousStatus', reconciled_jobs.previous_status,
      'previousError', reconciled_jobs.previous_error,
      'finalStatus', 'completed',
      'reason', 'historical_backfill_not_live_enquiry'
    )
  from reconciled_jobs
  returning id
)
select count(*) from job_audit;

-- Fail closed for any previously queued backfill candidate that had not yet
-- reached a terminal state. Existing shadowed/dead evidence is left untouched.
with outbox_candidates as materialized (
  select
    item.id,
    item.source_message_id,
    item.status as previous_status,
    item.last_error as previous_error
  from public.ai_outbox as item
  join public.ai_messages as message
    on message.id = item.source_message_id
  where item.target_type = 'client'
    and item.status in ('pending', 'retry', 'processing')
    and public.ai_is_inbound_historical_backfill(message.id)
  for update of item
),
reconciled_outbox as (
  update public.ai_outbox as item
  set status = 'shadowed',
      locked_at = null,
      locked_by = null,
      last_error = 'blocked_historical_backfill',
      updated_at = now()
  from outbox_candidates
  where item.id = outbox_candidates.id
  returning
    item.id,
    item.source_message_id,
    outbox_candidates.previous_status,
    outbox_candidates.previous_error
),
outbox_audit as (
  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  )
  select
    'system',
    'hera_receptionist',
    'historical_backfill_outbox_reconciled',
    'outbox',
    reconciled_outbox.id::text,
    jsonb_build_object(
      'sourceMessageId', reconciled_outbox.source_message_id,
      'previousStatus', reconciled_outbox.previous_status,
      'previousError', reconciled_outbox.previous_error,
      'finalStatus', 'shadowed',
      'reason', 'historical_backfill_not_live_enquiry'
    )
  from reconciled_outbox
  returning id
)
select count(*) from outbox_audit;

-- Recalculate risk only for conversations touched by historical backfill. The
-- resulting risk is the highest legitimate non-backfill policy decision or open
-- incident; otherwise it returns to green. This prevents onboarding history from
-- permanently contaminating a future live conversation while preserving genuine
-- complaint, safety and legal risk.
with affected as materialized (
  select distinct message.conversation_id
  from public.ai_messages as message
  where public.ai_is_inbound_historical_backfill(message.id)
),
legitimate_policy_risk as (
  select
    affected.conversation_id,
    coalesce(max(case decision.risk
      when 'green' then 0
      when 'amber' then 1
      when 'red' then 2
      when 'black' then 3
      else 0
    end), 0) as risk_score
  from affected
  left join public.ai_messages as message
    on message.conversation_id = affected.conversation_id
   and message.direction = 'inbound'
   and not public.ai_is_inbound_historical_backfill(message.id)
  left join public.ai_decisions as decision
    on decision.source_message_id = message.id
   and decision.stage = 'policy'
  group by affected.conversation_id
),
legitimate_incident_risk as (
  select
    affected.conversation_id,
    coalesce(max(case incident.severity
      when 'amber' then 1
      when 'red' then 2
      when 'black' then 3
      else 0
    end), 0) as risk_score
  from affected
  left join public.ai_incidents as incident
    on incident.conversation_id = affected.conversation_id
   and incident.status in ('open', 'monitoring')
   and (
     incident.source_message_id is null
     or not public.ai_is_inbound_historical_backfill(incident.source_message_id)
   )
  group by affected.conversation_id
),
desired_risk as (
  select
    affected.conversation_id,
    case greatest(policy.risk_score, incident.risk_score)
      when 3 then 'black'
      when 2 then 'red'
      when 1 then 'amber'
      else 'green'
    end as risk
  from affected
  join legitimate_policy_risk as policy
    on policy.conversation_id = affected.conversation_id
  join legitimate_incident_risk as incident
    on incident.conversation_id = affected.conversation_id
),
risk_candidates as materialized (
  select
    conversation.id,
    conversation.current_risk as previous_risk,
    desired_risk.risk as desired_risk
  from public.ai_conversations as conversation
  join desired_risk on desired_risk.conversation_id = conversation.id
  where conversation.current_risk is distinct from desired_risk.risk
  for update of conversation
),
updated_risk as (
  update public.ai_conversations as conversation
  set current_risk = risk_candidates.desired_risk,
      updated_at = now()
  from risk_candidates
  where conversation.id = risk_candidates.id
  returning
    conversation.id,
    risk_candidates.previous_risk,
    risk_candidates.desired_risk
),
risk_audit as (
  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  )
  select
    'system',
    'hera_receptionist',
    'historical_backfill_risk_reconciled',
    'conversation',
    updated_risk.id::text,
    jsonb_build_object(
      'previousRisk', updated_risk.previous_risk,
      'finalRisk', updated_risk.desired_risk,
      'reason', 'exclude_historical_backfill_from_live_risk_state'
    )
  from updated_risk
  returning id
)
select count(*) from risk_audit;

commit;
