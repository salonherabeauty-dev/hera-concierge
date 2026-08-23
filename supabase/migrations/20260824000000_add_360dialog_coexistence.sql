begin;

alter table public.ai_conversations
  add column if not exists human_takeover_until timestamptz;

create index if not exists ai_conversations_human_takeover_idx
  on public.ai_conversations(human_takeover_until)
  where operating_mode = 'management';

create or replace function public.ai_ingest_whatsapp_message(
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
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_job_id uuid;
  v_inserted boolean := false;
  v_operating_mode text;
  v_takeover_until timestamptz;
  v_human_takeover_active boolean := false;
begin
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then
    raise exception 'provider message id is required';
  end if;

  if p_wa_id is null or p_wa_id !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid WhatsApp id';
  end if;

  if p_kind not in (
    'text', 'image', 'audio', 'video', 'document', 'sticker',
    'interactive', 'button', 'location', 'contacts', 'reaction',
    'order', 'system', 'unknown'
  ) then
    raise exception 'invalid message kind';
  end if;

  insert into public.ai_contacts (wa_id, profile_name, last_seen_at, updated_at)
  values (p_wa_id, nullif(trim(p_profile_name), ''), now(), now())
  on conflict (wa_id) do update
    set profile_name = coalesce(excluded.profile_name, public.ai_contacts.profile_name),
        last_seen_at = now(),
        updated_at = now()
  returning id into v_contact_id;

  insert into public.ai_conversations (contact_id, status, last_message_at, updated_at)
  values (v_contact_id, 'active', coalesce(p_provider_timestamp, now()), now())
  on conflict (contact_id) where status = 'active' do update
    set last_message_at = greatest(
          public.ai_conversations.last_message_at,
          excluded.last_message_at
        ),
        updated_at = now()
  returning id into v_conversation_id;

  select operating_mode, human_takeover_until
    into v_operating_mode, v_takeover_until
  from public.ai_conversations
  where id = v_conversation_id
  for update;

  if v_operating_mode = 'management' then
    if v_takeover_until is null or v_takeover_until > now() then
      v_human_takeover_active := true;
    else
      update public.ai_conversations
      set operating_mode = 'ai',
          human_takeover_until = null,
          state = state
            - 'humanTakeoverUntil'
            - 'humanTakeoverProvider'
            - 'lastHumanMessageId',
          updated_at = now()
      where id = v_conversation_id;
    end if;
  end if;

  insert into public.ai_messages (
    conversation_id,
    contact_id,
    provider_message_id,
    direction,
    kind,
    text_body,
    media,
    context_message_id,
    raw_payload,
    delivery_status,
    provider_timestamp
  ) values (
    v_conversation_id,
    v_contact_id,
    p_provider_message_id,
    'inbound',
    p_kind,
    coalesce(p_text, ''),
    p_media,
    p_context_message_id,
    p_raw,
    'received',
    p_provider_timestamp
  )
  on conflict (provider_message_id) where provider_message_id is not null do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    v_inserted := true;

    if not v_human_takeover_active then
      insert into public.ai_jobs (
        kind,
        source_message_id,
        dedupe_key,
        payload
      ) values (
        'process_inbound',
        v_message_id,
        'inbound:' || p_provider_message_id,
        jsonb_build_object(
          'messageId', v_message_id,
          'phoneNumberId', p_phone_number_id,
          'businessAccountId', p_business_account_id
        )
      )
      on conflict (dedupe_key) do nothing
      returning id into v_job_id;
    end if;
  else
    select id, conversation_id, contact_id
      into v_message_id, v_conversation_id, v_contact_id
    from public.ai_messages
    where provider_message_id = p_provider_message_id;

    select id into v_job_id
    from public.ai_jobs
    where dedupe_key = 'inbound:' || p_provider_message_id;
  end if;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'system',
    'whatsapp_webhook',
    case
      when not v_inserted then 'duplicate_ignored'
      when v_human_takeover_active then 'message_recorded_human_takeover'
      else 'message_ingested'
    end,
    'message',
    v_message_id::text,
    jsonb_build_object(
      'providerMessageId', p_provider_message_id,
      'suppressedByHumanTakeover', v_human_takeover_active
    )
  );

  return jsonb_build_object(
    'inserted', v_inserted,
    'messageId', v_message_id,
    'conversationId', v_conversation_id,
    'contactId', v_contact_id,
    'jobId', v_job_id,
    'suppressedByHumanTakeover', v_human_takeover_active
  );
