begin;

alter table public.ai_stage3r_runs
  add column if not exists max_model_attempts integer not null default 20100
    check (max_model_attempts between 1 and 50000);
alter table public.ai_stage3r_runs
  add column if not exists legacy_model_call_count integer not null default 0
    check (legacy_model_call_count >= 0),
  add column if not exists legacy_estimated_cost_usd numeric(18,12) not null default 0
    check (legacy_estimated_cost_usd >= 0),
  add column if not exists legacy_unpriced_case_count integer not null default 0
    check (legacy_unpriced_case_count >= 0);

-- Freeze the pre-ledger accounting baseline exactly once. Subsequent execution
-- is accounted from ai_stage3r_model_attempts, so legacy results are not double
-- counted after this migration.
update public.ai_stage3r_runs as run
set legacy_model_call_count = baseline.model_call_count,
    legacy_estimated_cost_usd = baseline.estimated_cost_usd,
    legacy_unpriced_case_count = baseline.unpriced_case_count
from (
  select
    existing.id as run_id,
    coalesce(sum(result.model_call_count), 0)::integer as model_call_count,
    coalesce(sum(result.cost_usd), 0)::numeric(18,12) as estimated_cost_usd,
    count(result.id) filter (where result.cost_usd is null)::integer
      as unpriced_case_count
  from public.ai_stage3r_runs as existing
  left join public.ai_stage3r_case_results as result on result.run_id = existing.id
  group by existing.id
) as baseline
where run.id = baseline.run_id;

update public.ai_stage3r_runs
set max_model_attempts = 75
where run_mode = 'calibration';

update public.ai_stage3r_case_queue as queue
set max_attempts = 1
from public.ai_stage3r_runs as run
where run.id = queue.run_id
  and run.run_mode = 'calibration';

create table if not exists public.ai_stage3r_model_attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_stage3r_runs(id) on delete cascade,
  queue_id uuid not null references public.ai_stage3r_case_queue(id) on delete cascade,
  case_index integer not null check (case_index between 0 and 2009),
  stage text not null check (
    length(stage) between 1 and 120
    and stage ~ '^[a-z0-9_:.-]+$'
  ),
  configured_model_id text not null check (length(configured_model_id) between 3 and 120),
  actual_model_id text check (actual_model_id is null or length(actual_model_id) between 3 and 120),
  call_id text not null check (length(call_id) between 1 and 160),
  step_number integer not null check (step_number between 0 and 100),
  status text not null default 'started'
    check (status in ('started', 'completed', 'failed', 'unpriced')),
  finish_reason text check (finish_reason is null or length(finish_reason) between 1 and 40),
  usage jsonb,
  cost_usd numeric(18,12) check (cost_usd is null or cost_usd >= 0),
  pricing_issue text check (pricing_issue is null or length(pricing_issue) between 1 and 180),
  latency_ms bigint check (latency_ms is null or latency_ms >= 0),
  error_code text check (error_code is null or length(error_code) between 1 and 120),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, call_id, step_number)
);

create index if not exists ai_stage3r_model_attempts_queue_idx
  on public.ai_stage3r_model_attempts(queue_id, created_at);
create index if not exists ai_stage3r_model_attempts_unpriced_idx
  on public.ai_stage3r_model_attempts(run_id, status)
  where status in ('started', 'unpriced');

alter table public.ai_stage3r_model_attempts enable row level security;
alter table public.ai_stage3r_model_attempts force row level security;
revoke all on table public.ai_stage3r_model_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_stage3r_model_attempts to service_role;

create or replace function public.ai_stage3r_set_run_attempt_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.max_model_attempts := case
    when new.run_mode = 'calibration' then 75
    else greatest(new.max_model_attempts, 20100)
  end;
  return new;
end;
$$;

drop trigger if exists ai_stage3r_set_run_attempt_limit_trigger
  on public.ai_stage3r_runs;
create trigger ai_stage3r_set_run_attempt_limit_trigger
before insert or update of run_mode, max_model_attempts on public.ai_stage3r_runs
for each row execute function public.ai_stage3r_set_run_attempt_limit();

create or replace function public.ai_stage3r_set_calibration_case_attempt_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.ai_stage3r_runs as run
    where run.id = new.run_id and run.run_mode = 'calibration'
  ) then
    new.max_attempts := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_stage3r_set_calibration_case_attempt_limit_trigger
  on public.ai_stage3r_case_queue;
