begin;

create or replace function public.ai_cc_preflight_human_delivery_send(
  p_approved_outbox_id uuid,
  p_review_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
  p_expected_response_hash text,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.ai_human_delivery_reviews%rowtype;
  v_outbox public.ai_outbox%rowtype;
  v_latest_inbound_id uuid;
  v_source_effective_at timestamptz;
  v_source_created_at timestamptz;
  v_response_hash text;
  v_block_reason text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery_send:' || p_approved_outbox_id::text,
      0
    )
  );

  select * into v_review
  from public.ai_human_delivery_reviews
  where id = p_review_id
  for update;

  select * into v_outbox
  from public.ai_outbox
  where id = p_approved_outbox_id
  for update;

  if v_review.id is null or v_outbox.id is null then
    v_block_reason := 'send_reservation_not_found';
  elsif v_review.reviewer_user_id is distinct from p_actor_user_id then
    v_block_reason := 'send_reservation_actor_mismatch';
  elsif v_review.decision <> 'approved'
     or v_review.delivery_status <> 'sending'
     or v_review.approved_outbox_id is distinct from v_outbox.id then
    v_block_reason := 'send_reservation_not_active';
  elsif v_outbox.status <> 'processing'
     or v_outbox.send_authorization <> 'management'
     or v_outbox.target_type <> 'client'
     or v_outbox.provider_message_id is not null then
    v_block_reason := 'approved_outbox_not_sendable';
  elsif v_outbox.source_message_id is distinct from p_expected_source_message_id
     or v_review.source_message_id is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  else
    v_response_hash := pg_catalog.encode(
      extensions.digest(coalesce(v_outbox.body->>'text', ''), 'sha256'),
      'hex'
    );

    if v_response_hash <> p_expected_response_hash
       or v_review.candidate_response_hash <> p_expected_response_hash then
      v_block_reason := 'candidate_hash_changed';
    elsif right(v_outbox.to_wa_id, 4) <> p_expected_phone_ending then
      v_block_reason := 'recipient_display_changed';
    else
      select message.id into v_latest_inbound_id
      from public.ai_messages as message
      where message.conversation_id = v_outbox.conversation_id
        and message.direction = 'inbound'
      order by
        coalesce(message.provider_timestamp, message.created_at) desc,
        message.created_at desc,
        message.id desc
      limit 1;

      if v_latest_inbound_id is distinct from v_outbox.source_message_id then
        v_block_reason := 'candidate_not_latest';
      else
        select
          coalesce(message.provider_timestamp, message.created_at),
          message.created_at
        into v_source_effective_at, v_source_created_at
        from public.ai_messages as message
        where message.id = v_outbox.source_message_id
          and message.conversation_id = v_outbox.conversation_id
          and message.direction = 'inbound';

        if not found then
          v_block_reason := 'source_message_not_found';
        elsif now() - v_source_effective_at >= interval '24 hours' then
          v_block_reason := 'customer_service_window_expired';
        elsif exists (
          select 1
          from public.ai_messages as message
          where message.conversation_id = v_outbox.conversation_id
            and message.direction = 'outbound'
            and (
              coalesce(message.provider_timestamp, message.created_at) > v_source_effective_at
              or (
                coalesce(message.provider_timestamp, message.created_at) = v_source_effective_at
                and message.created_at > v_source_created_at
              )
            )
        ) then
          v_block_reason := 'human_reply_already_recorded';
        end if;
      end if;
    end if;
  end if;

  if v_block_reason is not null then
    if v_outbox.id is not null then
      update public.ai_outbox
      set status = 'dead',
          locked_at = null,
          locked_by = null,
          last_error = 'human_delivery_preflight_' || v_block_reason,
          updated_at = now()
      where id = v_outbox.id
        and provider_message_id is null;
    end if;

    if v_review.id is not null then
      update public.ai_human_delivery_reviews
      set delivery_status = 'failed',
          failure_code = v_block_reason,
          updated_at = now()
      where id = v_review.id
        and delivery_status = 'sending';
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
      p_actor_user_id::text,
      'human_delivery_preflight_blocked',
      'outbox',
      p_approved_outbox_id::text,
      jsonb_build_object(
        'code', v_block_reason,
        'reviewId', p_review_id,
        'sourceMessageId', p_expected_source_message_id,
        'responseHash', p_expected_response_hash,
        'phoneEnding', p_expected_phone_ending
      )
    );

    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', v_block_reason,
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'state', 'ready_to_send',
    'code', null,
    'candidateId', v_review.candidate_outbox_id,
    'approvedOutboxId', v_outbox.id,
    'reviewId', v_review.id,
    'conversationId', v_outbox.conversation_id,
    'sourceMessageId', v_outbox.source_message_id,
    'responseHash', v_response_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'toWaId', v_outbox.to_wa_id,
    'messageText', v_outbox.body->>'text',
    'deliveryStatus', 'sending',
    'providerMessageId', null,
    'details', jsonb_build_object('doubleChecked', true)
  );
end;
$$;

