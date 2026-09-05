begin;

-- Canonicalise the bounded generation counters already used by Reset-v3 and
-- add a durable, one-use receipt for every staff-authorised paid generation.
alter table public.ai_client_turns_v3
  add column if not exists generation_runs integer not null default 0,
  add column if not exists superseded_reason text;
alter table public.ai_client_turns_v3
  drop constraint if exists ai_client_turns_v3_generation_runs_check;
alter table public.ai_client_turns_v3
  add constraint ai_client_turns_v3_generation_runs_check
  check (generation_runs between 0 and 2);

alter table public.ai_turn_jobs_v3
  add column if not exists generation_run integer not null default 0,
  add column if not exists superseded_reason text,
  add column if not exists authorized_generation_run integer,
  add column if not exists generation_request_id uuid,
  add column if not exists generation_authorized_at timestamptz,
  add column if not exists generation_authorized_by uuid,
  add column if not exists generation_authorized_last_fragment_message_id uuid,
  add column if not exists generation_authorized_turn_content_hash text,
  add column if not exists generation_authorized_conversation_context jsonb,
  add column if not exists generation_authorization_consumed_at timestamptz;

alter table public.ai_turn_jobs_v3
  drop constraint if exists ai_turn_jobs_v3_generation_run_check;
alter table public.ai_turn_jobs_v3
  add constraint ai_turn_jobs_v3_generation_run_check
  check (generation_run between 0 and 2);
alter table public.ai_turn_jobs_v3
  drop constraint if exists ai_turn_jobs_v3_generation_authorization_shape;
alter table public.ai_turn_jobs_v3
  add constraint ai_turn_jobs_v3_generation_authorization_shape check (
    (
      authorized_generation_run is null
      and generation_request_id is null
      and generation_authorized_at is null
      and generation_authorized_by is null
      and generation_authorized_last_fragment_message_id is null
      and generation_authorized_turn_content_hash is null
      and generation_authorized_conversation_context is null
      and generation_authorization_consumed_at is null
    )
    or (
      authorized_generation_run is not null
      and authorized_generation_run between 1 and 2
      and generation_request_id is not null
      and generation_authorized_at is not null
      and generation_authorized_by is not null
      and generation_authorized_last_fragment_message_id is not null
      and generation_authorized_turn_content_hash is not null
      and generation_authorized_turn_content_hash ~ '^[0-9a-f]{64}$'
      and generation_authorized_conversation_context is not null
      and case
        when jsonb_typeof(generation_authorized_conversation_context) = 'array'
          then jsonb_array_length(generation_authorized_conversation_context) <= 20
        else false
      end
      and (
        (
          generation_authorization_consumed_at is null
          and authorized_generation_run = generation_run + 1
        )
        or (
          generation_authorization_consumed_at is not null
          and generation_authorization_consumed_at >= generation_authorized_at
          and authorized_generation_run = generation_run
        )
      )
    )
  );