create trigger ai_stage3r_set_calibration_case_attempt_limit_trigger
before insert on public.ai_stage3r_case_queue
for each row execute function public.ai_stage3r_set_calibration_case_attempt_limit();

create or replace function public.ai_stage3r_begin_model_attempt(
  p_run_id uuid,
  p_queue_id uuid,
  p_lock_token uuid,
  p_case_index integer,
  p_stage text,
  p_configured_model_id text,
  p_call_id text,
  p_step_number integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_attempt_id uuid;
  v_attempt_count integer;
  v_unpriced integer;
  v_cost numeric;
  v_run public.ai_stage3r_runs%rowtype;
begin
  if current_user <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_case_index < 0 or p_case_index > 2009
     or p_step_number < 0 or p_step_number > 100
     or coalesce(length(trim(p_stage)), 0) < 1
     or length(p_stage) > 120
     or p_stage !~ '^[a-z0-9_:.-]+$'
     or coalesce(length(trim(p_configured_model_id)), 0) < 3
     or length(p_configured_model_id) > 120
     or coalesce(length(trim(p_call_id)), 0) < 1
     or length(p_call_id) > 160 then
    raise exception 'invalid Stage 3-R model attempt';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_run_id::text));
  select * into v_run
  from public.ai_stage3r_runs
  where id = p_run_id and status = 'running'
  for update;
  if v_run.id is null then
    raise exception 'Stage 3-R run is not active';
  end if;
  if not exists (
    select 1
    from public.ai_stage3r_case_queue
    where id = p_queue_id
      and run_id = p_run_id
      and case_index = p_case_index
      and status = 'processing'
      and lock_token = p_lock_token
  ) then
    raise exception 'Stage 3-R queue run or lock mismatch';
  end if;

  select
    count(*)::integer,
    count(*) filter (where status in ('started', 'unpriced'))::integer,
    coalesce(sum(cost_usd), 0)
  into v_attempt_count, v_unpriced, v_cost
  from public.ai_stage3r_model_attempts
  where run_id = p_run_id;

  v_attempt_count := v_attempt_count + v_run.legacy_model_call_count;
  v_unpriced := v_unpriced + v_run.legacy_unpriced_case_count;
  v_cost := v_cost + v_run.legacy_estimated_cost_usd;

  if v_unpriced > 0 then
    raise exception 'stage3r_cost_instrumentation_blocked';
  end if;
  if v_attempt_count >= v_run.max_model_attempts then
    raise exception 'stage3r_model_attempt_cap_reached';
  end if;
  if v_cost >= v_run.max_estimated_cost_usd then
    raise exception 'stage3r_cost_cap_reached';
  end if;

  insert into public.ai_stage3r_model_attempts (
    run_id, queue_id, case_index, stage, configured_model_id,
    call_id, step_number, status
  ) values (
    p_run_id, p_queue_id, p_case_index, trim(p_stage),
    trim(p_configured_model_id), trim(p_call_id), p_step_number, 'started'
  )
  returning id into v_attempt_id;

  return jsonb_build_object(
    'attemptId', v_attempt_id,
    'attemptNumber', v_attempt_count + 1,
    'maxModelAttempts', v_run.max_model_attempts,
    'estimatedCostUsdBefore', round(v_cost, 6),
    'maxEstimatedCostUsd', v_run.max_estimated_cost_usd
  );
end;
$$;

