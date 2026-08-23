begin;

create table public.ai_shadow_reviews (
  id uuid primary key default gen_random_uuid(),
  source_message_id uuid not null references public.ai_messages(id) on delete cascade,
  outbox_id uuid not null references public.ai_outbox(id) on delete cascade,
  reviewer_type text not null
    check (reviewer_type in ('human', 'automated')),
  reviewer_id text not null
    check (length(trim(reviewer_id)) between 1 and 120),
  rubric_version text not null
    check (length(trim(rubric_version)) between 1 and 120),
  case_type text not null
    check (case_type in ('real', 'synthetic', 'operational', 'historical')),
  include_in_launch_metrics boolean not null default true,
  factual_accuracy smallint not null check (factual_accuracy between 0 and 4),
  safety_compliance smallint not null check (safety_compliance between 0 and 4),
  policy_compliance smallint not null check (policy_compliance between 0 and 4),
  intent_coverage smallint not null check (intent_coverage between 0 and 4),
  luxury_tone smallint not null check (luxury_tone between 0 and 4),
  effort_reduction smallint not null check (effort_reduction between 0 and 4),
  clarity_actionability smallint not null check (clarity_actionability between 0 and 4),
  language_fit smallint not null check (language_fit between 0 and 4),
  concision_naturalness smallint not null check (concision_naturalness between 0 and 4),
  overall_score numeric(4,2) not null check (overall_score between 0 and 4),
  verdict text not null check (verdict in ('pass', 'fail', 'needs_review')),
  critical_flags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(critical_flags) = 'array'),
  notes text not null default '' check (length(notes) <= 4000),
  corrected_reply text check (corrected_reply is null or length(corrected_reply) <= 3500),
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_message_id, reviewer_type, reviewer_id, rubric_version)
);

create index ai_shadow_reviews_verdict_idx
  on public.ai_shadow_reviews(verdict, reviewed_at desc)
  where include_in_launch_metrics;

create index ai_shadow_reviews_message_idx
  on public.ai_shadow_reviews(source_message_id, reviewed_at desc);

alter table public.ai_shadow_reviews enable row level security;
alter table public.ai_shadow_reviews force row level security;
revoke all on table public.ai_shadow_reviews from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_shadow_reviews to service_role;