-- Canonicalise the superseded terminal shape across the checked-in schema and
-- the live staging drift. Historical rows remain valid whether they identify a
-- successor turn or record a terminal reason such as answered_by_human.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.ai_client_turns_v3'::regclass
      and constraint_row.contype = 'c'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        like '%status%candidate_id%failure_code%'
  loop
    execute pg_catalog.format(
      'alter table public.ai_client_turns_v3 drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.ai_client_turns_v3
  drop constraint if exists ai_client_turns_v3_terminal_shape;
alter table public.ai_client_turns_v3
  add constraint ai_client_turns_v3_terminal_shape check (
    (status = 'ready' and candidate_id is not null and failure_code is null and failure_message is null and superseded_reason is null)
    or (status = 'failed' and candidate_id is null and failure_code is not null and failure_message is not null and superseded_reason is null)
    -- The successor is assigned later in the append transaction. The deferred
    -- validator below enforces successor-or-reason on the committed row.
    or (status = 'superseded' and candidate_id is null)
    or (status in ('collecting', 'processing') and candidate_id is null and failure_code is null and failure_message is null and superseded_reason is null)
  );

do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select constraint_row.conname
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.ai_turn_jobs_v3'::regclass
      and constraint_row.contype = 'c'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        like '%status%candidate_id%failure_code%'
  loop
    execute pg_catalog.format(
      'alter table public.ai_turn_jobs_v3 drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.ai_turn_jobs_v3
  drop constraint if exists ai_turn_jobs_v3_terminal_shape;
alter table public.ai_turn_jobs_v3
  add constraint ai_turn_jobs_v3_terminal_shape check (
    (status = 'ready' and candidate_id is not null and failure_code is null and failure_message is null and superseded_reason is null)
    or (status = 'failed' and candidate_id is null and failure_code is not null and failure_message is not null and superseded_reason is null)
    or (
      status = 'superseded'
      and candidate_id is null
      and (superseded_by_turn_id is not null or superseded_reason is not null)
    )
    or (status in ('pending', 'processing') and candidate_id is null and failure_code is null and failure_message is null and superseded_reason is null)
  );

-- Deferred validation must inspect the row's final transaction state. The
-- append RPC first marks a turn superseded and assigns its successor later in
-- the same transaction, so validating the queued trigger event's stale NEW
-- tuple would reject a valid transition.
create or replace function public.ai_validate_client_turn_v3_deferred()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_superseded_by_turn_id uuid;
  v_superseded_reason text;
begin
  select turn.status, turn.superseded_by_turn_id, turn.superseded_reason
    into v_status, v_superseded_by_turn_id, v_superseded_reason
  from public.ai_client_turns_v3 as turn
  where turn.id = new.id;

  -- A concurrently deleted row has no terminal state left to validate.
  if not found then
    return null;
  end if;
  if v_status = 'superseded'
     and v_superseded_by_turn_id is null
     and v_superseded_reason is null
  then
    raise exception 'reset_v3_superseded_turn_requires_successor_or_reason'
      using errcode = '23514';
  end if;
  if v_status <> 'superseded' and v_superseded_by_turn_id is not null then
    raise exception 'reset_v3_non_superseded_turn_cannot_name_successor'
      using errcode = '23514';
  end if;
  if v_status <> 'superseded' and v_superseded_reason is not null then
    raise exception 'reset_v3_non_superseded_turn_cannot_have_superseded_reason'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists ai_validate_client_turn_v3_deferred
  on public.ai_client_turns_v3;
create constraint trigger ai_validate_client_turn_v3_deferred
after insert or update of status, superseded_by_turn_id, superseded_reason
on public.ai_client_turns_v3
deferrable initially deferred
for each row
execute function public.ai_validate_client_turn_v3_deferred();

create unique index if not exists ai_turn_jobs_v3_generation_request_id_idx
  on public.ai_turn_jobs_v3 (generation_request_id)
  where generation_request_id is not null;

-- The job row is deliberately reused for the single staff-approved retry, so
-- keep an immutable one-use ledger of every authorization request UUID.
create unique index if not exists ai_generation_authorization_request_audit_idx
  on public.ai_audit_log ((details ->> 'requestId'))
  where event_type in (
    'reset_v3_generation_authorized',
    'reset_v3_retry_generation_authorized'
  ) and details ? 'requestId';

create or replace function public.ai_protect_generation_authorization_audit_v3()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.event_type in (
       'reset_v3_generation_authorized',
       'reset_v3_retry_generation_authorized'
     )
  then
    raise exception 'reset_v3_generation_authorization_audit_is_immutable'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.event_type in (
       'reset_v3_generation_authorized',
       'reset_v3_retry_generation_authorized'
     )
  then
    raise exception 'reset_v3_generation_authorization_audit_is_immutable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists ai_protect_generation_authorization_audit_v3
  on public.ai_audit_log;
create trigger ai_protect_generation_authorization_audit_v3
before update or delete on public.ai_audit_log
for each row
execute function public.ai_protect_generation_authorization_audit_v3();

-- A generation receipt approves the exact content visible at the staff click.
-- If another in-window WhatsApp fragment changes that collecting turn, revoke
-- the unused receipt in the same transaction so it can never become claimable
-- merely because the new settling delay later expires.
create or replace function public.ai_invalidate_generation_authorization_on_turn_change_v3()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_job public.ai_turn_jobs_v3%rowtype;
begin
  select job.* into v_job
  from public.ai_turn_jobs_v3 as job
  where job.turn_id = new.id
    and job.status = 'pending'
    and job.generation_request_id is not null
    and job.generation_authorization_consumed_at is null
  for update;

  if not found then return new; end if;

  update public.ai_turn_jobs_v3
  set status = case when v_job.generation_run >= 1 then 'failed' else status end,
      candidate_id = null,
      failure_code = case
        when v_job.generation_run >= 1 then 'turn_changed_after_retry_authorization'
        else null
      end,
      failure_message = case
        when v_job.generation_run >= 1
          then 'The client sent another message before the retry started. Review the updated request, then retry again or write manually.'
        else null
      end,
      superseded_by_turn_id = null,
      superseded_reason = null,
      locked_at = null,
      locked_by = null,
      authorized_generation_run = null,
      generation_request_id = null,
      generation_authorized_at = null,
      generation_authorized_by = null,
      generation_authorized_last_fragment_message_id = null,
      generation_authorized_turn_content_hash = null,
      generation_authorized_conversation_context = null,
      generation_authorization_consumed_at = null,
      updated_at = now()
  where id = v_job.id;

  -- Run 1 was not consumed, so collecting/pending remains eligible for a new
  -- Generate click. For an unused run-2 authorization, expose a failed state
  -- so the still-unconsumed single retry can be explicitly re-authorized.
  if v_job.generation_run >= 1 then
    update public.ai_client_turns_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'turn_changed_after_retry_authorization',
        failure_message = 'The client sent another message before the retry started. Review the updated request, then retry again or write manually.',
        superseded_reason = null,
        updated_at = now()
    where id = new.id;
  end if;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'receptionist_reset_v3',
    'reset_v3_generation_authorization_invalidated',
    'client_turn_v3',
    new.id::text,
    jsonb_build_object(
      'requestId', v_job.generation_request_id,
      'generationRun', v_job.authorized_generation_run,
      'authorizedBy', v_job.generation_authorized_by,
      'authorizedLastFragmentMessageId', v_job.generation_authorized_last_fragment_message_id,
      'currentLastFragmentMessageId', new.last_fragment_message_id,
      'authorizedTurnContentHash', v_job.generation_authorized_turn_content_hash,
      'reason', 'turn_content_changed_after_staff_review',
      'modelCallStarted', false,
      'automaticGenerationAllowed', false,
      'automaticDeliveryAllowed', false
    )
  );

  return new;
end;
$$;

drop trigger if exists ai_invalidate_generation_authorization_on_turn_change_v3
  on public.ai_client_turns_v3;
create trigger ai_invalidate_generation_authorization_on_turn_change_v3
after update of consolidated_text, fragments, source_message_id,
  last_fragment_message_id, first_fragment_at, last_fragment_at
on public.ai_client_turns_v3
for each row
when (
  old.consolidated_text is distinct from new.consolidated_text
  or old.fragments is distinct from new.fragments
  or old.source_message_id is distinct from new.source_message_id
  or old.last_fragment_message_id is distinct from new.last_fragment_message_id
  or old.first_fragment_at is distinct from new.first_fragment_at
  or old.last_fragment_at is distinct from new.last_fragment_at
)
execute function public.ai_invalidate_generation_authorization_on_turn_change_v3();

-- Ingest and suppress the legacy process_inbound job in one database
-- transaction. This removes the interval in which a legacy worker could claim
-- the job between webhook ingestion and Reset-v3 turn assembly.
create or replace function public.ai_ingest_whatsapp_message_reset_v3(
  p_provider_message_id text,
  p_wa_id text,
  p_profile_name text,
  p_phone_number_id text,
  p_business_account_id text,
  p_kind text,
  p_text text,
  p_media jsonb,
  p_context_message_id text,
  p_provider_timestamp timestamptz,
  p_raw jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_append_result jsonb := '{}'::jsonb;
  v_job_id uuid;
  v_message_id uuid;
  v_conversation_id uuid;
  v_contact_id uuid;
  v_inserted boolean := false;
begin
  v_result := public.ai_ingest_whatsapp_message(
    p_provider_message_id,
    p_wa_id,
    p_profile_name,
    p_phone_number_id,
    p_business_account_id,
    p_kind,
    p_text,
    p_media,
    p_context_message_id,
    p_provider_timestamp,
    p_raw
  );

  if nullif(v_result->>'jobId', '') is not null then
    v_job_id := (v_result->>'jobId')::uuid;
  end if;
  if nullif(v_result->>'messageId', '') is not null then
    v_message_id := (v_result->>'messageId')::uuid;
  end if;
  if nullif(v_result->>'conversationId', '') is not null then
    v_conversation_id := (v_result->>'conversationId')::uuid;
  end if;
  if nullif(v_result->>'contactId', '') is not null then
    v_contact_id := (v_result->>'contactId')::uuid;
  end if;
  v_inserted := coalesce(nullif(v_result->>'inserted', '')::boolean, false);

  if v_inserted then
    if v_message_id is null or v_conversation_id is null or v_contact_id is null then
      raise exception 'reset_v3_atomic_ingest_result_invalid'
        using errcode = '23514';
    end if;

    v_append_result := public.ai_append_client_turn_fragment_v3(
      v_conversation_id,
      v_contact_id,
      v_message_id,
      p_kind,
      p_text,
      p_media,
      p_provider_timestamp,
      p_raw
    );
  end if;

  if v_job_id is not null then
    update public.ai_jobs as legacy_job
    set status = 'completed',
        completed_at = coalesce(legacy_job.completed_at, now()),
        locked_at = null,
        locked_by = null,
        last_error = 'suppressed_by_manual_ai_assist_reset_v3',
        updated_at = now()
    where legacy_job.id = v_job_id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'whatsapp_webhook',
      'reset_v3_legacy_inbound_job_suppressed',
      'message',
      v_message_id::text,
      jsonb_build_object(
        'legacyJobId', v_job_id,
        'providerMessageId', p_provider_message_id,
        'modelCallStarted', false,
        'automaticGenerationAllowed', false,
        'automaticDeliveryAllowed', false
      )
    );
  end if;

  return v_result || v_append_result || jsonb_build_object(
    'jobId', null,
    'legacyJobSuppressed', v_job_id is not null,
    'automaticGenerationAllowed', false,
    'automaticDeliveryAllowed', false
  );
end;
$$;

drop function if exists public.ai_authorize_turn_generation_v3(uuid, uuid, uuid);

create or replace function public.ai_authorize_turn_generation_v3(
  p_actor_user_id uuid,
  p_turn_id uuid,
  p_request_id uuid,
  p_expected_last_fragment_message_id uuid,
  p_expected_turn_content_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_latest_turn_id uuid;
  v_next_run integer;
  v_role text;
  v_turn_content_hash text;
  v_conversation_context jsonb;
  v_human_answered boolean;
begin
  if p_actor_user_id is null
     or p_turn_id is null
     or p_request_id is null
     or p_expected_last_fragment_message_id is null
     or p_expected_turn_content_hash is null
     or p_expected_turn_content_hash !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_authorization_invalid'
    );
  end if;

  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_actor_not_active'
    );
  end if;
  if v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist'
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_role_not_authorized'
    );
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'turn_not_found'
    );
  end if;

  -- This is the same conversation lock used by inbound turn assembly. It
  -- prevents a new WhatsApp fragment from racing an authorization decision.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'turn_not_found');
  end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.turn_id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'turn_job_not_found');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;

  if v_latest_turn_id is distinct from p_turn_id then
    return jsonb_build_object('ok', false, 'code', 'source_turn_not_latest');
  end if;
  if v_turn.status <> 'collecting' or v_job.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'generation_not_available');
  end if;
  if v_turn.settle_at > now() or v_job.available_at > now() then
    return jsonb_build_object('ok', false, 'code', 'turn_still_collecting');
  end if;
  if v_turn.model_attempts <> 0 or v_job.model_attempts <> 0 then
    return jsonb_build_object('ok', false, 'code', 'model_attempt_already_recorded');
  end if;
  -- The initial Generate action is run 1 only. Run 2 must pass through the
  -- explicit retry-and-authorize RPC below.
  if v_turn.generation_runs <> 0 or v_job.generation_run <> 0 then
    return jsonb_build_object(
      'ok', false,
      'state', v_turn.status,
      'code', 'initial_generation_already_used'
    );
  end if;
  v_next_run := 1;
  v_turn_content_hash := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', v_turn.consolidated_text,
        'fragments', v_turn.fragments,
        'sourceMessageId', v_turn.source_message_id,
        'lastFragmentMessageId', v_turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from v_turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from v_turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  );
  if v_turn.last_fragment_message_id
       is distinct from p_expected_last_fragment_message_id
     or v_turn_content_hash is distinct from p_expected_turn_content_hash
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'reviewed_turn_content_changed'
    );
  end if;
  select exists (
    select 1
    from public.ai_messages message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at)
          > v_turn.last_fragment_at
        or message.created_at > coalesce(
          (
            select fragment_message.created_at
            from public.ai_messages fragment_message
            where fragment_message.id = v_turn.last_fragment_message_id
          ),
          v_turn.first_fragment_at
        )
      )
  ) into v_human_answered;
  if v_human_answered then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'human_reply_already_recorded'
    );
  end if;
  if v_job.authorized_generation_run = v_next_run
     and v_job.generation_request_id is not null
     and v_job.generation_authorized_at is not null
     and v_job.generation_authorized_by is not null
     and v_job.generation_authorized_last_fragment_message_id
       is not distinct from v_turn.last_fragment_message_id
     and v_job.generation_authorized_turn_content_hash
       is not distinct from v_turn_content_hash
     and v_job.generation_authorized_conversation_context is not null
     and v_job.generation_authorization_consumed_at is null
  then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_authorized',
      'turnId', p_turn_id,
      'requestId', v_job.generation_request_id,
      'generationRun', v_next_run
    );
  end if;

  if v_job.authorized_generation_run is not null then
    return jsonb_build_object('ok', false, 'code', 'generation_authorization_conflict');
  end if;
  if exists (
    select 1
    from public.ai_turn_jobs_v3 other_job
    where other_job.generation_request_id = p_request_id
      and other_job.turn_id <> p_turn_id
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_request_id_conflict'
    );
  end if;
  if exists (
    select 1
    from public.ai_audit_log authorization_audit
    where authorization_audit.event_type in (
        'reset_v3_generation_authorized',
        'reset_v3_retry_generation_authorized'
      )
      and authorization_audit.details ->> 'requestId' = p_request_id::text
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_request_id_already_used'
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', snapshot.id,
        'direction', case
          when snapshot.direction = 'outbound' then 'outbound'
          else 'inbound'
        end,
        'kind', snapshot.kind,
        'text', coalesce(snapshot.text_body, ''),
        'createdAt', to_char(
          snapshot.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by snapshot.effective_at, snapshot.created_at, snapshot.id
    ),
    '[]'::jsonb
  ) into v_conversation_context
  from (
    select candidate.*
    from (
      select
        message.id,
        message.direction,
        message.kind,
        message.text_body,
        message.created_at,
        coalesce(message.provider_timestamp, message.created_at) as effective_at
      from public.ai_messages message
      where message.conversation_id = v_turn.conversation_id
      order by message.created_at desc, message.id desc
      limit 60
    ) candidate
    order by candidate.effective_at desc, candidate.created_at desc, candidate.id desc
    limit 20
  ) snapshot;

  update public.ai_turn_jobs_v3
  set authorized_generation_run = v_next_run,
      generation_request_id = p_request_id,
      generation_authorized_at = now(),
      generation_authorized_by = p_actor_user_id,
      generation_authorized_last_fragment_message_id = v_turn.last_fragment_message_id,
      generation_authorized_turn_content_hash = v_turn_content_hash,
      generation_authorized_conversation_context = v_conversation_context,
      generation_authorization_consumed_at = null,
      updated_at = now()
  where id = v_job.id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    p_actor_user_id::text,
    'reset_v3_generation_authorized',
    'client_turn_v3',
    p_turn_id::text,
    jsonb_build_object(
      'requestId', p_request_id,
      'generationRun', v_next_run,
      'actorRole', v_role,
      'authorizedLastFragmentMessageId', v_turn.last_fragment_message_id,
      'authorizedTurnContentHash', v_turn_content_hash,
      'authorizedConversationMessageCount', jsonb_array_length(v_conversation_context),
      'automaticGenerationAllowed', false,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'authorized',
    'turnId', p_turn_id,
    'requestId', p_request_id,
    'generationRun', v_next_run
  );