create or replace function public.ai_cc_complete_human_delivery_send(
  p_approved_outbox_id uuid,
  p_review_id uuid,
  p_actor_user_id uuid,
  p_provider_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.ai_human_delivery_reviews%rowtype;
  v_outbox public.ai_outbox%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery_send:' || p_approved_outbox_id::text,
      0
    )
  );

  select * into v_review
  from public.ai_human_delivery_reviews
  where id = p_review_id
  for update;

  select * into v_outbox
  from public.ai_outbox
  where id = p_approved_outbox_id
  for update;

  if v_review.id is null
     or v_outbox.id is null
     or v_review.approved_outbox_id is distinct from v_outbox.id
     or v_review.reviewer_user_id is distinct from p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_reservation_not_found',
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id
    );
  end if;

  if v_review.delivery_status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'code', null,
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id,
      'providerMessageId', v_review.provider_message_id,
      'deliveryStatus', 'sent'
    );
  end if;

  if v_review.delivery_status <> 'sending'
     or length(trim(coalesce(p_provider_message_id, ''))) < 8 then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_completion_invalid',
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id
    );
  end if;

  perform public.ai_mark_outbox_sent(
    v_outbox.id,
    trim(p_provider_message_id)
  );

  update public.ai_human_delivery_reviews
  set delivery_status = 'sent',
      provider_message_id = trim(p_provider_message_id),
      sent_at = now(),
      failure_code = null,
      updated_at = now()
  where id = v_review.id;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'management',
    p_actor_user_id::text,
    'human_delivery_sent',
    'outbox',
    v_outbox.id::text,
    jsonb_build_object(
      'reviewId', v_review.id,
      'candidateOutboxId', v_review.candidate_outbox_id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'responseHash', v_review.candidate_response_hash,
      'reviewerRole', v_review.reviewer_role,
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'providerMessageId', trim(p_provider_message_id),
      'deliveryMode', v_review.delivery_mode
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'sent',
    'code', null,
    'candidateId', v_review.candidate_outbox_id,
    'approvedOutboxId', v_outbox.id,
    'reviewId', v_review.id,
    'conversationId', v_outbox.conversation_id,
    'sourceMessageId', v_outbox.source_message_id,
    'responseHash', v_review.candidate_response_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'deliveryStatus', 'sent',
    'providerMessageId', trim(p_provider_message_id),
    'details', jsonb_build_object(
      'reviewerRole', v_review.reviewer_role,
      'namedHumanApproval', true
    )
  );
end;
$$;

create or replace function public.ai_cc_fail_human_delivery_send(
  p_approved_outbox_id uuid,
  p_review_id uuid,
  p_actor_user_id uuid,
  p_failure_code text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.ai_human_delivery_reviews%rowtype;
  v_outbox public.ai_outbox%rowtype;
  v_code text;
begin
  v_code := left(
    regexp_replace(
      lower(coalesce(p_failure_code, 'provider_send_failed')),
      '[^a-z0-9_]+',
      '_',
      'g'
    ),
    120
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery_send:' || p_approved_outbox_id::text,
      0
    )
  );

  select * into v_review
  from public.ai_human_delivery_reviews
  where id = p_review_id
  for update;

  select * into v_outbox
  from public.ai_outbox
  where id = p_approved_outbox_id
  for update;

  if v_review.id is null
     or v_outbox.id is null
     or v_review.approved_outbox_id is distinct from v_outbox.id
     or v_review.reviewer_user_id is distinct from p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_reservation_not_found',
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id
    );
  end if;

  if v_review.delivery_status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'code', null,
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id,
      'providerMessageId', v_review.provider_message_id,
      'deliveryStatus', 'sent'
    );
  end if;

  update public.ai_outbox
  set status = 'dead',
      locked_at = null,
      locked_by = null,
      last_error = 'human_delivery_' || v_code,
      updated_at = now()
  where id = v_outbox.id
    and provider_message_id is null;

  update public.ai_human_delivery_reviews
  set delivery_status = 'failed',
      failure_code = v_code,
      updated_at = now()
  where id = v_review.id
    and delivery_status <> 'sent';

  perform public.ai_cc_set_conversation_mode(
    v_outbox.conversation_id,
    p_actor_user_id,
    'management',
    'Human-approved WhatsApp delivery failed; a receptionist must respond manually.',
    null
  );

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'management',
    p_actor_user_id::text,
    'human_delivery_send_failed',
    'outbox',
    v_outbox.id::text,
    jsonb_build_object(
      'reviewId', v_review.id,
      'candidateOutboxId', v_review.candidate_outbox_id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'responseHash', v_review.candidate_response_hash,
      'reviewerRole', v_review.reviewer_role,
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'failureCode', v_code,
      'deliveryMode', v_review.delivery_mode
    )
  );

  return jsonb_build_object(
    'ok', false,
    'state', 'send_failed_human_takeover',
    'code', v_code,
    'candidateId', v_review.candidate_outbox_id,
    'approvedOutboxId', v_outbox.id,
    'reviewId', v_review.id,
    'conversationId', v_outbox.conversation_id,
    'sourceMessageId', v_outbox.source_message_id,
    'responseHash', v_review.candidate_response_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'deliveryStatus', 'failed',
    'providerMessageId', null,
    'details', jsonb_build_object(
      'reviewerRole', v_review.reviewer_role,
      'conversationMode', 'management'
    )
  );
end;
$$;

commit;
