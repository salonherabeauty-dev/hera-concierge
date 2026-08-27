begin;

create table public.ai_internal_pilot_send_permits (
  outbox_id uuid primary key
    references public.ai_outbox(id) on delete restrict,
  pilot_id text not null
    check (pilot_id ~ '^[a-z0-9][a-z0-9-]{7,79}$'),
  to_wa_id text not null
    check (to_wa_id ~ '^[1-9][0-9]{7,14}$'),
  reserved_at timestamptz not null default now()
);

create index ai_internal_pilot_send_permits_pilot_id_idx
  on public.ai_internal_pilot_send_permits(pilot_id, reserved_at);

alter table public.ai_internal_pilot_send_permits enable row level security;
alter table public.ai_internal_pilot_send_permits force row level security;

revoke all on table public.ai_internal_pilot_send_permits
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.ai_internal_pilot_send_permits
  to service_role;

create or replace function public.ai_authorize_internal_pilot_outbox_send(
  p_outbox_id uuid,
  p_pilot_id text,
  p_allowlisted_wa_ids text[],
  p_max_send_attempts integer
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item public.ai_outbox%rowtype;
  v_disposition text;
  v_reserved_count integer;
begin
  if current_user <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_pilot_id <> 'urgent-green-lane-2026-08-27' then
    raise exception 'invalid internal pilot id';
  end if;

  if p_max_send_attempts is null
     or p_max_send_attempts < 1
     or p_max_send_attempts > 10 then
    raise exception 'internal pilot send-attempt cap must be between 1 and 10';
  end if;

  if p_allowlisted_wa_ids is null
     or cardinality(p_allowlisted_wa_ids) < 1
     or cardinality(p_allowlisted_wa_ids) > 5 then
    raise exception 'internal pilot allowlist must contain 1 to 5 entries';
  end if;

  if exists (
    select 1
    from unnest(p_allowlisted_wa_ids) as allowed(wa_id)
    where allowed.wa_id !~ '^[1-9][0-9]{7,14}$'
  ) then
    raise exception 'invalid internal pilot allowlist entry';
  end if;

  if (
    select count(distinct allowed.wa_id)
    from unnest(p_allowlisted_wa_ids) as allowed(wa_id)
  ) <> cardinality(p_allowlisted_wa_ids) then
    raise exception 'duplicate internal pilot allowlist entry';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hera_internal_pilot:' || p_pilot_id, 0)
  );

  v_disposition := public.ai_authorize_whatsapp_outbox_send(p_outbox_id);
  if v_disposition <> 'authorized' then
    return v_disposition;
  end if;

  select * into v_item
  from public.ai_outbox
  where id = p_outbox_id
  for update;

  if v_item.target_type <> 'client'
     or v_item.send_authorization <> 'auto' then
    update public.ai_outbox
    set status = 'shadowed',
        locked_at = null,
        locked_by = null,
        last_error = 'internal_pilot_client_auto_only',
        updated_at = now()
    where id = p_outbox_id;
    return 'shadowed';
  end if;

  if not (v_item.to_wa_id = any(p_allowlisted_wa_ids)) then
    update public.ai_outbox
    set status = 'shadowed',
        locked_at = null,
        locked_by = null,
        last_error = 'internal_pilot_destination_not_allowlisted',
        updated_at = now()
    where id = p_outbox_id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'hera_receptionist',
      'internal_pilot_destination_blocked',
      'outbox',
      p_outbox_id::text,
      jsonb_build_object('pilotId', p_pilot_id)
    );
    return 'shadowed';
  end if;

  if exists (
    select 1
    from public.ai_internal_pilot_send_permits as permit
    where permit.outbox_id = p_outbox_id
  ) then
    update public.ai_outbox
    set status = 'dead',
        locked_at = null,
        locked_by = null,
        last_error = 'internal_pilot_duplicate_send_attempt_blocked',
        updated_at = now()
    where id = p_outbox_id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'hera_receptionist',
      'internal_pilot_duplicate_send_attempt_blocked',
      'outbox',
      p_outbox_id::text,
      jsonb_build_object('pilotId', p_pilot_id)
    );
    return 'dead';
  end if;

  select count(*)::integer into v_reserved_count
  from public.ai_internal_pilot_send_permits as permit
  where permit.pilot_id = p_pilot_id;

  if v_reserved_count >= p_max_send_attempts then
    update public.ai_outbox
    set status = 'shadowed',
        locked_at = null,
        locked_by = null,
        last_error = 'internal_pilot_send_attempt_cap_reached',
        updated_at = now()
    where id = p_outbox_id;

    insert into public.ai_audit_log (
      actor_type, actor_id, event_type, target_type, target_id, details
    ) values (
      'system',
      'hera_receptionist',
      'internal_pilot_send_attempt_cap_reached',
      'outbox',
      p_outbox_id::text,
      jsonb_build_object(
        'pilotId', p_pilot_id,
        'reservedCount', v_reserved_count,
        'maxSendAttempts', p_max_send_attempts
      )
    );
    return 'shadowed';
  end if;

  insert into public.ai_internal_pilot_send_permits (
    outbox_id, pilot_id, to_wa_id
  ) values (
    p_outbox_id, p_pilot_id, v_item.to_wa_id
  );

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system',
    'hera_receptionist',
    'internal_pilot_send_permit_reserved',
    'outbox',
    p_outbox_id::text,
    jsonb_build_object(
      'pilotId', p_pilot_id,
      'permitOrdinal', v_reserved_count + 1,
      'maxSendAttempts', p_max_send_attempts
    )
  );

  return 'authorized';
end;
$$;

revoke all on function public.ai_authorize_internal_pilot_outbox_send(
  uuid, text, text[], integer
) from public, anon, authenticated;
grant execute on function public.ai_authorize_internal_pilot_outbox_send(
  uuid, text, text[], integer
) to service_role;

commit;