end;
$$;

drop function if exists public.ai_retry_and_authorize_turn_v3(uuid, uuid, uuid);

create or replace function public.ai_retry_and_authorize_turn_v3(
  p_actor_user_id uuid,
  p_turn_id uuid,
  p_request_id uuid,
  p_expected_last_fragment_message_id uuid,
  p_expected_turn_content_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_latest_turn_id uuid;
  v_next_run integer;
  v_role text;
  v_stale boolean := false;
  v_turn_content_hash text;
  v_conversation_context jsonb;
  v_human_answered boolean;
begin
  if p_actor_user_id is null
     or p_turn_id is null
     or p_request_id is null
     or p_expected_last_fragment_message_id is null
     or p_expected_turn_content_hash is null
     or p_expected_turn_content_hash !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_authorization_invalid'
    );
  end if;

  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_actor_not_active'
    );
  end if;
  if v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist'
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_role_not_authorized'
    );
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'turn_not_found'
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'turn_not_found');
  end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.turn_id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'turn_job_not_found');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;

  if v_latest_turn_id is distinct from p_turn_id then
    return jsonb_build_object('ok', false, 'code', 'source_turn_not_latest');
  end if;

  v_turn_content_hash := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', v_turn.consolidated_text,
        'fragments', v_turn.fragments,
        'sourceMessageId', v_turn.source_message_id,
        'lastFragmentMessageId', v_turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from v_turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from v_turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  );
  if v_turn.last_fragment_message_id
       is distinct from p_expected_last_fragment_message_id
     or v_turn_content_hash is distinct from p_expected_turn_content_hash
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'reviewed_turn_content_changed'
    );
  end if;
  select exists (
    select 1
    from public.ai_messages message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at)
          > v_turn.last_fragment_at
        or message.created_at > coalesce(
          (
            select fragment_message.created_at
            from public.ai_messages fragment_message
            where fragment_message.id = v_turn.last_fragment_message_id
          ),
          v_turn.first_fragment_at
        )
      )
  ) into v_human_answered;
  if v_human_answered then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'human_reply_already_recorded'
    );
  end if;

  -- A worker crash never grants another paid call by itself. A staff call to
  -- this retry RPC is the new authorization event; if the prior lease is stale,
  -- make that failure visible before authorizing the staff-requested final run.
  if v_turn.status = 'processing'
     and v_job.status = 'processing'
     and v_job.locked_at is not null
     and v_job.locked_at < now() - interval '7 minutes'
  then
    update public.ai_client_turns_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        superseded_reason = null,
        updated_at = now()
    where id = p_turn_id;

    update public.ai_turn_jobs_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        superseded_by_turn_id = null,
        superseded_reason = null,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = v_job.id;

    v_turn.status := 'failed';
    v_turn.candidate_id := null;
    v_turn.failure_code := 'worker_terminated';
    v_turn.failure_message := 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.';
    v_job.status := 'failed';
    v_job.candidate_id := null;
    v_job.failure_code := 'worker_terminated';
    v_job.failure_message := 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.';
    v_stale := true;
  end if;

  if v_turn.status = 'collecting'
     and v_job.status = 'pending'
     and v_job.generation_request_id is not null
     and v_job.authorized_generation_run = v_turn.generation_runs + 1
     and v_job.generation_authorized_last_fragment_message_id
       is not distinct from v_turn.last_fragment_message_id
     and v_job.generation_authorized_turn_content_hash
       is not distinct from v_turn_content_hash
     and v_job.generation_authorized_conversation_context is not null
     and v_job.generation_authorization_consumed_at is null
  then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_authorized',
      'turnId', p_turn_id,
      'requestId', v_job.generation_request_id,
      'generationRun', v_job.authorized_generation_run
    );
  end if;
  if v_turn.status <> 'failed' then
    return jsonb_build_object('ok', false, 'state', v_turn.status, 'code', 'turn_not_retryable');
  end if;
  if v_turn.generation_runs >= 2 then
    return jsonb_build_object('ok', false, 'state', v_turn.status, 'code', 'retry_limit_reached');
  end if;
  if v_turn.generation_runs < 1 then
    return jsonb_build_object(
      'ok', false,
      'state', v_turn.status,
      'code', 'initial_generation_required'
    );
  end if;
  if v_job.generation_run is distinct from v_turn.generation_runs then
    return jsonb_build_object(
      'ok', false,
      'state', v_turn.status,
      'code', 'generation_counter_mismatch'
    );
  end if;
  if v_job.status is distinct from v_turn.status then
    return jsonb_build_object(
      'ok', false,
      'state', v_turn.status,
      'code', 'generation_state_mismatch'
    );
  end if;
  if exists (
    select 1
    from public.ai_turn_jobs_v3 other_job
    where other_job.generation_request_id = p_request_id
      and other_job.turn_id <> p_turn_id
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_request_id_conflict'
    );
  end if;
  if exists (
    select 1
    from public.ai_audit_log authorization_audit
    where authorization_audit.event_type in (
        'reset_v3_generation_authorized',
        'reset_v3_retry_generation_authorized'
      )
      and authorization_audit.details ->> 'requestId' = p_request_id::text
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_request_id_already_used'
    );
  end if;

  v_next_run := v_turn.generation_runs + 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', snapshot.id,
        'direction', case
          when snapshot.direction = 'outbound' then 'outbound'
          else 'inbound'
        end,
        'kind', snapshot.kind,
        'text', coalesce(snapshot.text_body, ''),
        'createdAt', to_char(
          snapshot.created_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) order by snapshot.effective_at, snapshot.created_at, snapshot.id
    ),
    '[]'::jsonb
  ) into v_conversation_context
  from (
    select candidate.*
    from (
      select
        message.id,
        message.direction,
        message.kind,
        message.text_body,
        message.created_at,
        coalesce(message.provider_timestamp, message.created_at) as effective_at
      from public.ai_messages message
      where message.conversation_id = v_turn.conversation_id
      order by message.created_at desc, message.id desc
      limit 60
    ) candidate
    order by candidate.effective_at desc, candidate.created_at desc, candidate.id desc
    limit 20
  ) snapshot;

  update public.ai_reply_candidates_v3
  set status = 'superseded', updated_at = now()
  where id = v_turn.candidate_id and status = 'ready';

  update public.ai_client_turns_v3
  set status = 'collecting',
      candidate_id = null,
      failure_code = null,
      failure_message = null,
      model_attempts = 0,
      settle_at = now(),
      superseded_reason = null,
      updated_at = now()
  where id = p_turn_id;

  insert into public.ai_turn_jobs_v3 (
    turn_id, status, attempts, generation_run, model_attempts, available_at,
    authorized_generation_run, generation_request_id,
    generation_authorized_at, generation_authorized_by,
    generation_authorized_last_fragment_message_id,
    generation_authorized_turn_content_hash,
    generation_authorized_conversation_context,
    generation_authorization_consumed_at
  ) values (
    p_turn_id, 'pending', 0, v_turn.generation_runs, 0, now(),
    v_next_run, p_request_id, now(), p_actor_user_id,
    v_turn.last_fragment_message_id, v_turn_content_hash,
    v_conversation_context, null
  )
  on conflict (turn_id) do update
  set status = 'pending',
      attempts = 0,
      generation_run = v_turn.generation_runs,
      model_attempts = 0,
      available_at = now(),
      locked_at = null,
      locked_by = null,
      candidate_id = null,
      failure_code = null,
      failure_message = null,
      superseded_by_turn_id = null,
      superseded_reason = null,
      authorized_generation_run = v_next_run,
      generation_request_id = p_request_id,
      generation_authorized_at = now(),
      generation_authorized_by = p_actor_user_id,
      generation_authorized_last_fragment_message_id = v_turn.last_fragment_message_id,
      generation_authorized_turn_content_hash = v_turn_content_hash,
      generation_authorized_conversation_context = v_conversation_context,
      generation_authorization_consumed_at = null,
      updated_at = now();

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    p_actor_user_id::text,
    'reset_v3_retry_generation_authorized',
    'client_turn_v3',
    p_turn_id::text,
    jsonb_build_object(
      'requestId', p_request_id,
      'generationRun', v_next_run,
      'actorRole', v_role,
      'recoveredStaleWorker', v_stale,
      'authorizedLastFragmentMessageId', v_turn.last_fragment_message_id,
      'authorizedTurnContentHash', v_turn_content_hash,
      'authorizedConversationMessageCount', jsonb_array_length(v_conversation_context),
      'automaticRetryAllowed', false,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'authorized',
    'turnId', p_turn_id,
    'requestId', p_request_id,
    'generationRun', v_next_run
  );
