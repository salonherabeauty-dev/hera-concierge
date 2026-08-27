begin;

create or replace function public.ai_stage3r_claim_case(
  p_run_id uuid,
  p_lock_minutes integer default 12
) returns table (
  queue_id uuid,
  case_index integer,
  lock_token uuid,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_active integer;
  v_max_estimated_cost numeric;
  v_recorded_estimated_cost numeric;
  v_unpriced integer;
  v_token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_lock_minutes < 2 or p_lock_minutes > 60 then
    raise exception 'invalid Stage 3-R lock interval';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_run_id::text));

  update public.ai_stage3r_case_queue as stale
  set status = case when stale.attempts >= stale.max_attempts then 'dead' else 'retry' end,
      available_at = case when stale.attempts >= stale.max_attempts then stale.available_at else now() end,
      lock_token = null,
      locked_at = null,
      last_error_code = coalesce(stale.last_error_code, 'stale_lock_recovered'),
      updated_at = now()
  where stale.run_id = p_run_id
    and stale.status = 'processing'
    and stale.locked_at < now() - make_interval(mins => p_lock_minutes);

  select max_concurrency, max_estimated_cost_usd
  into v_limit, v_max_estimated_cost
  from public.ai_stage3r_runs
  where id = p_run_id and status = 'running'
  for update;
  if v_limit is null then return; end if;

  select
    coalesce(sum(cost_usd), 0),
    count(*) filter (where cost_usd is null)::integer
  into v_recorded_estimated_cost, v_unpriced
  from public.ai_stage3r_case_results
  where run_id = p_run_id;
  if v_unpriced > 0 or v_recorded_estimated_cost >= v_max_estimated_cost then
    return;
  end if;

  select count(*)::integer into v_active
  from public.ai_stage3r_case_queue
  where run_id = p_run_id and status = 'processing';
  if v_active >= v_limit then return; end if;

  return query
  with picked as (
    select q.id
    from public.ai_stage3r_case_queue q
    where q.run_id = p_run_id
      and q.status in ('pending', 'retry')
      and q.available_at <= now()
    order by case when q.status = 'pending' then 0 else 1 end,
             q.available_at,
             q.case_index
    for update skip locked
    limit 1
  ), claimed as (
    update public.ai_stage3r_case_queue q
    set status = 'processing',
        attempts = q.attempts + 1,
        locked_at = now(),
        lock_token = v_token,
        updated_at = now()
    from picked
    where q.id = picked.id
    returning q.id, q.case_index, q.lock_token, q.attempts
  )
  select claimed.id, claimed.case_index, claimed.lock_token, claimed.attempts
  from claimed;
end;
$$;

revoke all on function public.ai_stage3r_claim_case(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.ai_stage3r_claim_case(uuid, integer)
  to service_role;

commit;
