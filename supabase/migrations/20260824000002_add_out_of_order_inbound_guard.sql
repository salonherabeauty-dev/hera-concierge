begin;

create index if not exists ai_messages_conversation_provider_time_idx
  on public.ai_messages(
    conversation_id,
    provider_timestamp desc,
    created_at desc
  )
  where direction = 'inbound';

create or replace function public.ai_is_inbound_superseded(
  p_message_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select exists (
      select 1
      from public.ai_messages as newer
      where newer.conversation_id = current_message.conversation_id
        and newer.id <> current_message.id
        and newer.direction = 'inbound'
        and newer.kind not in ('reaction', 'system')
        and (
          coalesce(newer.provider_timestamp, newer.created_at)
            > coalesce(current_message.provider_timestamp, current_message.created_at)
          or (
            coalesce(newer.provider_timestamp, newer.created_at)
              = coalesce(current_message.provider_timestamp, current_message.created_at)
            and newer.created_at > current_message.created_at
          )
        )
    )
    from public.ai_messages as current_message
    where current_message.id = p_message_id
      and current_message.direction = 'inbound'
  ), false);
$$;

create or replace function public.ai_suppress_superseded_job_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'process_inbound'
     and public.ai_is_inbound_superseded(new.source_message_id) then
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
      'out_of_order_inbound_suppressed',
      'message',
      new.source_message_id::text,
      jsonb_build_object(
        'suppressionStage', 'job_insert',
        'reason', 'newer_inbound_already_recorded'
      )
    );
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_jobs_suppress_superseded_insert
  on public.ai_jobs;
create trigger ai_jobs_suppress_superseded_insert
before insert on public.ai_jobs
for each row
execute function public.ai_suppress_superseded_job_insert();

create or replace function public.ai_claim_jobs(
  p_worker_id text,
  p_limit integer default 10
) returns setof public.ai_jobs
language sql
security definer
set search_path = ''
as $$
  with suppressible as materialized (
    select job.id, job.source_message_id
    from public.ai_jobs as job
    where (
      (
        job.status in ('pending', 'retry') and job.available_at <= now()
      ) or (
        job.status = 'processing' and job.locked_at < now() - interval '5 minutes'
      )
    )
    and public.ai_is_inbound_superseded(job.source_message_id)
    for update of job skip locked
  ),
  suppressed as (
    update public.ai_jobs as job
    set status = 'completed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = 'superseded_by_newer_inbound',
        updated_at = now()
    from suppressible
    where job.id = suppressible.id
    returning job.id, job.source_message_id
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
      'out_of_order_inbound_suppressed',
      'message',
      suppressed.source_message_id::text,
      jsonb_build_object(
        'suppressionStage', 'job_claim',
        'jobId', suppressed.id,
        'reason', 'newer_inbound_recorded_before_processing'
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
    and not public.ai_is_inbound_superseded(candidate.source_message_id)
    and not exists (
      select 1
      from public.ai_jobs as predecessor
      join public.ai_messages as predecessor_message
        on predecessor_message.id = predecessor.source_message_id
      where predecessor_message.conversation_id = candidate_message.conversation_id
        and predecessor.status in ('pending', 'processing', 'retry')
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

alter function public.ai_authorize_whatsapp_outbox_send(uuid)
  rename to ai_authorize_whatsapp_outbox_send_base;

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
begin
  select item.source_message_id, item.target_type, item.status
    into v_source_message_id, v_target_type, v_status
  from public.ai_outbox as item
  where item.id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox item not found';
  end if;

  if v_target_type = 'client'
     and v_source_message_id is not null
     and public.ai_is_inbound_superseded(v_source_message_id) then
    if v_status = 'processing' then
      update public.ai_outbox
      set status = 'shadowed',
          locked_at = null,
          locked_by = null,
          last_error = 'blocked_by_newer_inbound',
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
        'outbox_blocked_newer_inbound',
        'outbox',
        p_outbox_id::text,
        jsonb_build_object(
          'sourceMessageId', v_source_message_id,
          'reason', 'newer_inbound_recorded_before_provider_send'
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

revoke all on function public.ai_is_inbound_superseded(uuid)
  from public, anon, authenticated;
revoke all on function public.ai_suppress_superseded_job_insert()
  from public, anon, authenticated;
revoke all on function public.ai_claim_jobs(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_authorize_whatsapp_outbox_send_base(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_authorize_whatsapp_outbox_send(uuid)
  from public, anon, authenticated;

grant execute on function public.ai_is_inbound_superseded(uuid)
  to service_role;
grant execute on function public.ai_claim_jobs(text, integer)
  to service_role;
grant execute on function public.ai_authorize_whatsapp_outbox_send(uuid)
  to service_role;

commit;