end;
$$;

create or replace function public.ai_claim_authorized_turn_job_v3(
  p_worker_id text,
  p_turn_id uuid,
  p_request_id uuid
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
  attempts integer,
  generation_run integer,
  generation_request_id uuid,
  generation_authorized_by uuid,
  generation_authorized_at timestamptz,
  generation_authorization_consumed_at timestamptz,
  generation_authorized_conversation_context jsonb,
  worker_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_latest_turn_id uuid;
  v_role text;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_turn_content_hash text;
  v_human_answered boolean;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_turn_id is null or p_request_id is null
  then
    return;
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then return; end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.turn_id = p_turn_id
  for update;
  if not found then return; end if;

  v_turn_content_hash := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', v_turn.consolidated_text,
        'fragments', v_turn.fragments,
        'sourceMessageId', v_turn.source_message_id,
        'lastFragmentMessageId', v_turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from v_turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from v_turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  );

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;
  if v_latest_turn_id is distinct from p_turn_id then return; end if;

  -- Authorization is a one-shot approval of the exact settled client turn the
  -- staff member reviewed. A later inbound fragment can move settle_at and
  -- available_at forward after authorization commits but before the worker
  -- claims it. Invalidate that unused receipt instead of leaving it claimable
  -- once the new fragment settles; staff must review the updated turn and
  -- explicitly click Generate again.
  if v_job.generation_request_id is not distinct from p_request_id
     and v_job.status = 'pending'
     and v_job.generation_authorization_consumed_at is null
     and (
       v_job.generation_authorized_last_fragment_message_id
         is distinct from v_turn.last_fragment_message_id
       or v_job.generation_authorized_turn_content_hash
         is distinct from v_turn_content_hash
       or v_turn.settle_at > now()
       or v_job.available_at > now()
     )
  then
    update public.ai_turn_jobs_v3 as target_job
    set status = case when v_job.generation_run >= 1 then 'failed' else status end,
      candidate_id = null,
      failure_code = case
        when v_job.generation_run >= 1 then 'turn_changed_after_retry_authorization'
        else null
      end,
      failure_message = case
        when v_job.generation_run >= 1
          then 'The client request changed before the retry started. Review it, then retry again or write manually.'
        else null
      end,
      superseded_by_turn_id = null,
      superseded_reason = null,
      locked_at = null,
      locked_by = null,
      authorized_generation_run = null,
      generation_request_id = null,
      generation_authorized_at = null,
      generation_authorized_by = null,
      generation_authorized_last_fragment_message_id = null,
      generation_authorized_turn_content_hash = null,
      generation_authorized_conversation_context = null,
      generation_authorization_consumed_at = null,
      updated_at = now()
    where target_job.id = v_job.id
      and target_job.generation_request_id = p_request_id
      and target_job.generation_authorization_consumed_at is null;

    if v_job.generation_run >= 1 then
      update public.ai_client_turns_v3
      set status = 'failed',
          candidate_id = null,
          failure_code = 'turn_changed_after_retry_authorization',
          failure_message = 'The client request changed before the retry started. Review it, then retry again or write manually.',
          superseded_reason = null,
          updated_at = now()
      where id = p_turn_id;
    end if;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'receptionist_reset_v3',
      'reset_v3_generation_authorization_invalidated',
      'client_turn_v3',
      p_turn_id::text,
      jsonb_build_object(
        'requestId', p_request_id,
        'generationRun', v_job.authorized_generation_run,
        'authorizedBy', v_job.generation_authorized_by,
        'authorizedLastFragmentMessageId', v_job.generation_authorized_last_fragment_message_id,
        'currentLastFragmentMessageId', v_turn.last_fragment_message_id,
        'authorizedTurnContentHash', v_job.generation_authorized_turn_content_hash,
        'currentTurnContentHash', v_turn_content_hash,
        'turnSettleAt', v_turn.settle_at,
        'jobAvailableAt', v_job.available_at,
        'reason', 'new_fragment_requires_staff_review',
        'modelCallStarted', false,
        'automaticGenerationAllowed', false,
        'automaticDeliveryAllowed', false
      )
    );
    return;
  end if;

  select exists (
    select 1
    from public.ai_messages message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at)
          > v_turn.last_fragment_at
        or message.created_at >= v_job.generation_authorized_at
      )
  ) into v_human_answered;

  if v_job.generation_request_id is not distinct from p_request_id
     and v_job.status = 'pending'
     and v_job.generation_authorization_consumed_at is null
     and v_human_answered
  then
    update public.ai_client_turns_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_reason = 'answered_by_human',
        updated_at = now()
    where id = p_turn_id;

    update public.ai_turn_jobs_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_reason = 'answered_by_human',
        locked_at = null,
        locked_by = null,
        authorized_generation_run = null,
        generation_request_id = null,
        generation_authorized_at = null,
        generation_authorized_by = null,
        generation_authorized_last_fragment_message_id = null,
        generation_authorized_turn_content_hash = null,
        generation_authorized_conversation_context = null,
        generation_authorization_consumed_at = null,
        updated_at = now()
    where id = v_job.id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'receptionist_reset_v3',
      'reset_v3_generation_authorization_invalidated',
      'client_turn_v3',
      p_turn_id::text,
      jsonb_build_object(
        'requestId', p_request_id,
        'generationRun', v_job.authorized_generation_run,
        'authorizedBy', v_job.generation_authorized_by,
        'reason', 'answered_by_human_before_model_call',
        'modelCallStarted', false,
        'automaticGenerationAllowed', false,
        'automaticDeliveryAllowed', false
      )
    );
    return;
  end if;

  -- A repeated invocation may expose a dead lease, but it may never reclaim it
  -- or spend again. The staff member must make a new retry authorization.
  if v_job.generation_request_id = p_request_id
     and v_job.status = 'processing'
     and v_turn.status = 'processing'
     and v_job.locked_at is not null
     and v_job.locked_at < now() - interval '7 minutes'
  then
    update public.ai_client_turns_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        superseded_reason = null,
        updated_at = now()
    where id = p_turn_id;

    update public.ai_turn_jobs_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        superseded_by_turn_id = null,
        superseded_reason = null,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = v_job.id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'receptionist_reset_v3',
      'reset_v3_authorized_worker_stale',
      'client_turn_v3',
      p_turn_id::text,
      jsonb_build_object(
        'requestId', p_request_id,
        'generationRun', v_job.generation_run,
        'workerId', v_job.locked_by,
        'automaticRetryAllowed', false,
        'automaticDeliveryAllowed', false
      )
    );
    return;
  end if;

  v_role := public.ai_cc_staff_role(v_job.generation_authorized_by);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist'
  ) then
    return;
  end if;

  if v_job.generation_request_id is distinct from p_request_id
     or v_job.status <> 'pending'
     or v_job.available_at > now()
     or v_job.generation_authorized_at is null
     or v_job.generation_authorized_by is null
     or v_job.generation_authorized_last_fragment_message_id
       is distinct from v_turn.last_fragment_message_id
     or v_job.generation_authorized_turn_content_hash
       is distinct from v_turn_content_hash
     or v_job.generation_authorized_conversation_context is null
     or jsonb_typeof(v_job.generation_authorized_conversation_context) <> 'array'
     or v_job.generation_authorization_consumed_at is not null
     or v_job.authorized_generation_run is distinct from v_job.generation_run + 1
     or v_job.attempts >= 5
     or v_turn.status <> 'collecting'
     or v_turn.settle_at > now()
     or v_turn.generation_runs is distinct from v_job.generation_run
     or v_job.authorized_generation_run is distinct from v_turn.generation_runs + 1
     or v_turn.generation_runs >= 2
  then
    return;
  end if;

  update public.ai_turn_jobs_v3 as target_job
  set status = 'processing',
      attempts = target_job.attempts + 1,
      generation_run = target_job.authorized_generation_run,
      generation_authorization_consumed_at = now(),
      locked_at = now(),
      locked_by = left(p_worker_id, 160),
      updated_at = now()
  where target_job.id = v_job.id
  returning target_job.* into v_job;

  update public.ai_client_turns_v3
  set status = 'processing',
      generation_runs = v_job.generation_run,
      updated_at = now()
  where id = p_turn_id
  returning * into v_turn;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'receptionist_reset_v3',
    'reset_v3_generation_authorization_consumed',
    'client_turn_v3',
    p_turn_id::text,
    jsonb_build_object(
      'requestId', v_job.generation_request_id,
      'generationRun', v_job.generation_run,
      'authorizedBy', v_job.generation_authorized_by,
      'authorizedRole', v_role,
      'workerId', v_job.locked_by,
      'automaticGenerationAllowed', false,
      'automaticDeliveryAllowed', false
    )
  );

  return query select
    v_job.id,
    v_turn.id,
    v_turn.conversation_id,
    v_turn.contact_id,
    v_turn.version,
    v_turn.source_message_id,
    v_turn.last_fragment_message_id,
    v_turn.consolidated_text,
    v_turn.fragments,
    v_turn.first_fragment_at,
    v_turn.last_fragment_at,
    v_job.attempts,
    v_job.generation_run,
    v_job.generation_request_id,
    v_job.generation_authorized_by,
    v_job.generation_authorized_at,
    v_job.generation_authorization_consumed_at,
    v_job.generation_authorized_conversation_context,
    v_job.locked_by;