create or replace function public.ai_stage3r_finish_model_attempt(
  p_attempt_id uuid,
  p_queue_id uuid,
  p_lock_token uuid,
  p_actual_model_id text,
  p_finish_reason text,
  p_usage jsonb,
  p_cost_usd numeric,
  p_pricing_issue text,
  p_latency_ms bigint,
  p_outcome text,
  p_error_code text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_status text;
  v_total_cost numeric;
begin
  if current_user <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_outcome not in ('completed', 'failed')
     or coalesce(length(trim(p_actual_model_id)), 0) < 3
     or length(p_actual_model_id) > 120
     or p_latency_ms is null or p_latency_ms < 0
     or (p_cost_usd is not null and p_cost_usd < 0) then
    raise exception 'invalid Stage 3-R model attempt completion';
  end if;

  select attempt.run_id into v_run_id
  from public.ai_stage3r_model_attempts as attempt
  where attempt.id = p_attempt_id
    and attempt.queue_id = p_queue_id
    and attempt.status = 'started'
  for update;
  if v_run_id is null then
    raise exception 'Stage 3-R model attempt not found or already closed';
  end if;
  if not exists (
    select 1
    from public.ai_stage3r_case_queue
    where id = p_queue_id
      and run_id = v_run_id
      and status = 'processing'
      and lock_token = p_lock_token
  ) then
    raise exception 'Stage 3-R queue lock mismatch';
  end if;

  v_status := case
    when p_usage is null or p_cost_usd is null then 'unpriced'
    else p_outcome
  end;
  update public.ai_stage3r_model_attempts
  set actual_model_id = trim(p_actual_model_id),
      finish_reason = left(nullif(trim(p_finish_reason), ''), 40),
      usage = p_usage,
      cost_usd = p_cost_usd,
      pricing_issue = left(nullif(trim(p_pricing_issue), ''), 180),
      latency_ms = p_latency_ms,
      error_code = left(nullif(trim(p_error_code), ''), 120),
      status = v_status,
      finished_at = now()
  where id = p_attempt_id;

  select coalesce(sum(cost_usd), 0) into v_total_cost
  from public.ai_stage3r_model_attempts
  where run_id = v_run_id;

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'status', v_status,
    'priced', v_status <> 'unpriced',
    'estimatedCostUsd', p_cost_usd,
    'estimatedRunCostUsd', round(v_total_cost, 6)
  );
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
  v_unpriced integer;
  v_open integer;
  v_calls integer;
  v_latency bigint;
  v_attempt_count integer;
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

  select
    count(*)::integer,
    coalesce(sum(cost_usd), 0),
    count(*) filter (where status in ('started', 'unpriced'))::integer,
    count(*) filter (where status = 'started')::integer,
    coalesce(sum(latency_ms), 0)
  into v_attempt_count, v_cost, v_unpriced, v_open, v_latency
  from public.ai_stage3r_model_attempts where run_id = p_run_id;
  v_cost := v_cost + v_run.legacy_estimated_cost_usd;
  v_unpriced := v_unpriced + v_run.legacy_unpriced_case_count;
  v_calls := v_attempt_count + v_run.legacy_model_call_count;

  return jsonb_build_object(
    'runId', p_run_id,
    'runMode', v_run.run_mode,
    'status', v_run.status,
    'requestedCases', v_run.requested_case_count,
    'maxConcurrency', v_run.max_concurrency,
    'maxEstimatedCostUsd', v_run.max_estimated_cost_usd,
    'maxModelAttempts', v_run.max_model_attempts,
    'pending', v_pending,
    'processing', v_processing,
    'retry', v_retry,
    'completed', v_completed,
    'dead', v_dead,
    'recordedCases', (select count(*) from public.ai_stage3r_case_results where run_id = p_run_id),
    'estimatedCostUsd', round(v_cost, 6),
    'unpricedCases', v_unpriced,
    'unpricedAttempts', v_unpriced,
    'openAttempts', v_open,
    'costInstrumentationBlocked', v_unpriced > 0,
    'costCapReached', v_cost >= v_run.max_estimated_cost_usd,
    'modelAttemptCapReached', v_calls >= v_run.max_model_attempts,
    'modelCallCount', v_calls,
    'latencyMs', v_latency,
    'queueComplete', v_pending = 0 and v_processing = 0 and v_retry = 0,
    'executionSuccessful',
      v_dead = 0
      and v_unpriced = 0
      and v_completed = v_run.requested_case_count
      and v_cost <= v_run.max_estimated_cost_usd
      and v_calls <= v_run.max_model_attempts
  );
end;
$$;

revoke all on function public.ai_stage3r_set_run_attempt_limit() from public, anon, authenticated;
revoke all on function public.ai_stage3r_set_calibration_case_attempt_limit() from public, anon, authenticated;
revoke all on function public.ai_stage3r_begin_model_attempt(uuid, uuid, uuid, integer, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.ai_stage3r_finish_model_attempt(uuid, uuid, uuid, text, text, jsonb, numeric, text, bigint, text, text) from public, anon, authenticated;
revoke all on function public.ai_stage3r_execution_health(uuid) from public, anon, authenticated;
grant execute on function public.ai_stage3r_set_run_attempt_limit() to service_role;
grant execute on function public.ai_stage3r_set_calibration_case_attempt_limit() to service_role;
grant execute on function public.ai_stage3r_begin_model_attempt(uuid, uuid, uuid, integer, text, text, text, integer) to service_role;
grant execute on function public.ai_stage3r_finish_model_attempt(uuid, uuid, uuid, text, text, jsonb, numeric, text, bigint, text, text) to service_role;
grant execute on function public.ai_stage3r_execution_health(uuid) to service_role;

commit;
