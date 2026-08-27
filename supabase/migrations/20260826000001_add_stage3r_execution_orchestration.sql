begin;

alter table public.ai_stage3r_runs
  add column if not exists run_mode text not null default 'full'
    check (run_mode in ('calibration', 'full')),
  add column if not exists requested_case_count integer not null default 0
    check (requested_case_count between 0 and 2010),
  add column if not exists max_concurrency integer not null default 1
    check (max_concurrency between 1 and 20),
  add column if not exists max_estimated_cost_usd numeric(14,6) not null default 0
    check (max_estimated_cost_usd between 0 and 10000);

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
  p_case_indices integer[],
  p_max_concurrency integer,
  p_max_estimated_cost_usd numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_run uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_run_mode not in ('calibration', 'full') then
    raise exception 'invalid Stage 3-R run mode';
  end if;
  if coalesce(cardinality(p_case_indices), 0) < 1
     or cardinality(p_case_indices) > 2010 then
    raise exception 'invalid Stage 3-R case count';
  end if;
  if exists (
    select 1 from unnest(p_case_indices) as value
    where value < 0 or value > 2009
  ) then
    raise exception 'invalid Stage 3-R case index';
  end if;
  if (
    select count(distinct value) from unnest(p_case_indices) as value
  ) <> cardinality(p_case_indices) then
    raise exception 'duplicate Stage 3-R case index';
  end if;
  if p_run_mode = 'calibration' and cardinality(p_case_indices) > 100 then
    raise exception 'calibration Stage 3-R run cannot exceed 100 cases';
  end if;
  if p_run_mode = 'full' and (
    cardinality(p_case_indices) <> 2010
    or (select min(value) from unnest(p_case_indices) as value) <> 0
    or (select max(value) from unnest(p_case_indices) as value) <> 2009
  ) then
    raise exception 'full Stage 3-R run must contain exactly 2010 cases';
  end if;
  if p_max_concurrency < 1 or p_max_concurrency > 20 then
    raise exception 'invalid Stage 3-R concurrency';
  end if;
  if p_run_mode = 'calibration' and p_max_concurrency <> 1 then
    raise exception 'calibration Stage 3-R run requires concurrency one';
  end if;
  if p_max_estimated_cost_usd <= 0 or p_max_estimated_cost_usd > 10000 then
    raise exception 'invalid Stage 3-R estimated cost cap';
  end if;
  select id into v_existing_run
  from public.ai_stage3r_runs
  where id = p_run_id
  for update;
  if v_existing_run is null then raise exception 'Stage 3-R run not found'; end if;
  if exists (
    select 1 from public.ai_stage3r_case_queue where run_id = p_run_id
  ) or exists (
    select 1 from public.ai_stage3r_case_results where run_id = p_run_id
  ) then
    raise exception 'Stage 3-R run already contains immutable execution evidence';
  end if;

  update public.ai_stage3r_runs
  set run_mode = p_run_mode,
      requested_case_count = cardinality(p_case_indices),
      max_concurrency = p_max_concurrency,
      max_estimated_cost_usd = p_max_estimated_cost_usd,
      status = 'running',
      updated_at = now()
  where id = p_run_id;
  if not found then raise exception 'Stage 3-R run not found'; end if;

  insert into public.ai_stage3r_case_queue (run_id, case_index, status, attempts, max_attempts, available_at)
  select p_run_id, value, 'pending', 0, 3, now()
  from unnest(p_case_indices) as value
  on conflict (run_id, case_index) do nothing;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system', 'stage3r-certification', 'stage3r_execution_configured',
    'stage3r_run', p_run_id::text,
    jsonb_build_object(
      'runMode', p_run_mode,
      'caseCount', cardinality(p_case_indices),
      'maxConcurrency', p_max_concurrency,
      'maxEstimatedCostUsd', p_max_estimated_cost_usd,
      'whatsappSendMode', 'shadow'
    )
  );

  return jsonb_build_object(
    'runId', p_run_id,
    'runMode', p_run_mode,
    'caseCount', cardinality(p_case_indices),
    'maxConcurrency', p_max_concurrency,
    'maxEstimatedCostUsd', p_max_estimated_cost_usd
  );