end;
$$;

-- Recheck the consumed receipt immediately before the only permitted model
-- call. The prompt still uses the immutable click-time context snapshot; this
-- preflight only avoids paying when a human/new client message made the draft
-- obsolete while non-model evidence was being assembled.
create or replace function public.ai_validate_authorized_turn_job_v3(
  p_job_id uuid,
  p_turn_id uuid,
  p_request_id uuid,
  p_generation_run integer,
  p_worker_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_latest_turn_id uuid;
  v_turn_content_hash text;
  v_human_answered boolean;
  v_reason text;
begin
  if p_job_id is null
     or p_turn_id is null
     or p_request_id is null
     or p_generation_run is null
     or p_generation_run not between 1 and 2
     or p_worker_id is null
     or btrim(p_worker_id) = ''
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_preflight_invalid'
    );
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.id = p_job_id
    and job.turn_id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_job_not_found');
  end if;

  if v_job.generation_request_id is distinct from p_request_id
     or v_job.authorized_generation_run is distinct from p_generation_run
     or v_job.generation_run is distinct from p_generation_run
     or v_job.generation_authorization_consumed_at is null
     or v_job.generation_authorized_conversation_context is null
     or jsonb_typeof(v_job.generation_authorized_conversation_context) <> 'array'
     or v_turn.generation_runs is distinct from p_generation_run
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_receipt_mismatch'
    );
  end if;

  v_turn_content_hash := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', v_turn.consolidated_text,
        'fragments', v_turn.fragments,
        'sourceMessageId', v_turn.source_message_id,
        'lastFragmentMessageId', v_turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from v_turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from v_turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  );

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;

  select exists (
    select 1
    from public.ai_messages message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at)
          > v_turn.last_fragment_at
        or message.created_at >= v_job.generation_authorized_at
      )
  ) into v_human_answered;

  v_reason := case
    when v_human_answered then 'answered_by_human'
    when v_latest_turn_id is distinct from p_turn_id then 'newer_client_turn'
    when v_job.generation_authorized_last_fragment_message_id
           is distinct from v_turn.last_fragment_message_id
      or v_job.generation_authorized_turn_content_hash
           is distinct from v_turn_content_hash
      then 'turn_content_changed_after_claim'
    when v_turn.status = 'superseded' or v_job.status = 'superseded'
      then coalesce(v_turn.superseded_reason, v_job.superseded_reason, 'turn_superseded')
    else null
  end;

  if v_reason is not null then
    update public.ai_client_turns_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_reason = v_reason,
        updated_at = now()
    where id = p_turn_id
      and status in ('collecting', 'processing', 'superseded');

    update public.ai_turn_jobs_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = case
          when v_latest_turn_id is distinct from p_turn_id then v_latest_turn_id
          else superseded_by_turn_id
        end,
        superseded_reason = v_reason,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = p_job_id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'receptionist_reset_v3',
      'reset_v3_generation_preflight_rejected',
      'client_turn_v3',
      p_turn_id::text,
      jsonb_build_object(
        'requestId', p_request_id,
        'generationRun', p_generation_run,
        'workerId', left(p_worker_id, 160),
        'reason', v_reason,
        'modelCallStarted', false,
        'automaticRetryAllowed', false,
        'automaticDeliveryAllowed', false
      )
    );

    return jsonb_build_object('ok', false, 'state', 'superseded', 'code', v_reason);
  end if;

  if v_turn.status <> 'processing'
     or v_job.status <> 'processing'
     or v_job.locked_by is distinct from left(p_worker_id, 160)
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_worker_lease_mismatch'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'state', 'valid',
    'requestId', p_request_id,
    'generationRun', p_generation_run
  );
