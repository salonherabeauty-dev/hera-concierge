begin;

-- Permit an explicitly human-authored candidate to carry model_attempts = 0.
alter table public.ai_reply_candidates_v3
  drop constraint if exists ai_reply_candidates_v3_model_attempts_check;
alter table public.ai_reply_candidates_v3
  add constraint ai_reply_candidates_v3_model_attempts_check
  check (model_attempts between 0 and 2);

-- A failed provider attempt must not permanently prevent an authorised human
-- from retrying the same candidate. At most one active/sent reservation exists.
alter table public.ai_human_send_reservations_v3
  drop constraint if exists ai_human_send_reservations_v3_candidate_id_key;
drop index if exists public.ai_human_send_reservations_v3_candidate_active_idx;
create unique index ai_human_send_reservations_v3_candidate_active_idx
  on public.ai_human_send_reservations_v3 (candidate_id)
  where status in ('reserved', 'sent');

-- Keep the newest 40 fragments without relying on positional JSON deletion.
create or replace function public.ai_trim_reset_fragments_v3(
  p_fragments jsonb,
  p_limit integer default 40
) returns jsonb
language sql
immutable
set search_path = ''
as $$
  with normalized as (
    select
      case
        when jsonb_typeof(coalesce(p_fragments, '[]'::jsonb)) = 'array'
          then coalesce(p_fragments, '[]'::jsonb)
        else '[]'::jsonb
      end as items,
      greatest(1, least(coalesce(p_limit, 40), 40)) as item_limit
  )
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
  from normalized
  cross join lateral jsonb_array_elements(normalized.items)
    with ordinality as item(value, ordinality)
  where item.ordinality > greatest(
    jsonb_array_length(normalized.items) - normalized.item_limit,
    0
  );
