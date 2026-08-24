begin;

-- 360dialog Coexistence can replay old conversation records after onboarding.
-- Preserve those records for audit and context, but never treat a message that
-- arrived more than one hour after its provider timestamp as a new live enquiry.
create or replace function public.ai_is_inbound_historical_backfill(
  p_message_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      message.provider_timestamp is not null
      and message.provider_timestamp < message.created_at - interval '60 minutes'
    from public.ai_messages as message
    where message.id = p_message_id
      and message.direction = 'inbound'
  ), false);
$$;

create or replace function public.ai_inbound_processing_block_reason(
  p_message_id uuid
) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.ai_is_inbound_historical_backfill(p_message_id)
      then 'historical_backfill'
    when public.ai_is_inbound_superseded(p_message_id)
      then 'newer_inbound'
    else null
  end;
$$;

-- Keep the existing trigger name so the previously installed trigger continues
-- to protect every direct or future process_inbound job insert.
create or replace function public.ai_suppress_superseded_job_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if new.kind <> 'process_inbound' then
    return new;
  end if;

  v_reason := public.ai_inbound_processing_block_reason(new.source_message_id);
  if v_reason is null then
    return new;
  end if;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'system',
    'hera_receptionist',
    case
      when v_reason = 'historical_backfill'
        then 'historical_backfill_suppressed'
      else 'out_of_order_inbound_suppressed'
    end,
    'message',
    new.source_message_id::text,
    jsonb_build_object(
      'suppressionStage', 'job_insert',
      'reason', v_reason,
      'maximumLiveArrivalDelayMinutes', 60
    )
  );

  return null;
end;
$$;

