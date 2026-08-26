begin;

alter table public.ai_stage3r_runs
  add column if not exists run_mode text not null default 'full'
    check (run_mode in ('calibration', 'full')),
  add column if not exists requested_case_count integer not null default 0
    check (requested_case_count between 0 and 2010),
  add column if not exists max_concurrency integer not null default 1
    check (max_concurrency between 1 and 20);

alter table public.ai_stage3r_case_results
  add column if not exists model_usage jsonb not null default '{}'::jsonb
    check (jsonb_typeof(model_usage) = 'object'),
  add column if not exists cost_usd numeric(14,6)
    check (cost_usd is null or cost_usd >= 0),
  add column if not exists latency_ms bigint
    check (latency_ms is null or latency_ms >= 0),
  add column if not exists model_call_count integer not null default 0
    check (model_call_count >= 0);

create table if not exists public.ai_stage3r_case_queue (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_stage3r_runs(id) on delete cascade,
  case_index integer not null check (case_index between 0 and 2009),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'completed', 'dead')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, case_index)
);

create index if not exists ai_stage3r_queue_claim_idx
  on public.ai_stage3r_case_queue(run_id, status, available_at, case_index);
create index if not exists ai_stage3r_queue_lock_idx
  on public.ai_stage3r_case_queue(status, locked_at)
  where status = 'processing';

alter table public.ai_stage3r_case_queue enable row level security;
alter table public.ai_stage3r_case_queue force row level security;
revoke all on table public.ai_stage3r_case_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_stage3r_case_queue to service_role;

create or replace function public.ai_stage3r_configure_execution(
  p_run_id uuid,
  p_run_mode text,
  p_case_count integer,
  p_max_concurrency integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_run_mode not in ('calibration', 'full') then
    raise exception 'invalid Stage 3-R run mode';
  end if;
  if p_case_count < 1 or p_case_count > 2010 then
    raise exception 'invalid Stage 3-R case count';
  end if;
  if p_run_mode = 'full' and p_case_count <> 2010 then
    raise exception 'full Stage 3-R run must contain exactly 2010 cases';
  end if;
  if p_max_concurrency < 1 or p_max_concurrency > 20 then
    raise exception 'invalid Stage 3-R concurrency';
  end if;

  update public.ai_stage3r_runs
  set run_mode = p_run_mode,
      requested_case_count = p_case_count,
      max_concurrency = p_max_concurrency,
      status = 'running',
      updated_at = now()
  where id = p_run_id;
  if not found then raise exception 'Stage 3-R run not found'; end if;

  insert into public.ai_stage3r_case_queue (run_id, case_index, status, attempts, max_attempts, available_at)
  select p_run_id, value, 'pending', 0, 3, now()
  from generate_series(0, p_case_count - 1) as value
  on conflict (run_id, case_index) do nothing;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system', 'stage3r-certification', 'stage3r_execution_configured',
    'stage3r_run', p_run_id::text,
    jsonb_build_object(
      'runMode', p_run_mode,
      'caseCount', p_case_count,
      'maxConcurrency', p_max_concurrency,
      'whatsappSendMode', 'shadow'
    )
  );

  return jsonb_build_object(
    'runId', p_run_id,
    'runMode', p_run_mode,
    'caseCount', p_case_count,
    'maxConcurrency', p_max_concurrency
  );
end;
$$;

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
  v_token uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_lock_minutes < 2 or p_lock_minutes > 60 then
    raise exception 'invalid Stage 3-R lock interval';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_run_id::text));

  update public.ai_stage3r_case_queue
  set status = case when attempts >= max_attempts then 'dead' else 'retry' end,
      available_at = case when attempts >= max_attempts then available_at else now() end,
      lock_token = null,
      locked_at = null,
      last_error_code = coalesce(last_error_code, 'stale_lock_recovered'),
      updated_at = now()
  where run_id = p_run_id
    and status = 'processing'
    and locked_at < now() - make_interval(mins => p_lock_minutes);

  select max_concurrency into v_limit
  from public.ai_stage3r_runs
  where id = p_run_id and status = 'running'
  for update;
  if v_limit is null then return; end if;

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

create or replace function public.ai_stage3r_complete_case(
  p_queue_id uuid,
  p_lock_token uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  update public.ai_stage3r_case_queue
  set status = 'completed',
      completed_at = now(),
      locked_at = null,
      lock_token = null,
      last_error_code = null,
      updated_at = now()
  where id = p_queue_id and status = 'processing' and lock_token = p_lock_token;
  if not found then raise exception 'Stage 3-R queue lock mismatch'; end if;
end;
$$;

create or replace function public.ai_stage3r_retry_case(
  p_queue_id uuid,
  p_lock_token uuid,
  p_error_code text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_attempts integer;
  v_max_attempts integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select attempts, max_attempts into v_attempts, v_max_attempts
  from public.ai_stage3r_case_queue
  where id = p_queue_id and status = 'processing' and lock_token = p_lock_token
  for update;
  if v_attempts is null then raise exception 'Stage 3-R queue lock mismatch'; end if;

  v_status := case when v_attempts >= v_max_attempts then 'dead' else 'retry' end;
  update public.ai_stage3r_case_queue
  set status = v_status,
      available_at = case
        when v_status = 'dead' then available_at
        else now() + make_interval(secs => least(900, 30 * power(3, greatest(v_attempts - 1, 0))::integer))
      end,
      locked_at = null,
      lock_token = null,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'stage3r_processing_failed'), 120),
      updated_at = now()
  where id = p_queue_id;
  return v_status;