create or replace function public.ai_record_shadow_review(
  p_source_message_id uuid,
  p_reviewer_type text,
  p_reviewer_id text,
  p_rubric_version text,
  p_case_type text,
  p_include_in_launch_metrics boolean,
  p_factual_accuracy integer,
  p_safety_compliance integer,
  p_policy_compliance integer,
  p_intent_coverage integer,
  p_luxury_tone integer,
  p_effort_reduction integer,
  p_clarity_actionability integer,
  p_language_fit integer,
  p_concision_naturalness integer,
  p_critical_flags jsonb,
  p_notes text,
  p_corrected_reply text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox_id uuid;
  v_review_id uuid;
  v_overall numeric(4,2);
  v_verdict text;
  v_flags jsonb := coalesce(p_critical_flags, '[]'::jsonb);
begin
  if p_reviewer_type not in ('human', 'automated') then
    raise exception 'invalid reviewer type';
  end if;
  if length(trim(coalesce(p_reviewer_id, ''))) not between 1 and 120 then
    raise exception 'invalid reviewer id';
  end if;
  if length(trim(coalesce(p_rubric_version, ''))) not between 1 and 120 then
    raise exception 'invalid rubric version';
  end if;
  if p_case_type not in ('real', 'synthetic', 'operational', 'historical') then
    raise exception 'invalid case type';
  end if;
  if jsonb_typeof(v_flags) <> 'array' then
    raise exception 'critical flags must be a JSON array';
  end if;
  if length(coalesce(p_notes, '')) > 4000 then
    raise exception 'review notes are too long';
  end if;
  if p_corrected_reply is not null and length(p_corrected_reply) > 3500 then
    raise exception 'corrected reply is too long';
  end if;

  if p_factual_accuracy not between 0 and 4
     or p_safety_compliance not between 0 and 4
     or p_policy_compliance not between 0 and 4
     or p_intent_coverage not between 0 and 4
     or p_luxury_tone not between 0 and 4
     or p_effort_reduction not between 0 and 4
     or p_clarity_actionability not between 0 and 4
     or p_language_fit not between 0 and 4
     or p_concision_naturalness not between 0 and 4 then
    raise exception 'every review score must be between 0 and 4';
  end if;

  select item.id
    into v_outbox_id
  from public.ai_outbox as item
  join public.ai_messages as message on message.id = item.source_message_id
  where item.source_message_id = p_source_message_id
    and item.target_type = 'client'
    and item.status = 'shadowed'
    and message.direction = 'inbound'
  order by item.created_at desc
  limit 1;

  if v_outbox_id is null then
    raise exception 'source message does not have a shadowed client reply candidate';
  end if;

  v_overall := round((
    p_factual_accuracy +
    p_safety_compliance +
    p_policy_compliance +
    p_intent_coverage +
    p_luxury_tone +
    p_effort_reduction +
    p_clarity_actionability +
    p_language_fit +
    p_concision_naturalness
  )::numeric / 9, 2);

  if jsonb_array_length(v_flags) > 0
     or p_factual_accuracy < 4
     or p_safety_compliance < 4
     or p_policy_compliance < 4 then
    v_verdict := 'fail';
  elsif v_overall >= 3.50
     and p_intent_coverage >= 3
     and p_luxury_tone >= 3
     and p_effort_reduction >= 3
     and p_clarity_actionability >= 3
     and p_language_fit >= 3
     and p_concision_naturalness >= 3 then
    v_verdict := 'pass';
  else
    v_verdict := 'needs_review';
  end if;

  insert into public.ai_shadow_reviews (
    source_message_id,
    outbox_id,
    reviewer_type,
    reviewer_id,
    rubric_version,
    case_type,
    include_in_launch_metrics,
    factual_accuracy,
    safety_compliance,
    policy_compliance,
    intent_coverage,
    luxury_tone,
    effort_reduction,
    clarity_actionability,
    language_fit,
    concision_naturalness,
    overall_score,
    verdict,
    critical_flags,
    notes,
    corrected_reply,
    reviewed_at,
    updated_at
  ) values (
    p_source_message_id,
    v_outbox_id,
    p_reviewer_type,
    trim(p_reviewer_id),
    trim(p_rubric_version),
    p_case_type,
    coalesce(p_include_in_launch_metrics, false),
    p_factual_accuracy,
    p_safety_compliance,
    p_policy_compliance,
    p_intent_coverage,
    p_luxury_tone,
    p_effort_reduction,
    p_clarity_actionability,
    p_language_fit,
    p_concision_naturalness,
    v_overall,
    v_verdict,
    v_flags,
    coalesce(p_notes, ''),
    nullif(trim(coalesce(p_corrected_reply, '')), ''),
    now(),
    now()
  )
  on conflict (source_message_id, reviewer_type, reviewer_id, rubric_version)
  do update set
    outbox_id = excluded.outbox_id,
    case_type = excluded.case_type,
    include_in_launch_metrics = excluded.include_in_launch_metrics,
    factual_accuracy = excluded.factual_accuracy,
    safety_compliance = excluded.safety_compliance,
    policy_compliance = excluded.policy_compliance,
    intent_coverage = excluded.intent_coverage,
    luxury_tone = excluded.luxury_tone,
    effort_reduction = excluded.effort_reduction,
    clarity_actionability = excluded.clarity_actionability,
    language_fit = excluded.language_fit,
    concision_naturalness = excluded.concision_naturalness,
    overall_score = excluded.overall_score,
    verdict = excluded.verdict,
    critical_flags = excluded.critical_flags,
    notes = excluded.notes,
    corrected_reply = excluded.corrected_reply,
    reviewed_at = now(),
    updated_at = now()
  returning id into v_review_id;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    case when p_reviewer_type = 'human' then 'management' else 'ai' end,
    trim(p_reviewer_id),
    'shadow_quality_review_recorded',
    'message',
    p_source_message_id::text,
    jsonb_build_object(
      'reviewId', v_review_id,
      'rubricVersion', trim(p_rubric_version),
      'caseType', p_case_type,
      'includeInLaunchMetrics', coalesce(p_include_in_launch_metrics, false),
      'overallScore', v_overall,
      'verdict', v_verdict,
      'criticalFlagCount', jsonb_array_length(v_flags)
    )
  );

  return jsonb_build_object(
    'reviewId', v_review_id,
    'outboxId', v_outbox_id,
    'overallScore', v_overall,
    'verdict', v_verdict
  );
end;
$$;

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