end;
$$;

create or replace function public.ai_finish_authorized_turn_ready_v3(
  p_job_id uuid,
  p_turn_id uuid,
  p_request_id uuid,
  p_generation_run integer,
  p_worker_id text,
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
  v_conversation_id uuid;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_candidate_id uuid;
  v_wa_id text;
  v_latest_turn_id uuid;
  v_turn_content_hash text;
  v_hash text;
  v_human_answered boolean;
begin
  if p_job_id is null
     or p_turn_id is null
     or p_request_id is null
     or p_generation_run is null
     or p_generation_run not between 1 and 2
     or p_worker_id is null
     or btrim(p_worker_id) = ''
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_receipt_invalid'
    );
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.id = p_job_id
    and job.turn_id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_job_not_found');
  end if;

  -- Identity is checked before any result is accepted. This prevents an old
  -- serverless worker from finishing a later staff-authorized retry that reused
  -- the same turn/job row.
  if v_job.generation_request_id is distinct from p_request_id
     or v_job.authorized_generation_run is distinct from p_generation_run
     or v_job.generation_run is distinct from p_generation_run
     or v_job.generation_authorization_consumed_at is null
     or v_turn.generation_runs is distinct from p_generation_run
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_receipt_mismatch'
    );
  end if;

  -- The model result may only be attached to the exact turn snapshot that the
  -- staff member reviewed and authorised. Recompute this while holding the
  -- turn row lock so a same-turn mutation committed during evidence/model work
  -- cannot leave a stale editable candidate behind.
  v_turn_content_hash := pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', v_turn.consolidated_text,
        'fragments', v_turn.fragments,
        'sourceMessageId', v_turn.source_message_id,
        'lastFragmentMessageId', v_turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from v_turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from v_turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  );

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;

  if v_latest_turn_id is distinct from p_turn_id
     or v_job.generation_authorized_last_fragment_message_id
          is distinct from v_turn.last_fragment_message_id
     or v_job.generation_authorized_turn_content_hash
          is distinct from v_turn_content_hash
     or v_turn.status = 'superseded'
     or v_job.status = 'superseded'
  then
    update public.ai_client_turns_v3 as target_turn
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = case
          when v_latest_turn_id is distinct from p_turn_id then v_latest_turn_id
          else target_turn.superseded_by_turn_id
        end,
        superseded_reason = case
          when v_latest_turn_id is distinct from p_turn_id then 'newer_client_turn'
          when v_job.generation_authorized_last_fragment_message_id
                 is distinct from v_turn.last_fragment_message_id
            or v_job.generation_authorized_turn_content_hash
                 is distinct from v_turn_content_hash
            then 'turn_content_changed_during_generation'
          else coalesce(target_turn.superseded_reason, v_job.superseded_reason, 'turn_superseded')
        end,
        updated_at = now()
    where target_turn.id = p_turn_id;

    update public.ai_turn_jobs_v3 as target_job
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = case
          when v_latest_turn_id is distinct from p_turn_id then v_latest_turn_id
          else target_job.superseded_by_turn_id
        end,
        superseded_reason = case
          when v_latest_turn_id is distinct from p_turn_id then 'newer_client_turn'
          when v_job.generation_authorized_last_fragment_message_id
                 is distinct from v_turn.last_fragment_message_id
            or v_job.generation_authorized_turn_content_hash
                 is distinct from v_turn_content_hash
            then 'turn_content_changed_during_generation'
          else coalesce(target_job.superseded_reason, v_turn.superseded_reason, 'turn_superseded')
        end,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where target_job.id = p_job_id
      and target_job.generation_request_id = p_request_id;
    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  if v_turn.status <> 'processing'
     or v_job.status <> 'processing'
     or v_job.locked_by is distinct from left(p_worker_id, 160)
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_worker_lease_mismatch'
    );
  end if;
  if p_model_id is null or p_model_id <> 'openai/gpt-5.6-sol' then
    raise exception 'reset_v3_model_not_allowed' using errcode = '23514';
  end if;
  if p_model_attempts is null or p_model_attempts <> 1 then
    raise exception 'reset_v3_exactly_one_model_attempt_required' using errcode = '23514';
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception 'reset_v3_candidate_body_invalid' using errcode = '23514';
  end if;
  if public.ai_tanglin_whatsapp_reply_violation(p_body) is not null then
    raise exception 'reset_v3_tanglin_channel_violation' using errcode = '23514';
  end if;

  select exists (
    select 1
    from public.ai_messages message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at)
          > v_turn.last_fragment_at
        or message.created_at >= v_job.generation_authorized_at
      )
  ) into v_human_answered;

  if v_human_answered then
    update public.ai_client_turns_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = null,
        superseded_reason = 'answered_by_human',
        updated_at = now()
    where id = p_turn_id;

    update public.ai_turn_jobs_v3
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = null,
        superseded_reason = 'answered_by_human',
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = p_job_id;

    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  select contact.wa_id into strict v_wa_id
  from public.ai_contacts contact
  where contact.id = v_turn.contact_id;

  v_hash := pg_catalog.encode(
    extensions.digest(btrim(p_body), 'sha256'),
    'hex'
  );

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
    p_model_id,
    1,
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
      model_attempts = 1,
      failure_code = null,
      failure_message = null,
      superseded_reason = null,
      updated_at = now()
  where id = p_turn_id;

  update public.ai_turn_jobs_v3
  set status = 'ready',
      candidate_id = v_candidate_id,
      model_attempts = 1,
      failure_code = null,
      failure_message = null,
      superseded_by_turn_id = null,
      superseded_reason = null,
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
      'requestId', p_request_id,
      'generationRun', p_generation_run,
      'authorizedBy', v_job.generation_authorized_by,
      'workerId', left(p_worker_id, 160),
      'modelId', p_model_id,
      'modelAttempts', 1,
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

