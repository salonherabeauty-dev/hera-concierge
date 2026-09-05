begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Prevent the previous completion function from changing a reservation while
-- this migration validates and restores the historical sent rows.
lock table public.ai_human_send_reservations_v3
  in share row exclusive mode;

-- A 360dialog acknowledgement is not a complete send until the outbound
-- transcript row and conversation timestamp are durable in the same database
-- transaction. Re-running completion is safe and repairs an older incomplete
-- completion without contacting either WhatsApp or an AI provider.
create or replace function public.ai_complete_human_send_v3(
  p_reservation_id uuid,
  p_provider_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_reservation public.ai_human_send_reservations_v3%rowtype;
  v_existing_message public.ai_messages%rowtype;
  v_requested_provider_message_id text := pg_catalog.left(
    pg_catalog.btrim(coalesce(p_provider_message_id, '')),
    300
  );
  v_provider_message_id text;
  v_completed_at timestamptz;
  v_message_at timestamptz;
  v_message_id uuid;
  v_message_inserted boolean := false;
  v_transitioned_to_sent boolean := false;
begin
  select reservation.* into strict v_reservation
  from public.ai_human_send_reservations_v3 as reservation
  where reservation.id = p_reservation_id
  for update;

  -- The human click is the chronology boundary. If a new client message is
  -- ingested while 360dialog is responding, that newer inbound must remain
  -- the latest message and must still require a reply.
  v_message_at := v_reservation.reserved_at;

  if v_reservation.status = 'sent' then
    v_provider_message_id := v_reservation.provider_message_id;
    if pg_catalog.length(pg_catalog.btrim(coalesce(v_provider_message_id, ''))) < 8 then
      raise exception 'reset_v3_sent_reservation_missing_provider_message_id'
        using errcode = '23514';
    end if;
    -- Once acknowledged, the provider id stored on the locked reservation is
    -- authoritative. This path must always be able to repair a missing message
    -- row, even if a replay omits or supplies a stale request parameter.
    v_completed_at := v_reservation.completed_at;
  elsif v_reservation.status = 'reserved' then
    if pg_catalog.length(v_requested_provider_message_id) < 8 then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'code', 'send_completion_invalid'
      );
    end if;
    v_provider_message_id := v_requested_provider_message_id;
    v_completed_at := pg_catalog.now();
    update public.ai_human_send_reservations_v3
    set status = 'sent',
        provider_message_id = v_provider_message_id,
        completed_at = v_completed_at,
        failure_code = null,
        updated_at = v_completed_at
    where id = v_reservation.id;
    v_transitioned_to_sent := true;
  else
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'code', 'send_completion_invalid'
    );
  end if;

  if v_completed_at is null then
    raise exception 'reset_v3_sent_reservation_missing_completion_time'
      using errcode = '23514';
  end if;
  if v_message_at is null then
    raise exception 'reset_v3_reservation_missing_chronology_time'
      using errcode = '23514';
  end if;

  select conversation.contact_id into strict v_contact_id
  from public.ai_conversations as conversation
  where conversation.id = v_reservation.conversation_id
  for update;

  update public.ai_reply_candidates_v3
  set status = 'sent',
      updated_at = pg_catalog.now()
  where id = v_reservation.candidate_id;

  insert into public.ai_messages (
    conversation_id,
    contact_id,
    provider_message_id,
    direction,
    kind,
    text_body,
    ai_generated,
    delivery_status,
    provider_timestamp,
    created_at,
    updated_at
  ) values (
    v_reservation.conversation_id,
    v_contact_id,
    v_provider_message_id,
    'outbound',
    'text',
    v_reservation.final_text,
    false,
    'sent',
    v_message_at,
    v_message_at,
    pg_catalog.now()
  )
  on conflict (provider_message_id)
    where provider_message_id is not null
    do nothing
  returning id into v_message_id;
  v_message_inserted := found;

  if not v_message_inserted then
    select message.* into strict v_existing_message
    from public.ai_messages as message
    where message.provider_message_id = v_provider_message_id
    for update;

    if v_existing_message.conversation_id is distinct from v_reservation.conversation_id
       or v_existing_message.contact_id is distinct from v_contact_id
       or v_existing_message.direction is distinct from 'outbound'
       or v_existing_message.kind is distinct from 'text'
       or v_existing_message.text_body is distinct from v_reservation.final_text
    then
      raise exception 'reset_v3_provider_message_id_collision'
        using errcode = '23505';
    end if;

    update public.ai_messages
    set delivery_status = case
          when delivery_status in ('delivered', 'read', 'failed', 'deleted')
            then delivery_status
          else 'sent'
        end,
        provider_timestamp = coalesce(
          provider_timestamp,
          v_message_at
        ),
        updated_at = pg_catalog.now()
    where id = v_existing_message.id
    returning id into v_message_id;
  end if;

  update public.ai_conversations
  set last_message_at = greatest(last_message_at, v_message_at),
      updated_at = pg_catalog.now()
  where id = v_reservation.conversation_id;

  if v_transitioned_to_sent then
    insert into public.ai_audit_log (
      actor_type,
      actor_id,
      event_type,
      target_type,
      target_id,
      details
    ) values (
      'human',
      v_reservation.actor_user_id::text,
      'reset_v3_human_send_completed',
      'reply_candidate_v3',
      v_reservation.candidate_id::text,
      pg_catalog.jsonb_build_object(
        'reservationId', v_reservation.id,
        'providerMessageId', v_provider_message_id,
        'conversationId', v_reservation.conversation_id,
        'messageId', v_message_id,
        'recipientEnding', pg_catalog.right(v_reservation.to_wa_id, 4),
        'transcriptPersisted', true
      )
    );
  elsif v_message_inserted then
    insert into public.ai_audit_log (
      actor_type,
      actor_id,
      event_type,
      target_type,
      target_id,
      details
    ) values (
      'system',
      'reset_v3_send_persistence_recovery',
      'reset_v3_sent_message_persistence_recovered',
      'reply_candidate_v3',
      v_reservation.candidate_id::text,
      pg_catalog.jsonb_build_object(
        'reservationId', v_reservation.id,
        'providerMessageId', v_provider_message_id,
        'conversationId', v_reservation.conversation_id,
        'messageId', v_message_id,
        'providerCalled', false,
        'aiCalled', false
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'state', 'sent',
    'providerMessageId', v_provider_message_id,
    'messageId', v_message_id,
    'transcriptPersisted', true
  );
end;
$$;

revoke all on function public.ai_complete_human_send_v3(uuid, text)
  from public, anon, authenticated;
grant execute on function public.ai_complete_human_send_v3(uuid, text)
  to service_role;

-- Refuse to guess if a provider id is already attached to a different
-- transcript row. A collision aborts this entire migration transaction.
do $$
begin
  if exists (
    select 1
    from public.ai_human_send_reservations_v3 as reservation
    join public.ai_conversations as conversation
      on conversation.id = reservation.conversation_id
    join public.ai_messages as message
      on message.provider_message_id = reservation.provider_message_id
    where reservation.status = 'sent'
      and (
        message.conversation_id is distinct from reservation.conversation_id
        or message.contact_id is distinct from conversation.contact_id
        or message.direction is distinct from 'outbound'
        or message.kind is distinct from 'text'
        or message.text_body is distinct from reservation.final_text
      )
  ) then
    raise exception 'reset_v3_sent_message_backfill_collision'
      using errcode = '23505';
  end if;
end;
$$;

-- Restore every acknowledged Reset-v3 send that the previous completion
-- function omitted. Original human-click timestamps preserve transcript order
-- and cannot hide a client message received while the provider was replying.
with inserted_messages as (
  insert into public.ai_messages (
    conversation_id,
    contact_id,
    provider_message_id,
    direction,
    kind,
    text_body,
    ai_generated,
    delivery_status,
    provider_timestamp,
    created_at,
    updated_at
  )
  select
    reservation.conversation_id,
    conversation.contact_id,
    reservation.provider_message_id,
    'outbound',
    'text',
    reservation.final_text,
    false,
    'sent',
    reservation.reserved_at,
    reservation.reserved_at,
    pg_catalog.now()
  from public.ai_human_send_reservations_v3 as reservation
  join public.ai_conversations as conversation
    on conversation.id = reservation.conversation_id
  where reservation.status = 'sent'
    and nullif(
      pg_catalog.btrim(reservation.provider_message_id),
      ''
    ) is not null
    and reservation.completed_at is not null
  on conflict (provider_message_id)
    where provider_message_id is not null
    do nothing
  returning id, conversation_id, provider_message_id
)
insert into public.ai_audit_log (
  actor_type,
  actor_id,
  event_type,
  target_type,
  target_id,
  details
)
select
  'system',
  'reset_v3_sent_message_backfill',
  'reset_v3_sent_message_persistence_recovered',
  'reply_candidate_v3',
  reservation.candidate_id::text,
  pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'providerMessageId', inserted.provider_message_id,
    'conversationId', inserted.conversation_id,
    'messageId', inserted.id,
    'providerCalled', false,
    'aiCalled', false
  )