create or replace function public.ai_claim_jobs(
  p_worker_id text,
  p_limit integer default 10
) returns setof public.ai_jobs
language sql
security definer
set search_path = ''
as $$
  with suppressible as materialized (
    select
      job.id,
      job.source_message_id,
      public.ai_inbound_processing_block_reason(job.source_message_id) as reason
    from public.ai_jobs as job
    where (
      (
        job.status in ('pending', 'retry') and job.available_at <= now()
      ) or (
        job.status = 'processing' and job.locked_at < now() - interval '5 minutes'
      )
    )
    and public.ai_inbound_processing_block_reason(job.source_message_id) is not null
    for update of job skip locked
  ),
  suppressed as (
    update public.ai_jobs as job
    set status = 'completed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = case
          when suppressible.reason = 'historical_backfill'
            then 'historical_backfill_not_live_enquiry'
          else 'superseded_by_newer_inbound'
        end,
        updated_at = now()
    from suppressible
    where job.id = suppressible.id
    returning job.id, job.source_message_id, suppressible.reason
  ),
  audit as (
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
      case
        when suppressed.reason = 'historical_backfill'
          then 'historical_backfill_suppressed'
        else 'out_of_order_inbound_suppressed'
      end,
      'message',
      suppressed.source_message_id::text,
      jsonb_build_object(
        'suppressionStage', 'job_claim',
        'jobId', suppressed.id,
        'reason', suppressed.reason,
        'maximumLiveArrivalDelayMinutes', 60
      )
    from suppressed
    returning id
  ),
  selected as (
    select candidate.id
    from public.ai_jobs as candidate
    join public.ai_messages as candidate_message
      on candidate_message.id = candidate.source_message_id
    cross join (select count(*) as audit_count from audit) as audit_barrier
    where (
      (
        candidate.status in ('pending', 'retry') and candidate.available_at <= now()
      ) or (
        candidate.status = 'processing' and candidate.locked_at < now() - interval '5 minutes'
      )
    )
    and audit_barrier.audit_count >= 0
    and not exists (
      select 1 from suppressible where suppressible.id = candidate.id
    )
    and public.ai_inbound_processing_block_reason(candidate.source_message_id) is null
    and not exists (
      select 1
      from public.ai_jobs as predecessor
      join public.ai_messages as predecessor_message
        on predecessor_message.id = predecessor.source_message_id
      where predecessor_message.conversation_id = candidate_message.conversation_id
        and predecessor.status in ('pending', 'processing', 'retry')
        and public.ai_inbound_processing_block_reason(predecessor.source_message_id) is null
        and not exists (
          select 1 from suppressible where suppressible.id = predecessor.id
        )
        and (
          predecessor.created_at < candidate.created_at
          or (
            predecessor.created_at = candidate.created_at
            and predecessor.id::text < candidate.id::text
          )
        )
    )
    order by candidate.available_at asc, candidate.created_at asc
    for update of candidate skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  update public.ai_jobs as job
  set status = 'processing',
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = nullif(trim(p_worker_id), ''),
      updated_at = now()
  from selected
  where job.id = selected.id
  returning job.*;
$$;

-- Re-check the same transport/backfill condition immediately before any future
-- client provider send. Shadow mode still prevents every send independently.
create or replace function public.ai_authorize_whatsapp_outbox_send(
  p_outbox_id uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_message_id uuid;
  v_target_type text;
  v_status text;
  v_block_reason text;
begin
  select item.source_message_id, item.target_type, item.status
    into v_source_message_id, v_target_type, v_status
  from public.ai_outbox as item
  where item.id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox item not found';
  end if;

  if v_target_type = 'client' and v_source_message_id is not null then
    v_block_reason := public.ai_inbound_processing_block_reason(v_source_message_id);
  end if;

  if v_block_reason is not null then
    if v_status = 'processing' then
      update public.ai_outbox
      set status = 'shadowed',
          locked_at = null,
          locked_by = null,
          last_error = case
            when v_block_reason = 'historical_backfill'
              then 'blocked_historical_backfill'
            else 'blocked_by_newer_inbound'
          end,
          updated_at = now()
      where id = p_outbox_id;

      insert into public.ai_audit_log (
        actor_type,
        actor_id,
        event_type,
        target_type,
        target_id,
        details
      ) values (
        'system',
        'hera_receptionist',
        case
          when v_block_reason = 'historical_backfill'
            then 'outbox_blocked_historical_backfill'
          else 'outbox_blocked_newer_inbound'
        end,
        'outbox',
        p_outbox_id::text,
        jsonb_build_object(
          'sourceMessageId', v_source_message_id,
          'reason', v_block_reason,
          'maximumLiveArrivalDelayMinutes', 60
        )
      );
      return 'shadowed';
    end if;

    if v_status = 'shadowed' then
      return 'shadowed';
    end if;
  end if;

  return public.ai_authorize_whatsapp_outbox_send_base(p_outbox_id);
end;
$$;

-- Existing backfill-generated candidates remain preserved as evidence, but the
-- trusted review queue must never suggest that they were live real-client cases.
create or replace function public.ai_list_shadow_review_queue(
  p_limit integer default 25
) returns table (
  source_message_id uuid,
  outbox_id uuid,
  received_at timestamptz,
  message_kind text,
  client_message text,
  candidate_reply text,
  risk text,
  response_model_id text,
  verifier_model_id text,
  response_latency_ms integer,
  verifier_latency_ms integer,
  source_references jsonb,
  verifier_approved boolean,
  policy_can_auto_send boolean,
  suggested_case_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    message.id,
    item.id,
    message.created_at,
    message.kind,
    left(message.text_body, 12000),
    left(coalesce(item.body ->> 'text', ''), 3500),
    coalesce(response_decision.risk, policy_decision.risk, 'green'),
    response_decision.model_id,
    verifier_decision.model_id,
    response_decision.latency_ms,
    verifier_decision.latency_ms,
    coalesce(response_decision.output -> 'decision' -> 'sources', '[]'::jsonb),
    coalesce((verifier_decision.output ->> 'approved')::boolean, false),
    coalesce((policy_decision.output -> 'policy' ->> 'canAutoSend')::boolean, false),
    case
      when message.text_body like 'HERA-%TEST-%' then 'synthetic'
      when public.ai_is_inbound_historical_backfill(message.id) then 'operational'
      else 'real'
    end
  from public.ai_messages as message
  join public.ai_jobs as job
    on job.source_message_id = message.id
   and job.status = 'completed'
  join public.ai_outbox as item
    on item.source_message_id = message.id
   and item.target_type = 'client'
   and item.status = 'shadowed'
  left join lateral (
    select decision.*
    from public.ai_decisions as decision
    where decision.source_message_id = message.id
      and decision.stage = 'response'
    order by decision.created_at desc
    limit 1
  ) as response_decision on true
  left join lateral (
    select decision.*
    from public.ai_decisions as decision
    where decision.source_message_id = message.id
      and decision.stage = 'verification'
    order by decision.created_at desc
    limit 1
  ) as verifier_decision on true
  left join lateral (
    select decision.*
    from public.ai_decisions as decision
    where decision.source_message_id = message.id
      and decision.stage = 'policy'
    order by decision.created_at desc
    limit 1
  ) as policy_decision on true
  where message.direction = 'inbound'
    and not exists (
      select 1
      from public.ai_shadow_reviews as review
      where review.source_message_id = message.id
        and review.reviewer_type = 'human'
    )
  order by message.created_at asc
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;

-- Correct the classification of previously recorded automated baseline reviews
-- without deleting or weakening any failed evidence.
with reclassified as (
  update public.ai_shadow_reviews as review
  set case_type = 'operational',
      include_in_launch_metrics = false,
      notes = left(
        concat_ws(
          E'\n',
          nullif(review.notes, ''),
          'Reclassified as an operational Coexistence backfill case: provider timestamp preceded database arrival by more than 60 minutes.'
        ),
        4000
      ),
      updated_at = now()
  from public.ai_messages as message
  where message.id = review.source_message_id
    and review.reviewer_type = 'automated'
    and public.ai_is_inbound_historical_backfill(message.id)
    and review.case_type <> 'operational'
  returning review.id
)
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
  'historical_backfill_reviews_reclassified',
  'shadow_review_batch',
  null,
  jsonb_build_object(
    'reviewCount', count(*),
    'maximumLiveArrivalDelayMinutes', 60
  )
from reclassified;

-- Record the already preserved backfill evidence so it is distinguishable from
-- a genuinely live message even if it predates this migration.
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
  'historical_backfill_evidence_classified',
  'message',
  message.id::text,
  jsonb_build_object(
    'arrivalDelaySeconds', greatest(
      0,
      extract(epoch from (message.created_at - message.provider_timestamp))::bigint
    ),
    'maximumLiveArrivalDelayMinutes', 60
  )
from public.ai_messages as message
where public.ai_is_inbound_historical_backfill(message.id)
  and not exists (
    select 1
    from public.ai_audit_log as audit
    where audit.event_type = 'historical_backfill_evidence_classified'
      and audit.target_type = 'message'
      and audit.target_id = message.id::text
  );

revoke all on function public.ai_is_inbound_historical_backfill(uuid)
  from public, anon, authenticated;
revoke all on function public.ai_inbound_processing_block_reason(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_suppress_superseded_job_insert()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_claim_jobs(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_authorize_whatsapp_outbox_send(uuid)
  from public, anon, authenticated;
revoke all on function public.ai_list_shadow_review_queue(integer)
  from public, anon, authenticated;

grant execute on function public.ai_is_inbound_historical_backfill(uuid)
  to service_role;
grant execute on function public.ai_claim_jobs(text, integer)
  to service_role;
grant execute on function public.ai_authorize_whatsapp_outbox_send(uuid)
  to service_role;
grant execute on function public.ai_list_shadow_review_queue(integer)
  to service_role;

commit;
