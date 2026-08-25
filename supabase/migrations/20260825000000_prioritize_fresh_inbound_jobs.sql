begin;

create or replace function public.ai_claim_jobs_by_ids(
  p_worker_id text,
  p_job_ids uuid[]
) returns setof public.ai_jobs
language sql
security definer
set search_path = ''
as $$
  with requested as materialized (
    select distinct requested_id as id, ordinal_position
    from unnest(coalesce(p_job_ids, '{}'::uuid[])) with ordinality
      as input(requested_id, ordinal_position)
    where requested_id is not null
  ),
  suppressible as materialized (
    select job.id, job.source_message_id
    from public.ai_jobs as job
    join requested on requested.id = job.id
    where (
      (job.status in ('pending', 'retry') and job.available_at <= now())
      or (job.status = 'processing' and job.locked_at < now() - interval '5 minutes')
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
      actor_type, actor_id, event_type, target_type, target_id, details
    )
    select
      'system',
      'hera_receptionist',
      'out_of_order_inbound_suppressed',
      'message',
      suppressed.source_message_id::text,
      jsonb_build_object(
        'suppressionStage', 'targeted_job_claim',
        'jobId', suppressed.id,
        'reason', 'newer_inbound_recorded_before_targeted_processing'
      )
    from suppressed
    returning id
  ),
  selected as (
    select job.id
    from public.ai_jobs as job
    join requested on requested.id = job.id
    cross join (select count(*) as audit_count from audit) as audit_barrier
    where (
      (job.status in ('pending', 'retry') and job.available_at <= now())
      or (job.status = 'processing' and job.locked_at < now() - interval '5 minutes')
    )
    and audit_barrier.audit_count >= 0
    and not exists (select 1 from suppressible where suppressible.id = job.id)
    and not public.ai_is_inbound_superseded(job.source_message_id)
    order by requested.ordinal_position, job.created_at
    for update of job skip locked
    limit 25
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

revoke all on function public.ai_claim_jobs_by_ids(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.ai_claim_jobs_by_ids(text, uuid[])
  to service_role;

commit;