end;
$$;

create or replace function public.ai_stage3r_execution_health(
  p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.ai_stage3r_runs%rowtype;
  v_pending integer;
  v_processing integer;
  v_retry integer;
  v_completed integer;
  v_dead integer;
  v_cost numeric;
  v_calls integer;
  v_latency bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select * into v_run from public.ai_stage3r_runs where id = p_run_id;
  if v_run.id is null then raise exception 'Stage 3-R run not found'; end if;

  select
    count(*) filter (where status = 'pending')::integer,
    count(*) filter (where status = 'processing')::integer,
    count(*) filter (where status = 'retry')::integer,
    count(*) filter (where status = 'completed')::integer,
    count(*) filter (where status = 'dead')::integer
  into v_pending, v_processing, v_retry, v_completed, v_dead
  from public.ai_stage3r_case_queue where run_id = p_run_id;

  select coalesce(sum(cost_usd), 0), coalesce(sum(model_call_count), 0), coalesce(sum(latency_ms), 0)
  into v_cost, v_calls, v_latency
  from public.ai_stage3r_case_results where run_id = p_run_id;

  return jsonb_build_object(
    'runId', p_run_id,
    'runMode', v_run.run_mode,
    'status', v_run.status,
    'requestedCases', v_run.requested_case_count,
    'maxConcurrency', v_run.max_concurrency,
    'pending', v_pending,
    'processing', v_processing,
    'retry', v_retry,
    'completed', v_completed,
    'dead', v_dead,
    'recordedCases', (select count(*) from public.ai_stage3r_case_results where run_id = p_run_id),
    'costUsd', round(v_cost, 6),
    'modelCallCount', v_calls,
    'latencyMs', v_latency,
    'queueComplete', v_pending = 0 and v_processing = 0 and v_retry = 0,
    'executionSuccessful', v_dead = 0 and v_completed = v_run.requested_case_count
  );
end;
$$;

create or replace function public.ai_stage3r_finalize_execution(
  p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_execution jsonb;
  v_certification jsonb;
  v_mode text;
  v_success boolean;
  v_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select run_mode into v_mode from public.ai_stage3r_runs where id = p_run_id for update;
  if v_mode is null then raise exception 'Stage 3-R run not found'; end if;

  v_execution := public.ai_stage3r_execution_health(p_run_id);
  if not coalesce((v_execution->>'queueComplete')::boolean, false) then
    raise exception 'Stage 3-R queue is not complete';
  end if;
  v_certification := public.ai_stage3r_certification_health(p_run_id);
  v_success := coalesce((v_execution->>'executionSuccessful')::boolean, false)
    and (v_mode = 'calibration' or coalesce((v_certification->>'healthy')::boolean, false));
  v_status := case when v_success then 'completed' else 'failed' end;

  update public.ai_stage3r_runs
  set status = v_status,
      completed_at = now(),
      summary = jsonb_build_object(
        'execution', v_execution,
        'certification', v_certification,
        'calibrationOnly', v_mode = 'calibration'
      ),
      updated_at = now()
  where id = p_run_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system', 'stage3r-certification', 'stage3r_execution_finalized',
    'stage3r_run', p_run_id::text,
    jsonb_build_object('runMode', v_mode, 'status', v_status, 'execution', v_execution)
  );

  return jsonb_build_object(
    'status', v_status,
    'runMode', v_mode,
    'execution', v_execution,
    'certification', v_certification
  );
end;
$$;

revoke all on function public.ai_stage3r_configure_execution(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.ai_stage3r_claim_case(uuid, integer) from public, anon, authenticated;
revoke all on function public.ai_stage3r_complete_case(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ai_stage3r_retry_case(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_stage3r_execution_health(uuid) from public, anon, authenticated;
revoke all on function public.ai_stage3r_finalize_execution(uuid) from public, anon, authenticated;
grant execute on function public.ai_stage3r_configure_execution(uuid, text, integer, integer) to service_role;
grant execute on function public.ai_stage3r_claim_case(uuid, integer) to service_role;
grant execute on function public.ai_stage3r_complete_case(uuid, uuid) to service_role;
grant execute on function public.ai_stage3r_retry_case(uuid, uuid, text) to service_role;
grant execute on function public.ai_stage3r_execution_health(uuid) to service_role;
grant execute on function public.ai_stage3r_finalize_execution(uuid) to service_role;

commit;
