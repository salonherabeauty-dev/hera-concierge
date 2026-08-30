begin;

create table if not exists public.ai_client_turns_v3 (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  contact_id uuid not null references public.ai_contacts(id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'collecting'
    check (status in ('collecting', 'processing', 'ready', 'failed', 'superseded')),
  delivery_control text not null default 'human_only'
    check (delivery_control = 'human_only'),
  first_fragment_at timestamptz not null,
  last_fragment_at timestamptz not null,
  settle_at timestamptz not null,
  source_message_id uuid references public.ai_messages(id) on delete set null,
  last_fragment_message_id uuid not null references public.ai_messages(id) on delete restrict,
  consolidated_text text not null default '' check (length(consolidated_text) <= 24000),
  fragments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(fragments) = 'array' and jsonb_array_length(fragments) <= 40),
  model_attempts integer not null default 0 check (model_attempts between 0 and 2),
  candidate_id uuid,
  failure_code text,
  failure_message text,
  superseded_by_turn_id uuid references public.ai_client_turns_v3(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, version),
  check (first_fragment_at <= last_fragment_at),
  check (last_fragment_at <= settle_at),
  check (
    (status = 'ready' and candidate_id is not null and failure_code is null and failure_message is null)
    or (status = 'failed' and candidate_id is null and failure_code is not null and failure_message is not null)
    or (status = 'superseded' and candidate_id is null and superseded_by_turn_id is not null)
    or (status in ('collecting', 'processing') and candidate_id is null and failure_code is null and failure_message is null)
  )
);