from inserted_messages as inserted
join public.ai_human_send_reservations_v3 as reservation
  on reservation.provider_message_id = inserted.provider_message_id;

with latest_reserved_send as (
  select
    reservation.conversation_id,
    max(reservation.reserved_at) as message_at
  from public.ai_human_send_reservations_v3 as reservation
  where reservation.status = 'sent'
    and reservation.reserved_at is not null
  group by reservation.conversation_id
)
update public.ai_conversations as conversation
set last_message_at = greatest(
      conversation.last_message_at,
      latest.message_at
    ),
    updated_at = pg_catalog.now()
from latest_reserved_send as latest
where conversation.id = latest.conversation_id
  and conversation.last_message_at < latest.message_at;

-- The migration commits only if every acknowledged reservation is now backed
-- by exactly one matching outbound transcript row.
do $$
begin
  if exists (
    select 1
    from public.ai_human_send_reservations_v3 as reservation
    join public.ai_conversations as conversation
      on conversation.id = reservation.conversation_id
    left join public.ai_messages as message
      on message.provider_message_id = reservation.provider_message_id
    where reservation.status = 'sent'
      and (
        reservation.provider_message_id is null
        or reservation.completed_at is null
        or message.id is null
        or message.conversation_id is distinct from reservation.conversation_id
        or message.contact_id is distinct from conversation.contact_id
        or message.direction is distinct from 'outbound'
        or message.kind is distinct from 'text'
        or message.text_body is distinct from reservation.final_text
      )
  ) then
    raise exception 'reset_v3_sent_message_backfill_incomplete'
      using errcode = '23514';
  end if;
end;
$$;

commit;
