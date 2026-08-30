begin;

-- The ingestion transaction marks the previous turn as superseded before it
-- inserts the replacement turn. Defer this self-reference until transaction
-- commit so that the new turn may be inserted safely and atomically.
alter table public.ai_reset_client_turns
  drop constraint if exists ai_reset_client_turns_superseded_by_fkey;
alter table public.ai_reset_client_turns
  add constraint ai_reset_client_turns_superseded_by_fkey
  foreign key (superseded_by_turn_id)
  references public.ai_reset_client_turns(id)
  on delete set null
  deferrable initially deferred;

create or replace function public.ai_reset_prepare_client_turn_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous public.ai_reset_client_turns%rowtype;
  v_next_version integer;
  v_new_text text;
  v_merge_window interval;
begin
  select coalesce(max(turn.version), 0) + 1
    into v_next_version
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = new.conversation_id;
  new.version := v_next_version;

  -- The original ingest function updates the immediate predecessor with the
  -- replacement id before inserting this row. That gives this trigger an exact,
  -- race-safe predecessor without relying on wall-clock ordering.
  select turn.*
    into v_previous
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = new.conversation_id
    and turn.superseded_by_turn_id = new.id
  order by turn.version desc
  limit 1;

  if v_previous.id is null then
    return new;
  end if;

  -- Text fragments sent within 30 seconds belong to one client turn. Media or
  -- an unreadable WhatsApp item may arrive later because upload and provider
  -- processing take longer, so preserve the preceding substantive turn for up
  -- to two minutes. The newest fragment still moves the rolling settle time.
  v_merge_window := case
    when jsonb_array_length(coalesce(new.attachments, '[]'::jsonb)) > 0
      then interval '2 minutes'
    else interval '30 seconds'
  end;

  if new.last_fragment_at >= v_previous.last_fragment_at
     and new.last_fragment_at - v_previous.last_fragment_at <= v_merge_window
  then
    new.fragment_ids := v_previous.fragment_ids || new.fragment_ids;
    new.first_fragment_at := v_previous.first_fragment_at;
    new.attachments :=
      coalesce(v_previous.attachments, '[]'::jsonb)
      || coalesce(new.attachments, '[]'::jsonb);

    v_new_text := btrim(coalesce(new.assembled_text, ''));
    if v_new_text = 'The client sent one or more attachments. Inspect the attached content before drafting.' then
      v_new_text := '';
    end if;
    new.assembled_text := left(
      btrim(concat_ws(E'\n', nullif(v_previous.assembled_text, ''), nullif(v_new_text, ''))),
      24000
    );
    if length(new.assembled_text) = 0 then
      new.assembled_text :=
        'The client sent one or more attachments. Inspect all available attachment content before drafting.';
    end if;
    new.settle_at := greatest(new.settle_at, now() + interval '8 seconds');
  end if;

  return new;
end;
$$;

revoke all on function public.ai_reset_prepare_client_turn_insert()
  from public, anon, authenticated;
grant execute on function public.ai_reset_prepare_client_turn_insert()
  to service_role;

drop trigger if exists ai_reset_prepare_client_turn_insert
  on public.ai_reset_client_turns;
create trigger ai_reset_prepare_client_turn_insert
before insert on public.ai_reset_client_turns
for each row
execute function public.ai_reset_prepare_client_turn_insert();

create or replace function public.ai_reset_audit_canonical_turn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'system',
    'hera_receptionist_reset',
    'reset_client_turn_canonicalized',
    'reset_client_turn',
    new.id::text,
    jsonb_build_object(
      'conversationId', new.conversation_id,
      'version', new.version,
      'fragmentCount', cardinality(new.fragment_ids),
      'attachmentCount', jsonb_array_length(new.attachments),
      'settleAt', new.settle_at,
      'deliveryControl', new.delivery_control,
      'automaticDeliveryAllowed', false
    )
  );
  return null;
end;
$$;

revoke all on function public.ai_reset_audit_canonical_turn()
  from public, anon, authenticated;
grant execute on function public.ai_reset_audit_canonical_turn()
  to service_role;

drop trigger if exists ai_reset_audit_canonical_turn
  on public.ai_reset_client_turns;
create trigger ai_reset_audit_canonical_turn
after insert on public.ai_reset_client_turns
for each row
execute function public.ai_reset_audit_canonical_turn();