create table if not exists public.ai_reply_candidates_v3 (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null unique references public.ai_client_turns_v3(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  contact_id uuid not null references public.ai_contacts(id) on delete cascade,
  source_message_id uuid references public.ai_messages(id) on delete set null,
  to_wa_id text not null check (to_wa_id ~ '^[1-9][0-9]{7,14}$'),
  body text not null check (length(btrim(body)) between 1 and 4000),
  body_hash text not null check (body_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'ready'
    check (status in ('ready', 'superseded', 'rejected', 'sent')),
  model_id text not null,
  model_attempts integer not null check (model_attempts between 1 and 2),
  evidence jsonb not null default '{}'::jsonb,
  validation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_client_turns_v3
  drop constraint if exists ai_client_turns_v3_candidate_id_fkey;
alter table public.ai_client_turns_v3
  add constraint ai_client_turns_v3_candidate_id_fkey
  foreign key (candidate_id) references public.ai_reply_candidates_v3(id) on delete set null;

create table if not exists public.ai_turn_jobs_v3 (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null unique references public.ai_client_turns_v3(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed', 'superseded')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  model_attempts integer not null default 0 check (model_attempts between 0 and 2),
  available_at timestamptz not null,
  locked_at timestamptz,
  locked_by text,
  candidate_id uuid references public.ai_reply_candidates_v3(id) on delete set null,
  failure_code text,
  failure_message text,
  superseded_by_turn_id uuid references public.ai_client_turns_v3(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'ready' and candidate_id is not null and failure_code is null and failure_message is null)
    or (status = 'failed' and candidate_id is null and failure_code is not null and failure_message is not null)
    or (status = 'superseded' and candidate_id is null and superseded_by_turn_id is not null)
    or (status in ('pending', 'processing') and candidate_id is null and failure_code is null and failure_message is null)
  )
);

create table if not exists public.ai_human_send_reservations_v3 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.ai_reply_candidates_v3(id) on delete restrict,
  turn_id uuid not null references public.ai_client_turns_v3(id) on delete restrict,
  conversation_id uuid not null references public.ai_conversations(id) on delete restrict,
  actor_user_id uuid not null,
  to_wa_id text not null check (to_wa_id ~ '^[1-9][0-9]{7,14}$'),
  final_text text not null check (length(btrim(final_text)) between 1 and 4000),
  candidate_hash text not null check (candidate_hash ~ '^[a-f0-9]{64}$'),
  final_hash text not null check (final_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'reserved'
    check (status in ('reserved', 'sent', 'failed')),
  provider_message_id text unique,
  failure_code text,
  reserved_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'reserved' and provider_message_id is null and completed_at is null)
    or (status = 'sent' and provider_message_id is not null and completed_at is not null)
    or (status = 'failed' and provider_message_id is null and failure_code is not null and completed_at is not null)
  )
);

create table if not exists public.ai_reset_proof_runs_v3 (
  id uuid primary key default gen_random_uuid(),
  proof_set text not null,
  case_id text not null,
  exact_commit text not null,
  status text not null check (status in ('running', 'passed', 'failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  model_calls integer not null default 0 check (model_calls between 0 and 2),
  provider_send_calls integer not null default 0 check (provider_send_calls = 0),
  timely_write_calls integer not null default 0 check (timely_write_calls = 0),
  failure_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (proof_set, case_id, exact_commit)
);

create unique index if not exists ai_client_turns_v3_one_active_turn
  on public.ai_client_turns_v3 (conversation_id)
  where status in ('collecting', 'processing', 'ready');
create index if not exists ai_client_turns_v3_settle_idx
  on public.ai_client_turns_v3 (status, settle_at);
create index if not exists ai_client_turns_v3_conversation_idx
  on public.ai_client_turns_v3 (conversation_id, version desc);
create index if not exists ai_turn_jobs_v3_claim_idx
  on public.ai_turn_jobs_v3 (status, available_at, created_at);
create index if not exists ai_reply_candidates_v3_conversation_idx
  on public.ai_reply_candidates_v3 (conversation_id, created_at desc);

alter table public.ai_client_turns_v3 enable row level security;
alter table public.ai_client_turns_v3 force row level security;
alter table public.ai_reply_candidates_v3 enable row level security;
alter table public.ai_reply_candidates_v3 force row level security;
alter table public.ai_turn_jobs_v3 enable row level security;
alter table public.ai_turn_jobs_v3 force row level security;
alter table public.ai_human_send_reservations_v3 enable row level security;
alter table public.ai_human_send_reservations_v3 force row level security;
alter table public.ai_reset_proof_runs_v3 enable row level security;
alter table public.ai_reset_proof_runs_v3 force row level security;

revoke all on public.ai_client_turns_v3 from public, anon, authenticated;
revoke all on public.ai_reply_candidates_v3 from public, anon, authenticated;
revoke all on public.ai_turn_jobs_v3 from public, anon, authenticated;
revoke all on public.ai_human_send_reservations_v3 from public, anon, authenticated;
revoke all on public.ai_reset_proof_runs_v3 from public, anon, authenticated;
grant all on public.ai_client_turns_v3 to service_role;
grant all on public.ai_reply_candidates_v3 to service_role;
grant all on public.ai_turn_jobs_v3 to service_role;
grant all on public.ai_human_send_reservations_v3 to service_role;
grant all on public.ai_reset_proof_runs_v3 to service_role;

create or replace function public.ai_append_client_turn_fragment_v3(
  p_conversation_id uuid,
  p_contact_id uuid,
  p_message_id uuid,
  p_kind text,
  p_text text,
  p_media jsonb,
  p_provider_timestamp timestamptz,
  p_raw jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.ai_client_turns_v3%rowtype;
  v_turn_id uuid;
  v_version integer;
  v_effective_at timestamptz := coalesce(p_provider_timestamp, now());
  v_settle_at timestamptz := greatest(coalesce(p_provider_timestamp, now()), now()) + interval '8 seconds';
  v_text text := btrim(coalesce(p_text, ''));
  v_substantive boolean;
  v_fragment jsonb;
  v_legacy_job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_conversation_id::text, 703));

  if not exists (
    select 1
    from public.ai_messages m
    where m.id = p_message_id
      and m.conversation_id = p_conversation_id
      and m.contact_id = p_contact_id
      and m.direction = 'inbound'
  ) then
    raise exception 'reset_v3_fragment_message_mismatch' using errcode = '23514';
  end if;

  v_substantive := p_kind not in ('reaction', 'system', 'unknown')
    or (
      p_kind = 'unknown'
      and v_text <> ''
      and v_text !~* '^\[unsupported (human )?whatsapp message (received|sent)\]$'
    );

  v_fragment := jsonb_build_object(
    'messageId', p_message_id,
    'kind', coalesce(p_kind, 'unknown'),
    'text', case when v_substantive then left(v_text, 12000) else null end,
    'media', coalesce(p_media, 'null'::jsonb),
    'providerTimestamp', v_effective_at,
    'readable', v_substantive,
    'rawType', coalesce(p_raw->>'type', p_kind, 'unknown')
  );

  select * into v_existing
  from public.ai_client_turns_v3
  where conversation_id = p_conversation_id
  order by version desc
  limit 1
  for update;

  if found
     and v_existing.status = 'collecting'
     and v_effective_at <= v_existing.last_fragment_at + interval '12 seconds'
  then
    update public.ai_client_turns_v3
    set last_fragment_at = greatest(last_fragment_at, v_effective_at),
        settle_at = greatest(v_settle_at, settle_at),
        last_fragment_message_id = p_message_id,
        source_message_id = case when v_substantive then p_message_id else source_message_id end,
        consolidated_text = case
          when not v_substantive then consolidated_text
          when consolidated_text = '' then left(v_text, 24000)
          else left(consolidated_text || E'\n' || v_text, 24000)
        end,
        fragments = fragments || jsonb_build_array(v_fragment),
        updated_at = now()
    where id = v_existing.id
    returning id into v_turn_id;

    update public.ai_turn_jobs_v3
    set available_at = v_settle_at,
        updated_at = now()
    where turn_id = v_turn_id
      and status = 'pending';
  else
    if found and v_existing.status in ('collecting', 'processing', 'ready') then
      update public.ai_reply_candidates_v3
      set status = 'superseded', updated_at = now()
      where id = v_existing.candidate_id and status = 'ready';

      update public.ai_client_turns_v3
      set status = 'superseded',
          candidate_id = null,
          failure_code = null,
          failure_message = null,
          updated_at = now()
      where id = v_existing.id;
    end if;

    select coalesce(max(version), 0) + 1 into v_version
    from public.ai_client_turns_v3
    where conversation_id = p_conversation_id;

    insert into public.ai_client_turns_v3 (
      conversation_id,
      contact_id,
      version,
      status,
      delivery_control,
      first_fragment_at,
      last_fragment_at,
      settle_at,
      source_message_id,
      last_fragment_message_id,
      consolidated_text,
      fragments
    ) values (
      p_conversation_id,
      p_contact_id,
      v_version,
      'collecting',
      'human_only',
      v_effective_at,
      v_effective_at,
      v_settle_at,
      case when v_substantive then p_message_id else null end,
      p_message_id,
      case when v_substantive then left(v_text, 24000) else '' end,
      jsonb_build_array(v_fragment)
    ) returning id into v_turn_id;

    insert into public.ai_turn_jobs_v3 (turn_id, status, available_at)
    values (v_turn_id, 'pending', v_settle_at);

    if found and v_existing.status in ('collecting', 'processing', 'ready') then
      update public.ai_client_turns_v3
      set superseded_by_turn_id = v_turn_id, updated_at = now()
      where id = v_existing.id;

      update public.ai_turn_jobs_v3
      set status = 'superseded',
          candidate_id = null,
          failure_code = null,
          failure_message = null,
          superseded_by_turn_id = v_turn_id,
          locked_at = null,
          locked_by = null,
          updated_at = now()
      where turn_id = v_existing.id
        and status in ('pending', 'processing', 'ready');
    end if;
  end if;

  select j.id into v_legacy_job_id
  from public.ai_jobs j
  where j.source_message_id = p_message_id
    and j.status in ('pending', 'retry', 'processing')
  order by j.created_at desc
  limit 1;

  if v_legacy_job_id is not null then
    update public.ai_jobs
    set status = 'completed',
        completed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = 'superseded_by_receptionist_reset_v3',
        updated_at = now()
    where id = v_legacy_job_id;
  end if;

  return jsonb_build_object(
    'turnId', v_turn_id,
    'status', 'collecting',
    'settleAt', v_settle_at,
    'substantive', v_substantive,
    'legacyJobSuppressed', v_legacy_job_id is not null
  );
end;
$$;

create or replace function public.ai_claim_turn_jobs_v3(
  p_worker_id text,
  p_limit integer default 5,
  p_turn_ids uuid[] default null
) returns table (
  job_id uuid,
  turn_id uuid,
  conversation_id uuid,
  contact_id uuid,
  version integer,
  source_message_id uuid,
  last_fragment_message_id uuid,
  consolidated_text text,
  fragments jsonb,
  first_fragment_at timestamptz,
  last_fragment_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with selected as (
    select j.id
    from public.ai_turn_jobs_v3 j
    join public.ai_client_turns_v3 t on t.id = j.turn_id
    where j.status in ('pending', 'processing')
      and (
        (j.status = 'pending' and j.available_at <= now())
        or (j.status = 'processing' and j.locked_at < now() - interval '6 minutes')
      )
      and t.status in ('collecting', 'processing')
      and t.settle_at <= now()
      and (p_turn_ids is null or j.turn_id = any(p_turn_ids))
    order by j.available_at, j.created_at
    for update of j skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), claimed as (
    update public.ai_turn_jobs_v3 j
    set status = 'processing',
        attempts = j.attempts + 1,
        locked_at = now(),
        locked_by = left(coalesce(p_worker_id, ''), 160),
        updated_at = now()
    from selected s
    where j.id = s.id
    returning j.*
  ), turns as (
    update public.ai_client_turns_v3 t
    set status = 'processing', updated_at = now()
    from claimed c
    where t.id = c.turn_id
      and t.status in ('collecting', 'processing')
    returning t.*
  )
  select
    c.id,
    t.id,
    t.conversation_id,
    t.contact_id,
    t.version,
    t.source_message_id,
    t.last_fragment_message_id,
    t.consolidated_text,
    t.fragments,
    t.first_fragment_at,
    t.last_fragment_at,
    c.attempts
  from claimed c
  join turns t on t.id = c.turn_id;
end;
$$;

create or replace function public.ai_finish_turn_ready_v3(
  p_job_id uuid,
  p_turn_id uuid,
  p_model_id text,
  p_model_attempts integer,
  p_body text,
  p_evidence jsonb,
  p_validation jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_candidate_id uuid;
  v_wa_id text;
  v_latest_turn_id uuid;
  v_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_turn_id::text, 709));

  select * into strict v_turn
  from public.ai_client_turns_v3
  where id = p_turn_id
  for update;

  select * into strict v_job
  from public.ai_turn_jobs_v3
  where id = p_job_id and turn_id = p_turn_id
  for update;

  select id into v_latest_turn_id
  from public.ai_client_turns_v3
  where conversation_id = v_turn.conversation_id
  order by version desc
  limit 1;

  if v_latest_turn_id is distinct from p_turn_id
     or v_turn.status = 'superseded'
     or v_job.status = 'superseded'
  then
    update public.ai_turn_jobs_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = v_latest_turn_id,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = p_job_id;
    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  if v_turn.status <> 'processing' or v_job.status <> 'processing' then
    raise exception 'reset_v3_turn_not_processing' using errcode = '23514';
  end if;
  if p_model_attempts not between 1 and 2 then
    raise exception 'reset_v3_model_attempt_limit' using errcode = '23514';
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception 'reset_v3_candidate_body_invalid' using errcode = '23514';
  end if;

  select wa_id into strict v_wa_id
  from public.ai_contacts
  where id = v_turn.contact_id;

  v_hash := pg_catalog.encode(extensions.digest(btrim(p_body), 'sha256'), 'hex');

  insert into public.ai_reply_candidates_v3 (
    turn_id,
    conversation_id,
    contact_id,
    source_message_id,
    to_wa_id,
    body,
    body_hash,
    status,
    model_id,
    model_attempts,
    evidence,
    validation
  ) values (
    p_turn_id,
    v_turn.conversation_id,
    v_turn.contact_id,
    coalesce(v_turn.source_message_id, v_turn.last_fragment_message_id),
    v_wa_id,
    btrim(p_body),
    v_hash,
    'ready',
    left(coalesce(p_model_id, 'openai/gpt-5.6-sol'), 160),
    p_model_attempts,
    coalesce(p_evidence, '{}'::jsonb),
    coalesce(p_validation, '{}'::jsonb)
  )
  on conflict (turn_id) do update
    set body = excluded.body,
        body_hash = excluded.body_hash,
        status = 'ready',
        model_id = excluded.model_id,
        model_attempts = excluded.model_attempts,
        evidence = excluded.evidence,
        validation = excluded.validation,
        updated_at = now()
  returning id into v_candidate_id;

  update public.ai_client_turns_v3
  set status = 'ready',
      candidate_id = v_candidate_id,
      model_attempts = p_model_attempts,
      failure_code = null,
      failure_message = null,
      updated_at = now()
  where id = p_turn_id;

  update public.ai_turn_jobs_v3
  set status = 'ready',
      candidate_id = v_candidate_id,
      model_attempts = p_model_attempts,
      failure_code = null,
      failure_message = null,
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'receptionist_reset_v3',
    'reset_v3_editable_candidate_ready',
    'reply_candidate_v3',
    v_candidate_id::text,
    jsonb_build_object(
      'turnId', p_turn_id,
      'conversationId', v_turn.conversation_id,
      'modelId', p_model_id,
      'modelAttempts', p_model_attempts,
      'deliveryControl', 'human_only',
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'ready',
    'candidateId', v_candidate_id,
    'candidateHash', v_hash
  );
end;
$$;

create or replace function public.ai_finish_turn_failed_v3(
  p_job_id uuid,
  p_turn_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_model_attempts integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := left(regexp_replace(lower(coalesce(p_failure_code, 'draft_failed')), '[^a-z0-9_]+', '_', 'g'), 120);
  v_message text := left(btrim(coalesce(p_failure_message, 'The AI could not prepare this reply.')), 500);
begin
  if v_code = '' or v_message = '' or p_model_attempts not between 0 and 2 then
    raise exception 'reset_v3_failure_invalid' using errcode = '23514';
  end if;

  update public.ai_client_turns_v3
  set status = 'failed',
      candidate_id = null,
      failure_code = v_code,
      failure_message = v_message,
      model_attempts = p_model_attempts,
      updated_at = now()
  where id = p_turn_id
    and status in ('collecting', 'processing');

  update public.ai_turn_jobs_v3
  set status = 'failed',
      candidate_id = null,
      failure_code = v_code,
      failure_message = v_message,
      model_attempts = p_model_attempts,
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id
    and turn_id = p_turn_id
    and status in ('pending', 'processing');

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'receptionist_reset_v3',
    'reset_v3_draft_failed_visible',
    'client_turn_v3',
    p_turn_id::text,
    jsonb_build_object(
      'failureCode', v_code,
      'failureMessage', v_message,
      'modelAttempts', p_model_attempts,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object('ok', true, 'state', 'failed', 'failureCode', v_code);
end;
$$;

create or replace function public.ai_retry_turn_v3(
  p_turn_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_client_turns_v3%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_turn_id::text, 719));
  select * into strict v_turn
  from public.ai_client_turns_v3
  where id = p_turn_id
  for update;

  if v_turn.status not in ('failed', 'ready') then
    return jsonb_build_object('ok', false, 'state', v_turn.status, 'code', 'turn_not_retryable');
  end if;

  update public.ai_reply_candidates_v3
  set status = 'superseded', updated_at = now()
  where turn_id = p_turn_id and status = 'ready';

  update public.ai_client_turns_v3
  set status = 'collecting',
      candidate_id = null,
      failure_code = null,
      failure_message = null,
      model_attempts = 0,
      settle_at = now(),
      updated_at = now()
  where id = p_turn_id;

  insert into public.ai_turn_jobs_v3 (turn_id, status, attempts, model_attempts, available_at)
  values (p_turn_id, 'pending', 0, 0, now())
  on conflict (turn_id) do update
    set status = 'pending',
        attempts = 0,
        model_attempts = 0,
        available_at = now(),
        locked_at = null,
        locked_by = null,
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = null,
        updated_at = now();

  return jsonb_build_object('ok', true, 'state', 'pending', 'turnId', p_turn_id);
end;
$$;

create or replace function public.ai_reserve_human_send_v3(
  p_actor_user_id uuid,
  p_candidate_id uuid,
  p_expected_turn_id uuid,
  p_expected_turn_version integer,
  p_expected_candidate_hash text,
  p_expected_phone_ending text,
  p_final_text text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.ai_reply_candidates_v3%rowtype;
  v_turn public.ai_client_turns_v3%rowtype;
  v_latest_turn_id uuid;
  v_reservation public.ai_human_send_reservations_v3%rowtype;
  v_final_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text, 727));

  select * into strict v_candidate
  from public.ai_reply_candidates_v3
  where id = p_candidate_id
  for update;

  select * into strict v_turn
  from public.ai_client_turns_v3
  where id = v_candidate.turn_id
  for update;

  if v_turn.id is distinct from p_expected_turn_id
     or v_turn.version is distinct from p_expected_turn_version
  then
    return jsonb_build_object('ok', false, 'code', 'turn_version_mismatch');
  end if;
  if v_candidate.body_hash is distinct from p_expected_candidate_hash then
    return jsonb_build_object('ok', false, 'code', 'candidate_hash_mismatch');
  end if;
  if right(v_candidate.to_wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;
  if v_candidate.status <> 'ready' or v_turn.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;
  if now() - v_turn.last_fragment_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'customer_service_window_expired');
  end if;

  select id into v_latest_turn_id
  from public.ai_client_turns_v3
  where conversation_id = v_turn.conversation_id
  order by version desc
  limit 1;
  if v_latest_turn_id is distinct from v_turn.id then
    return jsonb_build_object('ok', false, 'code', 'source_turn_not_latest');
  end if;

  if length(btrim(coalesce(p_final_text, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'code', 'final_text_invalid');
  end if;
  if public.ai_tanglin_whatsapp_reply_violation(p_final_text) is not null then
    return jsonb_build_object('ok', false, 'code', 'tanglin_channel_violation');
  end if;

  select * into v_reservation
  from public.ai_human_send_reservations_v3
  where candidate_id = p_candidate_id;
  if found then
    return jsonb_build_object(
      'ok', v_reservation.status = 'sent',
      'state', v_reservation.status,
      'code', case when v_reservation.status = 'sent' then null else 'send_already_reserved' end,
      'reservationId', v_reservation.id,
      'providerMessageId', v_reservation.provider_message_id
    );
  end if;

  v_final_hash := pg_catalog.encode(extensions.digest(btrim(p_final_text), 'sha256'), 'hex');

  insert into public.ai_human_send_reservations_v3 (
    candidate_id,
    turn_id,
    conversation_id,
    actor_user_id,
    to_wa_id,
    final_text,
    candidate_hash,
    final_hash,
    status
  ) values (
    v_candidate.id,
    v_turn.id,
    v_turn.conversation_id,
    p_actor_user_id,
    v_candidate.to_wa_id,
    btrim(p_final_text),
    v_candidate.body_hash,
    v_final_hash,
    'reserved'
  ) returning * into v_reservation;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    p_actor_user_id::text,
    'reset_v3_human_send_reserved',
    'reply_candidate_v3',
    v_candidate.id::text,
    jsonb_build_object(
      'turnId', v_turn.id,
      'conversationId', v_turn.conversation_id,
      'recipientEnding', right(v_candidate.to_wa_id, 4),
      'editedByHuman', v_final_hash <> v_candidate.body_hash,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'reserved',
    'reservationId', v_reservation.id,
    'toWaId', v_reservation.to_wa_id,
    'messageText', v_reservation.final_text,
    'finalHash', v_reservation.final_hash,
    'editedByHuman', v_final_hash <> v_candidate.body_hash
  );
end;
$$;

create or replace function public.ai_complete_human_send_v3(
  p_reservation_id uuid,
  p_provider_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.ai_human_send_reservations_v3%rowtype;
begin
  select * into strict v_reservation
  from public.ai_human_send_reservations_v3
  where id = p_reservation_id
  for update;

  if v_reservation.status = 'sent' then
    return jsonb_build_object('ok', true, 'state', 'sent', 'providerMessageId', v_reservation.provider_message_id);
  end if;
  if v_reservation.status <> 'reserved' or btrim(coalesce(p_provider_message_id, '')) = '' then
    return jsonb_build_object('ok', false, 'code', 'send_completion_invalid');
  end if;

  update public.ai_human_send_reservations_v3
  set status = 'sent',
      provider_message_id = left(p_provider_message_id, 300),
      completed_at = now(),
      updated_at = now()
  where id = p_reservation_id;

  update public.ai_reply_candidates_v3
  set status = 'sent', updated_at = now()
  where id = v_reservation.candidate_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    v_reservation.actor_user_id::text,
    'reset_v3_human_send_completed',
    'reply_candidate_v3',
    v_reservation.candidate_id::text,
    jsonb_build_object(
      'reservationId', p_reservation_id,
      'providerMessageId', left(p_provider_message_id, 300),
      'conversationId', v_reservation.conversation_id,
      'recipientEnding', right(v_reservation.to_wa_id, 4)
    )
  );

  return jsonb_build_object('ok', true, 'state', 'sent', 'providerMessageId', left(p_provider_message_id, 300));
end;
$$;

create or replace function public.ai_fail_human_send_v3(
  p_reservation_id uuid,
  p_failure_code text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_human_send_reservations_v3
  set status = 'failed',
      failure_code = left(regexp_replace(lower(coalesce(p_failure_code, 'provider_send_failed')), '[^a-z0-9_]+', '_', 'g'), 120),
      completed_at = now(),
      updated_at = now()
  where id = p_reservation_id and status = 'reserved';

  return jsonb_build_object('ok', true, 'state', 'failed');
end;
$$;

revoke all on function public.ai_append_client_turn_fragment_v3(uuid, uuid, uuid, text, text, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.ai_claim_turn_jobs_v3(text, integer, uuid[])
  from public, anon, authenticated;
revoke all on function public.ai_finish_turn_ready_v3(uuid, uuid, text, integer, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.ai_finish_turn_failed_v3(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_retry_turn_v3(uuid)
  from public, anon, authenticated;
revoke all on function public.ai_reserve_human_send_v3(uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated;
revoke all on function public.ai_complete_human_send_v3(uuid, text)
  from public, anon, authenticated;
revoke all on function public.ai_fail_human_send_v3(uuid, text)
  from public, anon, authenticated;

grant execute on function public.ai_append_client_turn_fragment_v3(uuid, uuid, uuid, text, text, jsonb, timestamptz, jsonb)
  to service_role;
grant execute on function public.ai_claim_turn_jobs_v3(text, integer, uuid[])
  to service_role;
grant execute on function public.ai_finish_turn_ready_v3(uuid, uuid, text, integer, text, jsonb, jsonb)
  to service_role;
grant execute on function public.ai_finish_turn_failed_v3(uuid, uuid, text, text, integer)
  to service_role;
grant execute on function public.ai_retry_turn_v3(uuid)
  to service_role;
grant execute on function public.ai_reserve_human_send_v3(uuid, uuid, uuid, integer, text, text, text)
  to service_role;
grant execute on function public.ai_complete_human_send_v3(uuid, text)
  to service_role;
grant execute on function public.ai_fail_human_send_v3(uuid, text)
  to service_role;

commit;
