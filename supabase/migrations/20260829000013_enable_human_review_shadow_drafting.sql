begin;

create or replace function public.ai_ingest_whatsapp_message_human_review(
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
  v_job_id uuid;
  v_message_id uuid;
  v_conversation_id uuid;
  v_human_review_only boolean := false;
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

  if nullif(v_result->>'messageId', '') is not null then
    v_message_id := (v_result->>'messageId')::uuid;
  end if;
  if nullif(v_result->>'conversationId', '') is not null then
    v_conversation_id := (v_result->>'conversationId')::uuid;
  end if;
  if nullif(v_result->>'jobId', '') is not null then
    v_job_id := (v_result->>'jobId')::uuid;
  end if;

  v_human_review_only := coalesce(
    nullif(v_result->>'suppressedByHumanTakeover', '')::boolean,
    false
  );

  if coalesce(nullif(v_result->>'inserted', '')::boolean, false)
     and v_human_review_only
     and p_kind not in ('reaction', 'system')
     and coalesce(p_provider_timestamp, now()) >= now() - interval '1 hour'
  then
    insert into public.ai_jobs (
      kind,
      source_message_id,
      dedupe_key,
      payload,
      status,
      attempts,
      max_attempts,
      available_at
    ) values (
      'process_inbound',
      v_message_id,
      'inbound:' || p_provider_message_id,
      jsonb_build_object(
        'messageId', v_message_id,
        'phoneNumberId', p_phone_number_id,
        'businessAccountId', p_business_account_id,
        'humanReviewOnly', true
      ),
      'pending',
      0,
      5,
      now()
    )
    on conflict (dedupe_key) do nothing
    returning id into v_job_id;

    if v_job_id is null then
      select job.id into v_job_id
      from public.ai_jobs as job
      where job.dedupe_key = 'inbound:' || p_provider_message_id
      limit 1;
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
      'human_review_shadow_draft_enqueued',
      'message',
      v_message_id::text,
      jsonb_build_object(
        'conversationId', v_conversation_id,
        'jobId', v_job_id,
        'humanHandlingPreserved', true,
        'automaticDeliveryAllowed', false
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'jobId', v_job_id,
    'humanReviewOnly', v_human_review_only,
    'automaticDeliveryAllowed', false
  );
end;
$$;

revoke all on function public.ai_ingest_whatsapp_message_human_review(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  jsonb
) from public, anon, authenticated;
grant execute on function public.ai_ingest_whatsapp_message_human_review(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  jsonb
) to service_role;

create or replace function public.ai_cc_request_receptionist_draft(
  p_actor_user_id uuid,
  p_conversation_id uuid,
  p_source_message_id uuid,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_source public.ai_messages%rowtype;
  v_conversation public.ai_conversations%rowtype;
  v_wa_id text;
  v_latest_inbound_id uuid;
  v_source_at timestamptz;
  v_candidate_id uuid;
  v_job_id uuid;
  v_job_status text;
  v_dedupe_key text;
begin
  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'inactive_staff');
  end if;
  if v_role not in ('owner', 'managing_director', 'salon_manager', 'receptionist') then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'role_not_authorized');
  end if;
  if p_expected_phone_ending is null or p_expected_phone_ending !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'recipient_display_invalid');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('front-desk-draft:' || p_source_message_id::text)
  );

  select * into v_source
  from public.ai_messages
  where id = p_source_message_id
    and conversation_id = p_conversation_id
    and direction = 'inbound';
  if not found then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'source_message_not_found');
  end if;
  if v_source.kind in ('reaction', 'system') then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'message_not_reply_worthy');
  end if;

  select * into v_conversation
  from public.ai_conversations
  where id = p_conversation_id;
  if not found or v_conversation.status <> 'active' then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'conversation_not_active');
  end if;

  select contact.wa_id into v_wa_id
  from public.ai_contacts as contact
  where contact.id = v_conversation.contact_id;
  if v_wa_id is null or right(v_wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'recipient_mismatch');
  end if;

  select message.id into v_latest_inbound_id
  from public.ai_messages as message
  where message.conversation_id = p_conversation_id
    and message.direction = 'inbound'
  order by
    coalesce(message.provider_timestamp, message.created_at) desc,
    message.created_at desc,
    message.id desc
  limit 1;
  if v_latest_inbound_id is distinct from p_source_message_id then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'source_message_not_latest');
  end if;

  v_source_at := coalesce(v_source.provider_timestamp, v_source.created_at);
  if now() - v_source_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'customer_service_window_expired');
  end if;

  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = p_conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at) > v_source_at
        or (
          coalesce(message.provider_timestamp, message.created_at) = v_source_at
          and message.created_at > v_source.created_at
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'state', 'blocked', 'code', 'human_reply_already_recorded');
  end if;

  select outbox.id into v_candidate_id
  from public.ai_outbox as outbox
  where outbox.source_message_id = p_source_message_id
    and outbox.conversation_id = p_conversation_id
    and outbox.target_type = 'client'
    and outbox.provider_message_id is null
    and outbox.status in ('pending', 'shadowed')
  order by outbox.created_at desc
  limit 1;
  if v_candidate_id is not null then
    return jsonb_build_object(
      'ok', true,
      'state', 'candidate_exists',
      'code', null,
      'candidateId', v_candidate_id,
      'conversationId', p_conversation_id,
      'sourceMessageId', p_source_message_id,
      'jobId', null,
      'phoneEnding', right(v_wa_id, 4)
    );
  end if;

  select job.id, job.status into v_job_id, v_job_status
  from public.ai_jobs as job
  where job.source_message_id = p_source_message_id
    and job.status in ('pending', 'processing', 'retry')
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then
    return jsonb_build_object(
      'ok', true,
      'state', 'job_exists',
      'code', null,
      'candidateId', null,
      'conversationId', p_conversation_id,
      'sourceMessageId', p_source_message_id,
      'jobId', v_job_id,
      'jobStatus', v_job_status,
      'phoneEnding', right(v_wa_id, 4)
    );
  end if;

  v_dedupe_key := 'front-desk-draft:' || p_source_message_id::text || ':' ||
    to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MI');

  insert into public.ai_jobs (
    kind,
    source_message_id,
    dedupe_key,
    payload,
    status,
    attempts,
    max_attempts,
    available_at
  ) values (
    'process_inbound',
    p_source_message_id,
    v_dedupe_key,
    jsonb_build_object(
      'messageId', p_source_message_id,
      'humanReviewOnly', true,
      'requestedByUserId', p_actor_user_id
    ),
    'pending',
    0,
    1,
    now()
  )
  on conflict (dedupe_key) do update
    set updated_at = public.ai_jobs.updated_at
  returning id into v_job_id;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'human',
    p_actor_user_id::text,
    'receptionist_shadow_draft_requested',
    'message',
    p_source_message_id::text,
    jsonb_build_object(
      'conversationId', p_conversation_id,
      'jobId', v_job_id,
      'phoneEnding', right(v_wa_id, 4),
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'draft_requested',
    'code', null,
    'candidateId', null,
    'conversationId', p_conversation_id,
    'sourceMessageId', p_source_message_id,
    'jobId', v_job_id,
    'jobStatus', 'pending',
    'phoneEnding', right(v_wa_id, 4)
  );
end;
$$;

revoke all on function public.ai_cc_request_receptionist_draft(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_request_receptionist_draft(
  uuid,
  uuid,
  uuid,
  text
) to service_role;

commit;