end;
$$;

create or replace function public.ai_ingest_whatsapp_human_echo(
  p_provider_message_id text,
  p_wa_id text,
  p_phone_number_id text,
  p_business_account_id text,
  p_kind text,
  p_text text,
  p_media jsonb,
  p_context_message_id text,
  p_provider_timestamp timestamptz,
  p_takeover_until timestamptz,
  p_raw jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_inserted boolean := false;
  v_effective_takeover_until timestamptz;
begin
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then
    raise exception 'provider message id is required';
  end if;

  if p_wa_id is null or p_wa_id !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid WhatsApp id';
  end if;

  if p_kind not in (
    'text', 'image', 'audio', 'video', 'document', 'sticker',
    'interactive', 'button', 'location', 'contacts', 'reaction',
    'order', 'system', 'unknown'
  ) then
    raise exception 'invalid message kind';
  end if;

  if p_takeover_until is null then
    raise exception 'human takeover expiry is required';
  end if;

  insert into public.ai_contacts (wa_id, last_seen_at, updated_at)
  values (p_wa_id, now(), now())
  on conflict (wa_id) do update
    set last_seen_at = now(),
        updated_at = now()
  returning id into v_contact_id;

  insert into public.ai_conversations (contact_id, status, last_message_at, updated_at)
  values (v_contact_id, 'active', coalesce(p_provider_timestamp, now()), now())
  on conflict (contact_id) where status = 'active' do update
    set last_message_at = greatest(
          public.ai_conversations.last_message_at,
          excluded.last_message_at
        ),
        updated_at = now()
  returning id into v_conversation_id;

  insert into public.ai_messages (
    conversation_id,
    contact_id,
    provider_message_id,
    direction,
    kind,
    text_body,
    media,
    context_message_id,
    raw_payload,
    ai_generated,
    delivery_status,
    provider_timestamp
  ) values (
    v_conversation_id,
    v_contact_id,
    p_provider_message_id,
    'outbound',
    p_kind,
    coalesce(p_text, ''),
    p_media,
    p_context_message_id,
    p_raw,
    false,
    'sent',
    p_provider_timestamp
  )
  on conflict (provider_message_id) where provider_message_id is not null do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    v_inserted := true;
    v_effective_takeover_until := p_takeover_until;

    if p_takeover_until > now() then
      update public.ai_conversations
      set operating_mode = 'management',
          human_takeover_until = greatest(
            coalesce(human_takeover_until, p_takeover_until),
            p_takeover_until
          ),
          state = state || jsonb_build_object(
            'humanTakeoverUntil', greatest(
              coalesce(human_takeover_until, p_takeover_until),
              p_takeover_until
            ),
            'humanTakeoverProvider', '360dialog_coexistence',
            'lastHumanMessageId', p_provider_message_id
          ),
          updated_at = now()
      where id = v_conversation_id
      returning human_takeover_until into v_effective_takeover_until;

      update public.ai_jobs as job
      set status = 'completed',
          completed_at = now(),
          locked_at = null,
          locked_by = null,
          last_error = 'superseded_by_human_takeover',
          updated_at = now()
      from public.ai_messages as message
      where job.source_message_id = message.id
        and message.conversation_id = v_conversation_id
        and job.status in ('pending', 'retry');

      update public.ai_outbox
      set status = 'shadowed',
          locked_at = null,
          locked_by = null,
          last_error = 'superseded_by_human_takeover',
          updated_at = now()
      where conversation_id = v_conversation_id
        and target_type = 'client'
        and status in ('pending', 'retry', 'processing');
    end if;
  else
    select id, conversation_id, contact_id
      into v_message_id, v_conversation_id, v_contact_id
    from public.ai_messages
    where provider_message_id = p_provider_message_id;

    select coalesce(human_takeover_until, p_takeover_until)
      into v_effective_takeover_until
    from public.ai_conversations
    where id = v_conversation_id;
  end if;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'management',
    'whatsapp_business_app',
    case when v_inserted then 'human_message_echo_ingested' else 'human_message_echo_duplicate' end,
    'message',
    v_message_id::text,
    jsonb_build_object(
      'providerMessageId', p_provider_message_id,
      'phoneNumberId', p_phone_number_id,
      'businessAccountId', p_business_account_id,
      'takeoverUntil', v_effective_takeover_until
    )
  );

  return jsonb_build_object(
    'inserted', v_inserted,
    'messageId', v_message_id,
    'conversationId', v_conversation_id,
    'contactId', v_contact_id,
    'takeoverUntil', v_effective_takeover_until
  );
