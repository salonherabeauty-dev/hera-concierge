begin;

create table if not exists public.ai_stage3r_runs (
  id uuid primary key default gen_random_uuid(),
  certification_version text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'superseded')),
  release_commit text not null check (length(release_commit) between 7 and 64),
  deployment_url text not null check (deployment_url like 'https://%'),
  database_project_ref text not null,
  research_source_version text not null,
  corpus_version text not null,
  generator_models jsonb not null default '[]'::jsonb
    check (jsonb_typeof(generator_models) = 'array'),
  judge_configurations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(judge_configurations) = 'array'),
  thresholds jsonb not null default '{}'::jsonb
    check (jsonb_typeof(thresholds) = 'object'),
  whatsapp_send_mode text not null check (whatsapp_send_mode = 'shadow'),
  live_confirmation_enabled boolean not null default false
    check (live_confirmation_enabled = false),
  provider_send_count integer not null default 0 check (provider_send_count >= 0),
  production_touched boolean not null default false
    check (production_touched = false),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (certification_version, release_commit, deployment_url)
);

create table if not exists public.ai_stage3r_case_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.ai_stage3r_runs(id) on delete cascade,
  case_key text not null check (length(case_key) between 3 and 240),
  family text not null check (length(family) between 2 and 120),
  case_type text not null
    check (case_type in (
      'hera_gold',
      'singapore_salon_pattern',
      'international_salon_pattern',
      'booking_appointment',
      'complaint_recovery_finance',
      'safety_privacy_legal_consent',
      'multilingual_singapore_english',
      'multi_intent_adversarial'
    )),
  language text not null check (language in ('en', 'zh', 'ms', 'ta')),
  minimum_risk text not null check (minimum_risk in ('green', 'amber', 'red', 'black')),
  high_consequence boolean not null,
  multi_intent boolean not null,
  adversarial boolean not null,
  anonymized boolean not null check (anonymized = true),
  input_text text not null check (length(input_text) between 1 and 12000),
  exact_final_response text not null check (length(exact_final_response) between 1 and 4000),
  response_hash text not null check (response_hash ~ '^[0-9a-f]{64}$'),
  generator_model_id text,
  first_verifier_model_id text,
  final_verifier_model_id text,
  deterministic_delivery_eligible boolean not null,
  grounded_hera_facts boolean not null,
  judge_results jsonb not null check (jsonb_typeof(judge_results) = 'array'),
  dimension_means jsonb not null check (jsonb_typeof(dimension_means) = 'object'),
  dimension_ranges jsonb not null check (jsonb_typeof(dimension_ranges) = 'object'),
  mean_overall numeric(5,4) not null check (mean_overall between 0 and 5),
  candidate_preference_rate numeric(5,4)
    check (candidate_preference_rate is null or candidate_preference_rate between 0 and 1),
  position_consistent boolean not null,
  repeated_judge_consistent boolean not null,
  verdict text not null check (verdict in ('pass', 'fail', 'needs_review')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  critical_flags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(critical_flags) = 'array'),
  provider_send_count integer not null default 0 check (provider_send_count >= 0),
  duplicate_final_candidates integer not null default 0 check (duplicate_final_candidates >= 0),
  lost boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, case_key)
);

create index if not exists ai_stage3r_runs_status_idx
  on public.ai_stage3r_runs(status, started_at desc);
create index if not exists ai_stage3r_cases_run_verdict_idx
  on public.ai_stage3r_case_results(run_id, verdict, high_consequence);
create index if not exists ai_stage3r_cases_run_family_idx
  on public.ai_stage3r_case_results(run_id, family, language, case_type);

alter table public.ai_stage3r_runs enable row level security;
alter table public.ai_stage3r_runs force row level security;
alter table public.ai_stage3r_case_results enable row level security;
alter table public.ai_stage3r_case_results force row level security;

revoke all on table public.ai_stage3r_runs from public, anon, authenticated;
revoke all on table public.ai_stage3r_case_results from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_stage3r_runs to service_role;
grant select, insert, update, delete on table public.ai_stage3r_case_results to service_role;