create or replace function public.ai_reset_enforce_human_send_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_violation text;
begin
  v_violation := public.ai_tanglin_whatsapp_reply_violation(new.final_text);
  if v_violation is not null then
    raise exception
      'Tanglin Mall WhatsApp reply violates channel scope: %',
      v_violation
      using errcode = '23514';
  end if;

  -- A reservation whose provider outcome is unknown must never be recycled.
  -- This chooses a visible manual reconciliation over any risk of sending the
  -- same client reply twice. Confirmed provider failures transition to failed
  -- and may then be deliberately retried through a new reservation attempt.
  if tg_op = 'UPDATE'
     and old.status = 'reserved'
     and new.status = 'reserved'
  then
    raise exception 'human send is already reserved and requires reconciliation'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function public.ai_reset_enforce_human_send_record()
  from public, anon, authenticated;
grant execute on function public.ai_reset_enforce_human_send_record()
  to service_role;

drop trigger if exists ai_reset_enforce_human_send_record
  on public.ai_reset_human_sends;
create trigger ai_reset_enforce_human_send_record
before insert or update of status, final_text
on public.ai_reset_human_sends
for each row
execute function public.ai_reset_enforce_human_send_record();

create or replace function public.ai_reset_preflight_human_send(
  p_actor_user_id uuid,
  p_send_id uuid,
  p_expected_turn_id uuid,
  p_expected_candidate_hash text,
  p_expected_final_hash text,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_send public.ai_reset_human_sends%rowtype;
  v_draft public.ai_reset_draft_runs%rowtype;
  v_turn public.ai_reset_client_turns%rowtype;
  v_contact public.ai_contacts%rowtype;
  v_latest_turn_id uuid;
  v_violation text;
begin
  v_role := public.ai_reset_staff_role(p_actor_user_id);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_authorized');
  end if;

  select * into v_send
  from public.ai_reset_human_sends
  where id = p_send_id
  for update;
  if v_send.id is null then
    return jsonb_build_object('ok', false, 'code', 'send_not_found');
  end if;
  if v_send.actor_user_id is distinct from p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'actor_mismatch');
  end if;
  if v_send.status <> 'reserved' then
    return jsonb_build_object('ok', false, 'code', 'send_not_reserved');
  end if;
  if v_send.turn_id is distinct from p_expected_turn_id
     or v_send.candidate_hash is distinct from p_expected_candidate_hash
     or v_send.final_hash is distinct from p_expected_final_hash
     or v_send.expected_phone_ending is distinct from p_expected_phone_ending
  then
    return jsonb_build_object('ok', false, 'code', 'send_reservation_changed');
  end if;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = v_send.draft_run_id
  for update;
  if v_draft.id is null
     or v_draft.status <> 'ready'
     or v_draft.turn_id is distinct from v_send.turn_id
     or v_draft.candidate_hash is distinct from v_send.candidate_hash
  then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = v_send.turn_id
  for update;
  if v_turn.id is null or v_turn.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'turn_not_ready');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_turn.conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1;
  if v_latest_turn_id is distinct from v_turn.id then
    return jsonb_build_object('ok', false, 'code', 'newer_client_turn');
  end if;

  select * into v_contact
  from public.ai_contacts
  where id = v_turn.contact_id;
  if v_contact.id is null
     or v_contact.wa_id is distinct from v_send.to_wa_id
     or right(v_contact.wa_id, 4) is distinct from p_expected_phone_ending
  then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;

  if now() - v_turn.last_fragment_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'customer_service_window_expired');
  end if;
  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and coalesce(message.provider_timestamp, message.created_at)
        > v_turn.last_fragment_at
  ) then
    return jsonb_build_object('ok', false, 'code', 'human_reply_already_recorded');
  end if;

  v_violation := public.ai_tanglin_whatsapp_reply_violation(v_send.final_text);
  if v_violation is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'tanglin_channel_violation',
      'violation', v_violation
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'state', 'ready_to_send',
    'code', null,
    'sendId', v_send.id,
    'draftRunId', v_send.draft_run_id,
    'turnId', v_send.turn_id,
    'conversationId', v_send.conversation_id,
    'toWaId', v_send.to_wa_id,
    'phoneEnding', v_send.expected_phone_ending,
    'candidateHash', v_send.candidate_hash,
    'finalHash', v_send.final_hash,
    'messageText', v_send.final_text,
    'editedByHuman', v_send.edited_by_human,
    'channel', 'Tanglin Mall WhatsApp'
  );
end;
$$;

revoke all on function public.ai_reset_preflight_human_send(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.ai_reset_preflight_human_send(
  uuid, uuid, uuid, text, text, text
) to service_role;

commit;