end;
$$;

create or replace function public.ai_stage3r_start_calibration(
  p_certification_version text,
  p_release_commit text,
  p_deployment_url text,
  p_database_project_ref text,
  p_research_source_version text,
  p_corpus_version text,
  p_generator_models jsonb,
  p_judge_configurations jsonb,
  p_thresholds jsonb,
  p_case_indices integer[],
  p_max_estimated_cost_usd numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_configuration jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  v_run_id := public.ai_stage3r_start_run(
    p_certification_version,
    p_release_commit,
    p_deployment_url,
    p_database_project_ref,
    p_research_source_version,
    p_corpus_version,
    p_generator_models,
    p_judge_configurations,
    p_thresholds
  );
  v_configuration := public.ai_stage3r_configure_execution(
    v_run_id,
    'calibration',
    p_case_indices,
    1,
    p_max_estimated_cost_usd
  );
  return jsonb_build_object(
    'runId', v_run_id,
    'configuration', v_configuration,
    'paidCallsStarted', false
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

create or replace function public.ai_stage3r_commit_case(
  p_queue_id uuid,
  p_lock_token uuid,
  p_run_id uuid,
  p_case_index integer,
  p_case_key text,
  p_family text,
  p_case_type text,
  p_language text,
  p_minimum_risk text,
  p_high_consequence boolean,
  p_multi_intent boolean,
  p_adversarial boolean,
  p_input_text text,
  p_exact_final_response text,
  p_response_hash text,
  p_generator_model_id text,
  p_first_verifier_model_id text,
  p_final_verifier_model_id text,
  p_deterministic_delivery_eligible boolean,
  p_grounded_hera_facts boolean,
  p_judge_results jsonb,
  p_dimension_means jsonb,
  p_dimension_ranges jsonb,
  p_mean_overall numeric,
  p_candidate_preference_rate numeric,
  p_position_consistent boolean,
  p_repeated_judge_consistent boolean,
  p_verdict text,
  p_reasons jsonb,
  p_critical_flags jsonb,
  p_provider_send_count integer,
  p_duplicate_final_candidates integer,
  p_lost boolean,
  p_model_usage jsonb,
  p_cost_usd numeric,
  p_latency_ms bigint,
  p_model_call_count integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if jsonb_typeof(coalesce(p_model_usage, '{}'::jsonb)) <> 'object'
     or (p_cost_usd is not null and p_cost_usd < 0)
     or p_latency_ms is null or p_latency_ms < 0
     or p_model_call_count is null or p_model_call_count < 1 then
    raise exception 'invalid Stage 3-R execution instrumentation';
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
  v_case_id := public.ai_stage3r_record_case(
    p_run_id,
    p_case_key,
    p_family,
    p_case_type,
    p_language,
    p_minimum_risk,
    p_high_consequence,
    p_multi_intent,
    p_adversarial,
    p_input_text,
    p_exact_final_response,
    p_response_hash,
    p_generator_model_id,
    p_first_verifier_model_id,
    p_final_verifier_model_id,
    p_deterministic_delivery_eligible,
    p_grounded_hera_facts,
    p_judge_results,
    p_dimension_means,
    p_dimension_ranges,
    p_mean_overall,
    p_candidate_preference_rate,
    p_position_consistent,
    p_repeated_judge_consistent,
    p_verdict,
    p_reasons,
    p_critical_flags,
    p_provider_send_count,
    p_duplicate_final_candidates,
    p_lost
  );
  update public.ai_stage3r_case_results
  set model_usage = coalesce(p_model_usage, '{}'::jsonb),
      cost_usd = p_cost_usd,
      latency_ms = p_latency_ms,
      model_call_count = p_model_call_count,
      updated_at = now()
  where id = v_case_id;
  perform public.ai_stage3r_complete_case(p_queue_id, p_lock_token);
  return v_case_id;
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
  v_unpriced integer;
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

  select
    coalesce(sum(cost_usd), 0),
    count(*) filter (where cost_usd is null)::integer,
    coalesce(sum(model_call_count), 0),
    coalesce(sum(latency_ms), 0)
  into v_cost, v_unpriced, v_calls, v_latency
  from public.ai_stage3r_case_results where run_id = p_run_id;

  return jsonb_build_object(
    'runId', p_run_id,
    'runMode', v_run.run_mode,
    'status', v_run.status,
    'requestedCases', v_run.requested_case_count,
    'maxConcurrency', v_run.max_concurrency,
    'maxEstimatedCostUsd', v_run.max_estimated_cost_usd,
    'pending', v_pending,
    'processing', v_processing,
    'retry', v_retry,
    'completed', v_completed,
    'dead', v_dead,
    'recordedCases', (select count(*) from public.ai_stage3r_case_results where run_id = p_run_id),
    'estimatedCostUsd', round(v_cost, 6),
    'unpricedCases', v_unpriced,
    'costCapReached', v_cost >= v_run.max_estimated_cost_usd,
    'modelCallCount', v_calls,
    'latencyMs', v_latency,
    'queueComplete', v_pending = 0 and v_processing = 0 and v_retry = 0,
    'executionSuccessful',
      v_dead = 0
      and v_unpriced = 0
      and v_completed = v_run.requested_case_count
      and v_cost <= v_run.max_estimated_cost_usd
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
  v_current_status text;
  v_success boolean;
  v_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select run_mode, status into v_mode, v_current_status
  from public.ai_stage3r_runs
  where id = p_run_id
  for update;
  if v_mode is null then raise exception 'Stage 3-R run not found'; end if;
  if v_current_status <> 'running' then
    raise exception 'Stage 3-R run is not active';
  end if;

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

revoke all on function public.ai_stage3r_configure_execution(uuid, text, integer[], integer, numeric) from public, anon, authenticated;
revoke all on function public.ai_stage3r_start_calibration(text, text, text, text, text, text, jsonb, jsonb, jsonb, integer[], numeric) from public, anon, authenticated;
revoke all on function public.ai_stage3r_claim_case(uuid, integer) from public, anon, authenticated;
revoke all on function public.ai_stage3r_complete_case(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ai_stage3r_commit_case(uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, boolean, text, text, text, text, text, text, boolean, boolean, jsonb, jsonb, jsonb, numeric, numeric, boolean, boolean, text, jsonb, jsonb, integer, integer, boolean, jsonb, numeric, bigint, integer) from public, anon, authenticated;
revoke all on function public.ai_stage3r_retry_case(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.ai_stage3r_execution_health(uuid) from public, anon, authenticated;
revoke all on function public.ai_stage3r_finalize_execution(uuid) from public, anon, authenticated;
grant execute on function public.ai_stage3r_configure_execution(uuid, text, integer[], integer, numeric) to service_role;
grant execute on function public.ai_stage3r_start_calibration(text, text, text, text, text, text, jsonb, jsonb, jsonb, integer[], numeric) to service_role;
grant execute on function public.ai_stage3r_claim_case(uuid, integer) to service_role;
grant execute on function public.ai_stage3r_complete_case(uuid, uuid) to service_role;
grant execute on function public.ai_stage3r_commit_case(uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, boolean, text, text, text, text, text, text, boolean, boolean, jsonb, jsonb, jsonb, numeric, numeric, boolean, boolean, text, jsonb, jsonb, integer, integer, boolean, jsonb, numeric, bigint, integer) to service_role;
grant execute on function public.ai_stage3r_retry_case(uuid, uuid, text) to service_role;
grant execute on function public.ai_stage3r_execution_health(uuid) to service_role;
grant execute on function public.ai_stage3r_finalize_execution(uuid) to service_role;

commit;