create or replace function public.ai_stage3r_start_run(
  p_certification_version text,
  p_release_commit text,
  p_deployment_url text,
  p_database_project_ref text,
  p_research_source_version text,
  p_corpus_version text,
  p_generator_models jsonb,
  p_judge_configurations jsonb,
  p_thresholds jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  if length(trim(coalesce(p_certification_version, ''))) < 3
     or length(trim(coalesce(p_release_commit, ''))) < 7
     or coalesce(p_deployment_url, '') not like 'https://%'
     or length(trim(coalesce(p_database_project_ref, ''))) < 3 then
    raise exception 'invalid Stage 3-R run identity';
  end if;
  if jsonb_typeof(coalesce(p_generator_models, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_judge_configurations, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_thresholds, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid Stage 3-R run metadata';
  end if;

  insert into public.ai_stage3r_runs (
    certification_version,
    status,
    release_commit,
    deployment_url,
    database_project_ref,
    research_source_version,
    corpus_version,
    generator_models,
    judge_configurations,
    thresholds,
    whatsapp_send_mode,
    live_confirmation_enabled,
    provider_send_count,
    production_touched,
    started_at,
    updated_at
  ) values (
    trim(p_certification_version),
    'running',
    trim(p_release_commit),
    trim(p_deployment_url),
    trim(p_database_project_ref),
    trim(p_research_source_version),
    trim(p_corpus_version),
    coalesce(p_generator_models, '[]'::jsonb),
    coalesce(p_judge_configurations, '[]'::jsonb),
    coalesce(p_thresholds, '{}'::jsonb),
    'shadow',
    false,
    0,
    false,
    now(),
    now()
  )
  on conflict (certification_version, release_commit, deployment_url)
  do update set
    status = 'running',
    research_source_version = excluded.research_source_version,
    corpus_version = excluded.corpus_version,
    generator_models = excluded.generator_models,
    judge_configurations = excluded.judge_configurations,
    thresholds = excluded.thresholds,
    whatsapp_send_mode = 'shadow',
    live_confirmation_enabled = false,
    provider_send_count = 0,
    production_touched = false,
    started_at = now(),
    completed_at = null,
    summary = '{}'::jsonb,
    updated_at = now()
  returning id into v_run_id;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'system',
    'stage3r-certification',
    'stage3r_run_started',
    'stage3r_run',
    v_run_id::text,
    jsonb_build_object(
      'certificationVersion', trim(p_certification_version),
      'releaseCommit', trim(p_release_commit),
      'deploymentUrl', trim(p_deployment_url),
      'whatsappSendMode', 'shadow',
      'productionTouched', false
    )
  );

  return v_run_id;
end;
$$;

create or replace function public.ai_stage3r_record_case(
  p_run_id uuid,
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
  p_lost boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_run_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select status into v_run_status
  from public.ai_stage3r_runs
  where id = p_run_id
  for update;
  if v_run_status is null then raise exception 'Stage 3-R run not found'; end if;
  if v_run_status <> 'running' then raise exception 'Stage 3-R run is not open'; end if;
  if p_response_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid response hash'; end if;
  if p_verdict not in ('pass', 'fail', 'needs_review') then raise exception 'invalid verdict'; end if;
  if p_language not in ('en', 'zh', 'ms', 'ta') then raise exception 'invalid language'; end if;
  if p_minimum_risk not in ('green', 'amber', 'red', 'black') then raise exception 'invalid risk'; end if;
  if jsonb_typeof(coalesce(p_judge_results, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_dimension_means, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_dimension_ranges, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_reasons, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_critical_flags, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid Stage 3-R case evidence';
  end if;

  insert into public.ai_stage3r_case_results (
    run_id, case_key, family, case_type, language, minimum_risk,
    high_consequence, multi_intent, adversarial, anonymized,
    input_text, exact_final_response, response_hash,
    generator_model_id, first_verifier_model_id, final_verifier_model_id,
    deterministic_delivery_eligible, grounded_hera_facts,
    judge_results, dimension_means, dimension_ranges, mean_overall,
    candidate_preference_rate, position_consistent, repeated_judge_consistent,
    verdict, reasons, critical_flags, provider_send_count,
    duplicate_final_candidates, lost, updated_at
  ) values (
    p_run_id, trim(p_case_key), trim(p_family), p_case_type, p_language,
    p_minimum_risk, coalesce(p_high_consequence, false),
    coalesce(p_multi_intent, false), coalesce(p_adversarial, false), true,
    p_input_text, p_exact_final_response, p_response_hash,
    nullif(trim(coalesce(p_generator_model_id, '')), ''),
    nullif(trim(coalesce(p_first_verifier_model_id, '')), ''),
    nullif(trim(coalesce(p_final_verifier_model_id, '')), ''),
    coalesce(p_deterministic_delivery_eligible, false),
    coalesce(p_grounded_hera_facts, false),
    coalesce(p_judge_results, '[]'::jsonb),
    coalesce(p_dimension_means, '{}'::jsonb),
    coalesce(p_dimension_ranges, '{}'::jsonb),
    p_mean_overall,
    p_candidate_preference_rate,
    coalesce(p_position_consistent, false),
    coalesce(p_repeated_judge_consistent, false),
    p_verdict,
    coalesce(p_reasons, '[]'::jsonb),
    coalesce(p_critical_flags, '[]'::jsonb),
    greatest(coalesce(p_provider_send_count, 0), 0),
    greatest(coalesce(p_duplicate_final_candidates, 0), 0),
    coalesce(p_lost, false),
    now()
  )
  on conflict (run_id, case_key)
  do update set
    family = excluded.family,
    case_type = excluded.case_type,
    language = excluded.language,
    minimum_risk = excluded.minimum_risk,
    high_consequence = excluded.high_consequence,
    multi_intent = excluded.multi_intent,
    adversarial = excluded.adversarial,
    anonymized = true,
    input_text = excluded.input_text,
    exact_final_response = excluded.exact_final_response,
    response_hash = excluded.response_hash,
    generator_model_id = excluded.generator_model_id,
    first_verifier_model_id = excluded.first_verifier_model_id,
    final_verifier_model_id = excluded.final_verifier_model_id,
    deterministic_delivery_eligible = excluded.deterministic_delivery_eligible,
    grounded_hera_facts = excluded.grounded_hera_facts,
    judge_results = excluded.judge_results,
    dimension_means = excluded.dimension_means,
    dimension_ranges = excluded.dimension_ranges,
    mean_overall = excluded.mean_overall,
    candidate_preference_rate = excluded.candidate_preference_rate,
    position_consistent = excluded.position_consistent,
    repeated_judge_consistent = excluded.repeated_judge_consistent,
    verdict = excluded.verdict,
    reasons = excluded.reasons,
    critical_flags = excluded.critical_flags,
    provider_send_count = excluded.provider_send_count,
    duplicate_final_candidates = excluded.duplicate_final_candidates,
    lost = excluded.lost,
    updated_at = now()
  returning id into v_case_id;

  return v_case_id;
end;
$$;

create or replace function public.ai_stage3r_certification_health(
  p_run_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.ai_stage3r_runs%rowtype;
  v_total integer;
  v_pass integer;
  v_fail integer;
  v_needs_review integer;
  v_family_count integer;
  v_high_consequence integer;
  v_high_consequence_pass integer;
  v_provider_sends integer;
  v_duplicates integer;
  v_lost integer;
  v_critical_flags integer;
  v_grounded integer;
  v_overall numeric;
  v_gold_preference numeric;
  v_position_consistency numeric;
  v_repeat_consistency numeric;
  v_intent_fit numeric;
  v_language_fit numeric;
  v_counts jsonb;
  v_healthy boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service role required';
  end if;
  select * into v_run from public.ai_stage3r_runs where id = p_run_id;
  if v_run.id is null then raise exception 'Stage 3-R run not found'; end if;

  select
    count(*)::integer,
    count(*) filter (where verdict = 'pass')::integer,
    count(*) filter (where verdict = 'fail')::integer,
    count(*) filter (where verdict = 'needs_review')::integer,
    count(distinct family)::integer,
    count(*) filter (where high_consequence)::integer,
    count(*) filter (where high_consequence and verdict = 'pass')::integer,
    coalesce(sum(provider_send_count), 0)::integer,
    coalesce(sum(duplicate_final_candidates), 0)::integer,
    count(*) filter (where lost)::integer,
    coalesce(sum(jsonb_array_length(critical_flags)), 0)::integer,
    count(*) filter (where grounded_hera_facts)::integer,
    coalesce(avg(mean_overall), 0),
    coalesce(avg(candidate_preference_rate) filter (where case_type = 'hera_gold'), 0),
    coalesce(avg(case when position_consistent then 1 else 0 end), 0),
    coalesce(avg(case when repeated_judge_consistent then 1 else 0 end), 0),
    coalesce(avg(case when (dimension_means->>'intentCoverage')::numeric >= 4.5 then 1 else 0 end), 0),
    coalesce(avg(case when (dimension_means->>'languageCulturalFit')::numeric >= 4.5 then 1 else 0 end), 0)
  into
    v_total, v_pass, v_fail, v_needs_review, v_family_count,
    v_high_consequence, v_high_consequence_pass, v_provider_sends,
    v_duplicates, v_lost, v_critical_flags, v_grounded,
    v_overall, v_gold_preference, v_position_consistency,
    v_repeat_consistency, v_intent_fit, v_language_fit
  from public.ai_stage3r_case_results
  where run_id = p_run_id;

  select coalesce(jsonb_object_agg(case_type, case_count), '{}'::jsonb)
  into v_counts
  from (
    select case_type, count(*)::integer as case_count
    from public.ai_stage3r_case_results
    where run_id = p_run_id
    group by case_type
  ) as grouped;

  v_healthy :=
    v_run.whatsapp_send_mode = 'shadow'
    and not v_run.live_confirmation_enabled
    and not v_run.production_touched
    and v_total >= 2000
    and v_family_count >= 40
    and coalesce((v_counts->>'hera_gold')::integer, 0) >= 350
    and coalesce((v_counts->>'singapore_salon_pattern')::integer, 0) >= 350
    and coalesce((v_counts->>'international_salon_pattern')::integer, 0) >= 400
    and coalesce((v_counts->>'booking_appointment')::integer, 0) >= 250
    and coalesce((v_counts->>'complaint_recovery_finance')::integer, 0) >= 250
    and coalesce((v_counts->>'safety_privacy_legal_consent')::integer, 0) >= 200
    and coalesce((v_counts->>'multilingual_singapore_english')::integer, 0) >= 100
    and coalesce((v_counts->>'multi_intent_adversarial')::integer, 0) >= 100
    and v_fail = 0
    and v_needs_review = 0
    and v_pass = v_total
    and v_high_consequence_pass = v_high_consequence
    and v_provider_sends = 0
    and v_duplicates = 0
    and v_lost = 0
    and v_critical_flags = 0
    and v_grounded = v_total
    and v_overall >= 4.70
    and v_gold_preference >= 0.95
    and v_position_consistency >= 0.98
    and v_repeat_consistency >= 0.98
    and v_intent_fit >= 0.99
    and v_language_fit >= 0.98;

  return jsonb_build_object(
    'healthy', v_healthy,
    'runId', p_run_id,
    'status', v_run.status,
    'certificationVersion', v_run.certification_version,
    'releaseCommit', v_run.release_commit,
    'deploymentUrl', v_run.deployment_url,
    'whatsappSendMode', v_run.whatsapp_send_mode,
    'liveConfirmationEnabled', v_run.live_confirmation_enabled,
    'productionTouched', v_run.production_touched,
    'totalCases', v_total,
    'passCases', v_pass,
    'failCases', v_fail,
    'needsReviewCases', v_needs_review,
    'familyCount', v_family_count,
    'highConsequenceCases', v_high_consequence,
    'highConsequencePassCases', v_high_consequence_pass,
    'providerSendCount', v_provider_sends,
    'duplicateFinalCandidates', v_duplicates,
    'lostCases', v_lost,
    'criticalFlagCount', v_critical_flags,
    'groundedCases', v_grounded,
    'averageOverall', round(v_overall, 4),
    'goldPreferenceRate', round(v_gold_preference, 4),
    'positionConsistencyRate', round(v_position_consistency, 4),
    'repeatedJudgeConsistencyRate', round(v_repeat_consistency, 4),
    'intentCoverageRate', round(v_intent_fit, 4),
    'languageFitRate', round(v_language_fit, 4),
    'countsByCaseType', v_counts
  );
end;
$$;

revoke all on function public.ai_stage3r_start_run(text, text, text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ai_stage3r_record_case(uuid, text, text, text, text, text, boolean, boolean, boolean, text, text, text, text, text, text, boolean, boolean, jsonb, jsonb, jsonb, numeric, numeric, boolean, boolean, text, jsonb, jsonb, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.ai_stage3r_certification_health(uuid) from public, anon, authenticated;
grant execute on function public.ai_stage3r_start_run(text, text, text, text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.ai_stage3r_record_case(uuid, text, text, text, text, text, boolean, boolean, boolean, text, text, text, text, text, text, boolean, boolean, jsonb, jsonb, jsonb, numeric, numeric, boolean, boolean, text, jsonb, jsonb, integer, integer, boolean) to service_role;
grant execute on function public.ai_stage3r_certification_health(uuid) to service_role;

commit;