end;
$$;

create or replace function public.ai_authorize_whatsapp_outbox_send(
  p_outbox_id uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.ai_outbox%rowtype;
  v_mode text;
  v_takeover_until timestamptz;
  v_active boolean := false;
begin
  select * into v_item
  from public.ai_outbox
  where id = p_outbox_id
  for update;

  if not found then
    raise exception 'outbox item not found';
  end if;

  if v_item.status <> 'processing' then
    if v_item.status = 'shadowed' then
      return 'shadowed';
    end if;
    return 'dead';
  end if;

  if v_item.send_authorization <> 'auto' then
    update public.ai_outbox
    set status = 'shadowed',
        locked_at = null,
        locked_by = null,
        last_error = 'outbox_not_auto_authorized',
        updated_at = now()
    where id = p_outbox_id;
    return 'shadowed';
  end if;

  if v_item.target_type <> 'client' then
    return 'authorized';
  end if;

  if v_item.conversation_id is null then
    update public.ai_outbox
    set status = 'dead',
        locked_at = null,
        locked_by = null,
        last_error = 'client_outbox_missing_conversation',
        updated_at = now()
    where id = p_outbox_id;
    return 'dead';
  end if;

  select operating_mode, human_takeover_until
    into v_mode, v_takeover_until
  from public.ai_conversations
  where id = v_item.conversation_id
  for update;

  if not found then
    update public.ai_outbox
    set status = 'dead',
        locked_at = null,
        locked_by = null,
        last_error = 'client_outbox_conversation_not_found',
        updated_at = now()
    where id = p_outbox_id;
    return 'dead';
  end if;

  if v_mode = 'management' then
    if v_takeover_until is null or v_takeover_until > now() then
      v_active := true;
    else
      update public.ai_conversations
      set operating_mode = 'ai',
          human_takeover_until = null,
          state = state
            - 'humanTakeoverUntil'
            - 'humanTakeoverProvider'
            - 'lastHumanMessageId',
          updated_at = now()
      where id = v_item.conversation_id;
    end if;
  end if;

  if v_active then
    update public.ai_outbox
    set status = 'shadowed',
        locked_at = null,
        locked_by = null,
        last_error = 'blocked_by_human_takeover',
        updated_at = now()
    where id = p_outbox_id;

    insert into public.ai_audit_log (
      actor_type,
      actor_id,
      event_type,
      target_type,
      target_id,
      details
    ) values (
      'system',
      'hera_receptionist',
      'outbox_blocked_human_takeover',
      'outbox',
      p_outbox_id::text,
      jsonb_build_object(
        'conversationId', v_item.conversation_id,
        'takeoverUntil', v_takeover_until
      )
    );
    return 'shadowed';
  end if;

  return 'authorized';
end;
$$;

revoke all on function public.ai_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_ingest_whatsapp_human_echo(
  text, text, text, text, text, text, jsonb, text, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_authorize_whatsapp_outbox_send(uuid)
  from public, anon, authenticated;

grant execute on function public.ai_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;
grant execute on function public.ai_ingest_whatsapp_human_echo(
  text, text, text, text, text, text, jsonb, text, timestamptz, timestamptz, jsonb
) to service_role;
grant execute on function public.ai_authorize_whatsapp_outbox_send(uuid)
  to service_role;

commit;