create or replace function public.ai_finish_authorized_turn_failed_v3(
  p_job_id uuid,
  p_turn_id uuid,
  p_request_id uuid,
  p_generation_run integer,
  p_worker_id text,
  p_failure_code text,
  p_failure_message text,
  p_model_attempts integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_turn public.ai_client_turns_v3%rowtype;
  v_job public.ai_turn_jobs_v3%rowtype;
  v_latest_turn_id uuid;
  v_code text := left(
    regexp_replace(
      lower(coalesce(p_failure_code, 'draft_failed')),
      '[^a-z0-9_]+',
      '_',
      'g'
    ),
    120
  );
  v_message text := left(
    btrim(coalesce(p_failure_message, 'The AI could not prepare this reply.')),
    500
  );
begin
  if p_job_id is null
     or p_turn_id is null
     or p_request_id is null
     or p_generation_run is null
     or p_generation_run not between 1 and 2
     or p_worker_id is null
     or btrim(p_worker_id) = ''
     or v_code = ''
     or v_message = ''
     or p_model_attempts is null
     or p_model_attempts not between 0 and 1
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_failure_receipt_invalid'
    );
  end if;

  select turn.conversation_id into v_conversation_id
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_turn_id::text, 751)
  );

  select turn.* into v_turn
  from public.ai_client_turns_v3 turn
  where turn.id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_not_found');
  end if;

  select job.* into v_job
  from public.ai_turn_jobs_v3 job
  where job.id = p_job_id
    and job.turn_id = p_turn_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'turn_job_not_found');
  end if;

  if v_job.generation_request_id is distinct from p_request_id
     or v_job.authorized_generation_run is distinct from p_generation_run
     or v_job.generation_run is distinct from p_generation_run
     or v_job.generation_authorization_consumed_at is null
     or v_turn.generation_runs is distinct from p_generation_run
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_receipt_mismatch'
    );
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;

  if v_latest_turn_id is distinct from p_turn_id
     or v_turn.status = 'superseded'
     or v_job.status = 'superseded'
  then
    update public.ai_turn_jobs_v3 as target_job
    set status = 'superseded',
        candidate_id = null,
        failure_code = null,
        failure_message = null,
        superseded_by_turn_id = case
          when v_latest_turn_id is distinct from p_turn_id then v_latest_turn_id
          else target_job.superseded_by_turn_id
        end,
        superseded_reason = case
          when v_latest_turn_id is distinct from p_turn_id then 'newer_client_turn'
          else coalesce(target_job.superseded_reason, v_turn.superseded_reason, 'turn_superseded')
        end,
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where target_job.id = p_job_id
      and target_job.generation_request_id = p_request_id;
    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  if v_turn.status <> 'processing'
     or v_job.status <> 'processing'
     or v_job.locked_by is distinct from left(p_worker_id, 160)
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'generation_worker_lease_mismatch'
    );
  end if;

  update public.ai_client_turns_v3
  set status = 'failed',
      candidate_id = null,
      failure_code = v_code,
      failure_message = v_message,
      model_attempts = p_model_attempts,
      superseded_reason = null,
      updated_at = now()
  where id = p_turn_id;

  update public.ai_turn_jobs_v3
  set status = 'failed',
      candidate_id = null,
      failure_code = v_code,
      failure_message = v_message,
      model_attempts = p_model_attempts,
      superseded_by_turn_id = null,
      superseded_reason = null,
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'receptionist_reset_v3',
    'reset_v3_draft_failed_visible',
    'client_turn_v3',
    p_turn_id::text,
    jsonb_build_object(
      'requestId', p_request_id,
      'generationRun', p_generation_run,
      'authorizedBy', v_job.generation_authorized_by,
      'workerId', left(p_worker_id, 160),
      'failureCode', v_code,
      'failureMessage', v_message,
      'modelAttempts', p_model_attempts,
      'automaticRetryAllowed', false,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'failed',
    'failureCode', v_code
  );
end;
$$;

-- Human delivery and generation completion use the same conversation/turn
-- lock order. A staff Send racing a worker finish must not deadlock after the
-- one paid model call has already completed.
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
  v_candidate_turn_id uuid;
  v_conversation_id uuid;
  v_candidate public.ai_reply_candidates_v3%rowtype;
  v_turn public.ai_client_turns_v3%rowtype;
  v_latest_turn_id uuid;
  v_existing public.ai_human_send_reservations_v3%rowtype;
  v_reservation public.ai_human_send_reservations_v3%rowtype;
  v_final_hash text;
  v_human_answered boolean;