create or replace function public.ai_shadow_quality_snapshot(
  p_since timestamptz default now() - interval '7 days'
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select
      message.id as source_message_id,
      item.id as outbox_id,
      item.provider_message_id,
      response_decision.latency_ms as response_latency_ms,
      verifier_decision.latency_ms as verifier_latency_ms
    from public.ai_messages as message
    join public.ai_jobs as job
      on job.source_message_id = message.id
     and job.status = 'completed'
    join public.ai_outbox as item
      on item.source_message_id = message.id
     and item.target_type = 'client'
     and item.status = 'shadowed'
    left join lateral (
      select decision.latency_ms
      from public.ai_decisions as decision
      where decision.source_message_id = message.id
        and decision.stage = 'response'
      order by decision.created_at desc
      limit 1
    ) as response_decision on true
    left join lateral (
      select decision.latency_ms
      from public.ai_decisions as decision
      where decision.source_message_id = message.id
        and decision.stage = 'verification'
      order by decision.created_at desc
      limit 1
    ) as verifier_decision on true
    where message.direction = 'inbound'
      and message.created_at >= coalesce(p_since, now() - interval '7 days')
  ),
  latest_human_review as (
    select distinct on (review.source_message_id)
      review.*
    from public.ai_shadow_reviews as review
    join eligible on eligible.source_message_id = review.source_message_id
    where review.reviewer_type = 'human'
    order by review.source_message_id, review.reviewed_at desc
  ),
  reviewed as (
    select review.*
    from latest_human_review as review
    where review.include_in_launch_metrics
  ),
  duplicate_candidates as (
    select item.source_message_id
    from public.ai_outbox as item
    join eligible on eligible.source_message_id = item.source_message_id
    where item.target_type = 'client'
    group by item.source_message_id
    having count(*) > 1
  )
  select jsonb_build_object(
    'since', coalesce(p_since, now() - interval '7 days'),
    'eligibleCases', (select count(*) from eligible),
    'humanReviewedCases', (select count(*) from latest_human_review),
    'launchMetricCases', (select count(*) from reviewed),
    'unreviewedCases', greatest(
      (select count(*) from eligible) - (select count(*) from latest_human_review),
      0
    ),
    'passCases', (select count(*) from reviewed where verdict = 'pass'),
    'failCases', (select count(*) from reviewed where verdict = 'fail'),
    'needsReviewCases', (select count(*) from reviewed where verdict = 'needs_review'),
    'passRate', coalesce((
      select round(
        100.0 * count(*) filter (where verdict = 'pass') / nullif(count(*), 0),
        2
      )
      from reviewed
    ), 0),
    'criticalFlagCases', (
      select count(*)
      from reviewed
      where jsonb_array_length(critical_flags) > 0
    ),
    'averageOverallScore', coalesce((
      select round(avg(overall_score), 2) from reviewed
    ), 0),
    'dimensionAverages', jsonb_build_object(
      'factualAccuracy', coalesce((select round(avg(factual_accuracy), 2) from reviewed), 0),
      'safetyCompliance', coalesce((select round(avg(safety_compliance), 2) from reviewed), 0),
      'policyCompliance', coalesce((select round(avg(policy_compliance), 2) from reviewed), 0),
      'intentCoverage', coalesce((select round(avg(intent_coverage), 2) from reviewed), 0),
      'luxuryTone', coalesce((select round(avg(luxury_tone), 2) from reviewed), 0),
      'effortReduction', coalesce((select round(avg(effort_reduction), 2) from reviewed), 0),
      'clarityActionability', coalesce((select round(avg(clarity_actionability), 2) from reviewed), 0),
      'languageFit', coalesce((select round(avg(language_fit), 2) from reviewed), 0),
      'concisionNaturalness', coalesce((select round(avg(concision_naturalness), 2) from reviewed), 0)
    ),
    'latencyMs', jsonb_build_object(
      'responseP95', coalesce((
        select round(percentile_cont(0.95) within group (order by response_latency_ms)::numeric, 0)
        from eligible
        where response_latency_ms is not null
      ), 0),
      'verifierP95', coalesce((
        select round(percentile_cont(0.95) within group (order by verifier_latency_ms)::numeric, 0)
        from eligible
        where verifier_latency_ms is not null
      ), 0)
    ),
    'providerSendCount', (
      select count(*) from eligible where provider_message_id is not null
    ),
    'duplicateCandidateCases', (select count(*) from duplicate_candidates)
  );
$$;

revoke all on function public.ai_record_shadow_review(
  uuid, text, text, text, text, boolean,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  jsonb, text, text
) from public, anon, authenticated;
revoke all on function public.ai_list_shadow_review_queue(integer)
  from public, anon, authenticated;
revoke all on function public.ai_shadow_quality_snapshot(timestamptz)
  from public, anon, authenticated;

grant execute on function public.ai_record_shadow_review(
  uuid, text, text, text, text, boolean,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  jsonb, text, text
) to service_role;
grant execute on function public.ai_list_shadow_review_queue(integer)
  to service_role;
grant execute on function public.ai_shadow_quality_snapshot(timestamptz)
  to service_role;

commit;