$$;

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
  v_existing_found boolean := false;
  v_turn_id uuid;
  v_version integer;
  v_effective_at timestamptz := coalesce(p_provider_timestamp, now());
  v_settle_at timestamptz := greatest(coalesce(p_provider_timestamp, now()), now()) + interval '8 seconds';
  v_text text := btrim(coalesce(p_text, ''));
  v_substantive boolean;
  v_fragment jsonb;
  v_legacy_job_id uuid;
  v_append_same_turn boolean := false;
  v_carry_previous_turn boolean := false;
  v_stale_historical boolean := false;
  v_new_text text;
  v_new_fragments jsonb;
  v_new_source_message_id uuid;
  v_new_first_fragment_at timestamptz;
  v_new_last_fragment_at timestamptz;
  v_new_last_fragment_message_id uuid;
  v_result_status text := 'collecting';
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
  v_existing_found := found;

  if v_existing_found then
    -- A materially older provider event may be displayed in the transcript, but
    -- it must never supersede the current client turn or invalidate its draft.
    v_stale_historical :=
      v_effective_at < v_existing.first_fragment_at - interval '2 minutes';

    -- Normal rapid text/image bursts share one collecting turn. Unreadable or
    -- delayed attachment events get a larger grace window and can never become
    -- a replacement instruction that erases the substantive message before it.
    v_append_same_turn := not v_stale_historical
      and v_existing.status = 'collecting'
      and (
        v_effective_at between
          v_existing.first_fragment_at - interval '30 seconds'
          and v_existing.last_fragment_at + interval '30 seconds'
        or (
          not v_substantive
          and v_effective_at between
            v_existing.first_fragment_at - interval '2 minutes'
            and v_existing.last_fragment_at + interval '2 minutes'
        )
      );
    v_carry_previous_turn := not v_stale_historical
      and v_existing.status in ('processing', 'ready', 'failed')
      and (
        v_effective_at between
          v_existing.first_fragment_at - interval '30 seconds'
          and v_existing.last_fragment_at + interval '30 seconds'
        or (
          not v_substantive
          and v_effective_at between
            v_existing.first_fragment_at - interval '2 minutes'
            and v_existing.last_fragment_at + interval '2 minutes'
        )
      );
  end if;

  if v_stale_historical then
    v_turn_id := v_existing.id;
    v_result_status := v_existing.status;
  elsif v_append_same_turn then
    update public.ai_client_turns_v3 as turn
    set first_fragment_at = least(turn.first_fragment_at, v_effective_at),
        last_fragment_at = greatest(turn.last_fragment_at, v_effective_at),
        settle_at = greatest(v_settle_at, turn.settle_at),
        last_fragment_message_id = case
          when v_effective_at >= turn.last_fragment_at then p_message_id
          else turn.last_fragment_message_id
        end,
        source_message_id = case
          when v_substantive and v_effective_at >= turn.last_fragment_at then p_message_id
          else turn.source_message_id
        end,
        consolidated_text = case
          when not v_substantive then turn.consolidated_text
          when turn.consolidated_text = '' then left(v_text, 24000)
          else left(turn.consolidated_text || E'\n' || v_text, 24000)
        end,
        fragments = public.ai_trim_reset_fragments_v3(
          turn.fragments || jsonb_build_array(v_fragment),
          40
        ),
        updated_at = now()
    where turn.id = v_existing.id
    returning turn.id into v_turn_id;

    update public.ai_turn_jobs_v3
    set available_at = greatest(v_settle_at, available_at),
        updated_at = now()
    where turn_id = v_turn_id
      and status = 'pending';
  else
    if v_existing_found and v_existing.status in ('collecting', 'processing', 'ready') then
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

    if v_carry_previous_turn then
      v_new_text := case
        when not v_substantive then v_existing.consolidated_text
        when v_existing.consolidated_text = '' then left(v_text, 24000)
        else left(v_existing.consolidated_text || E'\n' || v_text, 24000)
      end;
      v_new_fragments := public.ai_trim_reset_fragments_v3(
        v_existing.fragments || jsonb_build_array(v_fragment),
        40
      );
      v_new_source_message_id := case
        when v_substantive and v_effective_at >= v_existing.last_fragment_at
          then p_message_id
        else v_existing.source_message_id
      end;
      v_new_first_fragment_at := least(
        v_existing.first_fragment_at,
        v_effective_at
      );
      v_new_last_fragment_at := greatest(
        v_existing.last_fragment_at,
        v_effective_at
      );
      v_new_last_fragment_message_id := case
        when v_effective_at >= v_existing.last_fragment_at then p_message_id
        else v_existing.last_fragment_message_id
      end;
    else
      v_new_text := case when v_substantive then left(v_text, 24000) else '' end;
      v_new_fragments := jsonb_build_array(v_fragment);
      v_new_source_message_id := case when v_substantive then p_message_id else null end;
      v_new_first_fragment_at := v_effective_at;
      v_new_last_fragment_at := v_effective_at;
      v_new_last_fragment_message_id := p_message_id;
    end if;

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
      v_new_first_fragment_at,
      v_new_last_fragment_at,
      v_settle_at,
      v_new_source_message_id,
      v_new_last_fragment_message_id,
      v_new_text,
      v_new_fragments
    ) returning id into v_turn_id;

    insert into public.ai_turn_jobs_v3 (turn_id, status, available_at)
    values (v_turn_id, 'pending', v_settle_at);

    if v_existing_found and v_existing.status in ('collecting', 'processing', 'ready') then
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
        last_error = case
          when v_stale_historical
            then 'stale_historical_inbound_ignored_by_receptionist_reset_v3'
          else 'superseded_by_receptionist_reset_v3'
        end,
        updated_at = now()
    where id = v_legacy_job_id;
  end if;

  return jsonb_build_object(
    'turnId', v_turn_id,
    'status', v_result_status,
    'settleAt', case when v_stale_historical then v_existing.settle_at else v_settle_at end,
    'substantive', v_substantive,
    'carriedPreviousTurn', v_carry_previous_turn,
    'staleHistorical', v_stale_historical,
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
declare
  v_stale_job_ids uuid[];
begin
  -- A vanished serverless worker is not retried silently. It becomes a visible
  -- terminal failure that a human can retry deliberately.
  select array_agg(stale.id) into v_stale_job_ids
  from (
    select j.id
    from public.ai_turn_jobs_v3 j
    where j.status = 'processing'
      and j.locked_at < now() - interval '7 minutes'
      and (p_turn_ids is null or j.turn_id = any(p_turn_ids))
    order by j.locked_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) stale;

  if coalesce(array_length(v_stale_job_ids, 1), 0) > 0 then
    update public.ai_client_turns_v3 t
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        model_attempts = least(model_attempts, 2),
        updated_at = now()
    from public.ai_turn_jobs_v3 j
    where j.id = any(v_stale_job_ids)
      and t.id = j.turn_id
      and t.status = 'processing';

    update public.ai_turn_jobs_v3
    set status = 'failed',
        candidate_id = null,
        failure_code = 'worker_terminated',
        failure_message = 'The AI worker stopped before the reply was saved. Retry once or write the reply manually.',
        model_attempts = least(model_attempts, 2),
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where id = any(v_stale_job_ids)
      and status = 'processing';
  end if;

  return query
  with selected as (
    select j.id
    from public.ai_turn_jobs_v3 j
    join public.ai_client_turns_v3 t on t.id = j.turn_id
    where j.status = 'pending'
      and j.available_at <= now()
      and t.status = 'collecting'
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
      and t.status = 'collecting'
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

create or replace function public.ai_create_manual_candidate_v3(
  p_actor_user_id uuid,
  p_turn_id uuid,
  p_expected_turn_version integer,
  p_expected_phone_ending text,
  p_body text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_client_turns_v3%rowtype;
  v_latest_turn_id uuid;
  v_wa_id text;
  v_hash text;
  v_candidate_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_turn_id::text, 739));
  select * into strict v_turn
  from public.ai_client_turns_v3
  where id = p_turn_id
  for update;

  if v_turn.version is distinct from p_expected_turn_version then
    return jsonb_build_object('ok', false, 'code', 'turn_version_mismatch');
  end if;
  if v_turn.status <> 'failed' then
    return jsonb_build_object('ok', false, 'code', 'manual_candidate_requires_failed_turn');
  end if;

  select id into v_latest_turn_id
  from public.ai_client_turns_v3
  where conversation_id = v_turn.conversation_id
  order by version desc
  limit 1;
  if v_latest_turn_id is distinct from v_turn.id then
    return jsonb_build_object('ok', false, 'code', 'source_turn_not_latest');
  end if;

  select wa_id into strict v_wa_id
  from public.ai_contacts
  where id = v_turn.contact_id;
  if right(v_wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;
  if now() - v_turn.last_fragment_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'customer_service_window_expired');
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'code', 'manual_text_invalid');
  end if;
  if public.ai_tanglin_whatsapp_reply_violation(p_body) is not null then
    return jsonb_build_object('ok', false, 'code', 'tanglin_channel_violation');
  end if;

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
    v_turn.id,
    v_turn.conversation_id,
    v_turn.contact_id,
    coalesce(v_turn.source_message_id, v_turn.last_fragment_message_id),
    v_wa_id,
    btrim(p_body),
    v_hash,
    'ready',
    'human/manual',
    0,
    jsonb_build_object('source', 'human_manual_draft'),
    jsonb_build_object(
      'passed', true,
      'policyVersion', 'human-manual-tanglin-check-v1',
      'automaticDeliveryAllowed', false
    )
  )
  on conflict (turn_id) do update
    set body = excluded.body,
        body_hash = excluded.body_hash,
        status = 'ready',
        model_id = excluded.model_id,
        model_attempts = 0,
        evidence = excluded.evidence,
        validation = excluded.validation,
        updated_at = now()
  returning id into v_candidate_id;

  update public.ai_client_turns_v3
  set status = 'ready',
      candidate_id = v_candidate_id,
      failure_code = null,
      failure_message = null,
      model_attempts = 0,
      updated_at = now()
  where id = v_turn.id;

  update public.ai_turn_jobs_v3
  set status = 'ready',
      candidate_id = v_candidate_id,
      failure_code = null,
      failure_message = null,
      model_attempts = 0,
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where turn_id = v_turn.id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    p_actor_user_id::text,
    'reset_v3_manual_candidate_ready',
    'reply_candidate_v3',
    v_candidate_id::text,
    jsonb_build_object(
      'turnId', v_turn.id,
      'conversationId', v_turn.conversation_id,
      'recipientEnding', right(v_wa_id, 4),
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

revoke all on function public.ai_trim_reset_fragments_v3(jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.ai_append_client_turn_fragment_v3(uuid, uuid, uuid, text, text, jsonb, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.ai_claim_turn_jobs_v3(text, integer, uuid[])
  from public, anon, authenticated;
revoke all on function public.ai_create_manual_candidate_v3(uuid, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_trim_reset_fragments_v3(jsonb, integer)
  to service_role;
grant execute on function public.ai_append_client_turn_fragment_v3(uuid, uuid, uuid, text, text, jsonb, timestamptz, jsonb)
  to service_role;
grant execute on function public.ai_claim_turn_jobs_v3(text, integer, uuid[])
  to service_role;
grant execute on function public.ai_create_manual_candidate_v3(uuid, uuid, integer, text, text)
  to service_role;

commit;