begin
  -- Discover immutable lock keys without retaining a row lock. Re-read and
  -- validate the candidate only after the canonical advisory/row locks exist.
  select candidate.turn_id, candidate.conversation_id
    into strict v_candidate_turn_id, v_conversation_id
  from public.ai_reply_candidates_v3 as candidate
  where candidate.id = p_candidate_id;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_conversation_id::text, 703)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_candidate_turn_id::text, 751)
  );

  select turn.* into strict v_turn
  from public.ai_client_turns_v3 as turn
  where turn.id = v_candidate_turn_id
  for update;

  select candidate.* into strict v_candidate
  from public.ai_reply_candidates_v3 as candidate
  where candidate.id = p_candidate_id
    and candidate.turn_id = v_turn.id
    and candidate.conversation_id = v_turn.conversation_id
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
  if v_candidate.status <> 'ready'
     or v_turn.status <> 'ready'
     or v_turn.delivery_control <> 'human_only'
  then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;
  if now() - v_turn.last_fragment_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'customer_service_window_expired');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_client_turns_v3 as turn
  where turn.conversation_id = v_turn.conversation_id
  order by turn.version desc
  limit 1;
  if v_latest_turn_id is distinct from v_turn.id then
    return jsonb_build_object('ok', false, 'code', 'source_turn_not_latest');
  end if;

  select exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and coalesce(message.provider_timestamp, message.created_at) > v_turn.last_fragment_at
  ) into v_human_answered;
  if v_human_answered then
    return jsonb_build_object('ok', false, 'code', 'human_reply_already_recorded');
  end if;

  if length(btrim(coalesce(p_final_text, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'code', 'final_text_invalid');
  end if;
  if public.ai_tanglin_whatsapp_reply_violation(p_final_text) is not null then
    return jsonb_build_object('ok', false, 'code', 'tanglin_channel_violation');
  end if;

  select reservation.* into v_existing
  from public.ai_human_send_reservations_v3 as reservation
  where reservation.candidate_id = p_candidate_id
    and reservation.status in ('reserved', 'sent')
  order by reservation.reserved_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'ok', v_existing.status = 'sent',
      'state', v_existing.status,
      'code', case when v_existing.status = 'sent' then null else 'send_already_reserved' end,
      'reservationId', v_existing.id,
      'providerMessageId', v_existing.provider_message_id
    );
  end if;

  v_final_hash := pg_catalog.encode(
    extensions.digest(btrim(p_final_text), 'sha256'),
    'hex'
  );

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

-- Recreate rather than replace so this migration is also canonical on a
-- database built only from the checked-in migrations, whose older view does
-- not yet contain the live drift columns in the same ordinal positions.
drop view if exists public.ai_latest_client_turns_v3;

create view public.ai_latest_client_turns_v3
with (security_invoker = true)
as
select distinct on (turn.conversation_id)
  turn.conversation_id,
  turn.id as turn_id,
  turn.version as turn_version,
  turn.status as turn_status,
  turn.delivery_control,
  turn.generation_runs,
  turn.first_fragment_at,
  turn.last_fragment_at,
  turn.settle_at,
  turn.failure_code,
  turn.failure_message,
  turn.superseded_reason,
  candidate.id as candidate_id,
  candidate.body as candidate_text,
  candidate.body_hash as candidate_hash,
  candidate.status as candidate_status,
  candidate.model_id as candidate_model_id,
  candidate.model_attempts as candidate_model_attempts,
  job.id as job_id,
  job.status as job_status,
  job.attempts as job_attempts,
  job.generation_run as job_generation_run,
  job.model_attempts as job_model_attempts,
  job.authorized_generation_run as job_authorized_generation_run,
  job.generation_request_id as job_generation_request_id,
  job.generation_authorized_at as job_generation_authorized_at,
  job.generation_authorized_by as job_generation_authorized_by,
  job.generation_authorization_consumed_at as job_generation_authorization_consumed_at,
  job.locked_at as job_locked_at,
  job.locked_by as job_locked_by,
  job.generation_authorized_last_fragment_message_id
    as job_generation_authorized_last_fragment_message_id,
  job.generation_authorized_turn_content_hash
    as job_generation_authorized_turn_content_hash,
  turn.last_fragment_message_id,
  pg_catalog.encode(
    extensions.digest(
      jsonb_build_object(
        'consolidatedText', turn.consolidated_text,
        'fragments', turn.fragments,
        'sourceMessageId', turn.source_message_id,
        'lastFragmentMessageId', turn.last_fragment_message_id,
        'firstFragmentAtEpoch', extract(epoch from turn.first_fragment_at),
        'lastFragmentAtEpoch', extract(epoch from turn.last_fragment_at)
      )::text,
      'sha256'
    ),
    'hex'
  ) as turn_content_hash
from public.ai_client_turns_v3 turn
left join public.ai_reply_candidates_v3 candidate
  on candidate.id = turn.candidate_id
left join public.ai_turn_jobs_v3 job
  on job.turn_id = turn.id
order by turn.conversation_id, turn.version desc;

revoke all on public.ai_latest_client_turns_v3
  from public, anon, authenticated, service_role;
grant select on public.ai_latest_client_turns_v3 to service_role;

-- Tombstone the former unscoped claim and actor-less retry implementations.
-- Revoking is the application boundary; these bodies also make an accidental
-- future re-grant fail closed rather than resurrecting automatic generation.
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
  raise exception 'reset_v3_generic_claim_disabled'
    using errcode = '42501',
          hint = 'Use ai_claim_authorized_turn_job_v3 with a staff authorization receipt.';
end;
$$;

create or replace function public.ai_retry_turn_v3(
  p_turn_id uuid
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', false,
    'state', 'blocked',
    'code', 'staff_generation_authorization_required'
  );
$$;

revoke all on function public.ai_authorize_turn_generation_v3(
  uuid, uuid, uuid, uuid, text
)
  from public, anon, authenticated;
revoke all on function public.ai_validate_client_turn_v3_deferred()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_protect_generation_authorization_audit_v3()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_invalidate_generation_authorization_on_turn_change_v3()
  from public, anon, authenticated, service_role;
revoke all on function public.ai_ingest_whatsapp_message_reset_v3(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_retry_and_authorize_turn_v3(
  uuid, uuid, uuid, uuid, text
)
  from public, anon, authenticated;
revoke all on function public.ai_claim_authorized_turn_job_v3(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.ai_validate_authorized_turn_job_v3(
  uuid, uuid, uuid, integer, text
)
  from public, anon, authenticated;
revoke all on function public.ai_finish_authorized_turn_ready_v3(
  uuid, uuid, uuid, integer, text, text, integer, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_finish_authorized_turn_failed_v3(
  uuid, uuid, uuid, integer, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.ai_authorize_turn_generation_v3(
  uuid, uuid, uuid, uuid, text
)
  to service_role;
grant execute on function public.ai_ingest_whatsapp_message_reset_v3(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;
grant execute on function public.ai_retry_and_authorize_turn_v3(
  uuid, uuid, uuid, uuid, text
)
  to service_role;
grant execute on function public.ai_claim_authorized_turn_job_v3(text, uuid, uuid)
  to service_role;
grant execute on function public.ai_validate_authorized_turn_job_v3(
  uuid, uuid, uuid, integer, text
)
  to service_role;
grant execute on function public.ai_finish_authorized_turn_ready_v3(
  uuid, uuid, uuid, integer, text, text, integer, text, jsonb, jsonb
) to service_role;
grant execute on function public.ai_finish_authorized_turn_failed_v3(
  uuid, uuid, uuid, integer, text, text, text, integer
) to service_role;
revoke all on function public.ai_reserve_human_send_v3(
  uuid, uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.ai_reserve_human_send_v3(
  uuid, uuid, uuid, integer, text, text, text
) to service_role;

-- Legacy generic claim and actor-less retry paths must not remain callable by
-- application credentials in manual-assist mode.
revoke all on function public.ai_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.ai_ingest_whatsapp_message_human_review(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.ai_append_client_turn_fragment_v3(
  uuid, uuid, uuid, text, text, jsonb, timestamptz, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.ai_claim_jobs(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_claim_turn_jobs_v3(text, integer, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.ai_retry_turn_v3(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ai_finish_turn_ready_v3(
  uuid, uuid, text, integer, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.ai_finish_turn_failed_v3(
  uuid, uuid, text, text, integer
) from public, anon, authenticated, service_role;

commit;
