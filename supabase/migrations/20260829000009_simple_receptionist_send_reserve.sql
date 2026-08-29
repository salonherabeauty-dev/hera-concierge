begin;

create or replace function public.ai_cc_reserve_receptionist_send(
  p_candidate_outbox_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text,
  p_final_message_text text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_existing public.ai_human_delivery_reviews%rowtype;
  v_block_reason text;
  v_candidate_hash text;
  v_final_text text;
  v_final_hash text;
  v_policy_risk text;
  v_approved_outbox_id uuid;
  v_review_id uuid;
  v_edited boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_receptionist_send:' || p_candidate_outbox_id::text,
      0
    )
  );

  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'inactive_staff',
      'candidateId', p_candidate_outbox_id
    );
  end if;

  select * into v_candidate
  from public.ai_outbox
  where id = p_candidate_outbox_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'candidate_not_found',
      'candidateId', p_candidate_outbox_id
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery_source:' ||
        coalesce(
          v_candidate.source_message_id::text,
          p_candidate_outbox_id::text
        ),
      0
    )
  );

  select * into v_existing
  from public.ai_human_delivery_reviews
  where candidate_outbox_id = p_candidate_outbox_id
     or source_message_id = v_candidate.source_message_id
  order by reviewed_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'ok',
        v_existing.decision = 'approved'
        and v_existing.delivery_status in ('sending', 'sent'),
      'state', case
        when v_existing.decision = 'approved'
             and v_existing.delivery_status = 'sent'
          then 'already_sent'
        when v_existing.decision = 'approved'
             and v_existing.delivery_status = 'sending'
          then 'already_sending'
        else 'blocked'
      end,
      'code', case
        when v_existing.decision = 'approved'
             and v_existing.delivery_status in ('sending', 'sent')
          then null
        else 'candidate_already_reviewed'
      end,
      'candidateId', p_candidate_outbox_id,
      'approvedOutboxId', v_existing.approved_outbox_id,
      'reviewId', v_existing.id,
      'conversationId', v_existing.conversation_id,
      'sourceMessageId', v_existing.source_message_id,
      'candidateHash', v_existing.candidate_response_hash,
      'responseHash', coalesce(
        v_existing.final_response_hash,
        v_existing.candidate_response_hash
      ),
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'deliveryStatus', v_existing.delivery_status,
      'providerMessageId', v_existing.provider_message_id,
      'editedByHuman', v_existing.edited_by_human,
      'details', jsonb_build_object('duplicateSuppressed', true)
    );
  end if;

  v_candidate_hash := pg_catalog.encode(
    extensions.digest(
      coalesce(v_candidate.body->>'text', ''),
      'sha256'
    ),
    'hex'
  );
  v_final_text := btrim(coalesce(p_final_message_text, ''));

  if v_candidate.source_message_id
       is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  elsif v_candidate_hash <> p_expected_candidate_hash then
    v_block_reason := 'candidate_hash_changed';
  elsif right(v_candidate.to_wa_id, 4) <> p_expected_phone_ending then
    v_block_reason := 'recipient_display_changed';
  elsif length(v_final_text) < 1 or length(v_final_text) > 4000 then
    v_block_reason := 'final_message_invalid';
  else
    v_block_reason := public.ai_cc_receptionist_candidate_block_reason(
      p_candidate_outbox_id,
      p_actor_user_id
    );
  end if;

  if v_block_reason is not null then
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
      'receptionist_send_blocked',
      'outbox',
      p_candidate_outbox_id::text,
      jsonb_build_object(
        'code', v_block_reason,
        'conversationId', v_candidate.conversation_id,
        'sourceMessageId', v_candidate.source_message_id,
        'candidateHash', v_candidate_hash,
        'reviewerRole', v_role,
        'phoneEnding', right(v_candidate.to_wa_id, 4),
        'channel', 'tanglin_whatsapp_360dialog'
      )
    );

    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', v_block_reason,
      'candidateId', p_candidate_outbox_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'candidateHash', v_candidate_hash,
      'responseHash', null,
      'editedByHuman', false
    );
  end if;

  v_final_hash := pg_catalog.encode(
    extensions.digest(v_final_text, 'sha256'),
    'hex'
  );
  v_edited := v_final_hash <> v_candidate_hash;

  select decision.risk into v_policy_risk
  from public.ai_decisions as decision
  where decision.source_message_id = v_candidate.source_message_id
    and decision.conversation_id = v_candidate.conversation_id
    and decision.stage = 'policy'
  order by decision.created_at desc, decision.id desc
  limit 1;

  update public.ai_outbox
  set status = 'shadowed',
      locked_at = null,
      locked_by = null,
      last_error = case
        when v_edited
          then 'receptionist_edited_and_approved'
        else 'receptionist_approved_unchanged'
      end,
      updated_at = now()
  where id = p_candidate_outbox_id;

  insert into public.ai_outbox (
    conversation_id,
    source_message_id,
    to_wa_id,
    target_type,
    message_type,
    body,
    dedupe_key,
    send_authorization,
    status,
    attempts,
    max_attempts,
    available_at,
    locked_at,
    locked_by
  ) values (
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    v_candidate.to_wa_id,
    'client',
    'text',
    jsonb_build_object('text', v_final_text),
    'human-receptionist:' || p_candidate_outbox_id::text,
    'management',
    'processing',
    1,
    1,
    now(),
    now(),
    'receptionist:' || p_actor_user_id::text
  )
  returning id into v_approved_outbox_id;

  insert into public.ai_human_delivery_reviews (
    candidate_outbox_id,
    approved_outbox_id,
    conversation_id,
    source_message_id,
    reviewer_user_id,
    reviewer_role,
    decision,
    candidate_response_hash,
    final_response_hash,
    edited_by_human,
    review_note,
    delivery_mode,
    delivery_status,
    send_started_at
  ) values (
    p_candidate_outbox_id,
    v_approved_outbox_id,
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    p_actor_user_id,
    v_role,
    'approved',
    v_candidate_hash,
    v_final_hash,
    v_edited,
    case
      when v_edited
        then 'Edited and approved in the simplified Hera Reception workspace.'
      else 'Approved unchanged in the simplified Hera Reception workspace.'
    end,
    'human_approved_preview',
    'sending',
    now()
  )
  returning id into v_review_id;

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
    'receptionist_send_reserved',
    'outbox',
    v_approved_outbox_id::text,
    jsonb_build_object(
      'reviewId', v_review_id,
      'candidateOutboxId', p_candidate_outbox_id,
      'approvedOutboxId', v_approved_outbox_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'candidateHash', v_candidate_hash,
      'finalResponseHash', v_final_hash,
      'editedByHuman', v_edited,
      'reviewerRole', v_role,
      'risk', v_policy_risk,
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'channel', 'tanglin_whatsapp_360dialog',
      'candidateCreatedAt', v_candidate.created_at
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'send_reserved',
    'code', null,
    'candidateId', p_candidate_outbox_id,
    'approvedOutboxId', v_approved_outbox_id,
    'reviewId', v_review_id,
    'conversationId', v_candidate.conversation_id,
    'sourceMessageId', v_candidate.source_message_id,
    'candidateHash', v_candidate_hash,
    'responseHash', v_final_hash,
    'phoneEnding', right(v_candidate.to_wa_id, 4),
    'toWaId', v_candidate.to_wa_id,
    'messageText', v_final_text,
    'deliveryStatus', 'sending',
    'providerMessageId', null,
    'editedByHuman', v_edited,
    'details', jsonb_build_object(
      'reviewerRole', v_role,
      'risk', v_policy_risk,
      'duplicateSuppressed', false,
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );
end;
$$;

create or replace function public.ai_cc_preflight_receptionist_send(
  p_approved_outbox_id uuid,
  p_review_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
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
  v_review public.ai_human_delivery_reviews%rowtype;
  v_outbox public.ai_outbox%rowtype;
  v_candidate public.ai_outbox%rowtype;
  v_policy public.ai_decisions%rowtype;
  v_contact_wa_id text;
  v_latest_inbound_id uuid;
  v_source_effective_at timestamptz;
  v_source_created_at timestamptz;
  v_candidate_hash text;
  v_final_hash text;
  v_block_reason text;
begin
  v_role := public.ai_cc_staff_role(p_actor_user_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_receptionist_send:' || p_approved_outbox_id::text,
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

  if v_review.id is not null then
    select * into v_candidate
    from public.ai_outbox
    where id = v_review.candidate_outbox_id
    for share;
  end if;

  if v_role is null then
    v_block_reason := 'inactive_staff';
  elsif v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist'
  ) then
    v_block_reason := 'role_not_authorized';
  elsif v_review.id is null or v_outbox.id is null then
    v_block_reason := 'send_reservation_not_found';
  elsif v_review.reviewer_user_id is distinct from p_actor_user_id then
    v_block_reason := 'send_reservation_actor_mismatch';
  elsif v_review.decision <> 'approved'
     or v_review.delivery_status <> 'sending'
     or v_review.approved_outbox_id is distinct from v_outbox.id then
    v_block_reason := 'send_reservation_not_active';
  elsif v_candidate.id is null then
    v_block_reason := 'candidate_not_found';
  elsif v_outbox.status <> 'processing'
     or v_outbox.send_authorization <> 'management'
     or v_outbox.target_type <> 'client'
     or v_outbox.provider_message_id is not null then
    v_block_reason := 'approved_outbox_not_sendable';
  elsif v_outbox.source_message_id
          is distinct from p_expected_source_message_id
     or v_review.source_message_id
          is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  else
    v_candidate_hash := pg_catalog.encode(
      extensions.digest(
        coalesce(v_candidate.body->>'text', ''),
        'sha256'
      ),
      'hex'
    );
    v_final_hash := pg_catalog.encode(
      extensions.digest(
        coalesce(v_outbox.body->>'text', ''),
        'sha256'
      ),
      'hex'
    );

    if v_candidate_hash <> p_expected_candidate_hash
       or v_review.candidate_response_hash
            <> p_expected_candidate_hash then
      v_block_reason := 'candidate_hash_changed';
    elsif v_final_hash <> p_expected_final_hash
       or coalesce(
            v_review.final_response_hash,
            v_review.candidate_response_hash
          ) <> p_expected_final_hash then
      v_block_reason := 'final_message_changed';
    elsif right(v_outbox.to_wa_id, 4) <> p_expected_phone_ending then
      v_block_reason := 'recipient_display_changed';
    else
      select contact.wa_id into v_contact_wa_id
      from public.ai_conversations as conversation
      join public.ai_contacts as contact
        on contact.id = conversation.contact_id
      where conversation.id = v_outbox.conversation_id;

      if v_contact_wa_id is null
         or v_contact_wa_id is distinct from v_outbox.to_wa_id then
        v_block_reason := 'recipient_mismatch';
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

        if v_latest_inbound_id
             is distinct from v_outbox.source_message_id then
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
                coalesce(message.provider_timestamp, message.created_at)
                  > v_source_effective_at
                or (
                  coalesce(message.provider_timestamp, message.created_at)
                    = v_source_effective_at
                  and message.created_at > v_source_created_at
                )
              )
          ) then
            v_block_reason := 'human_reply_already_recorded';
          else
            select * into v_policy
            from public.ai_decisions as decision
            where decision.source_message_id = v_candidate.source_message_id
              and decision.conversation_id = v_candidate.conversation_id
              and decision.stage = 'policy'
            order by decision.created_at desc, decision.id desc
            limit 1;

            if not found then
              v_block_reason := 'quality_evidence_missing';
            elsif v_policy.output->>'deliveryEligible' <> 'true'
               or v_policy.output->'finalQuality'->>'passed' <> 'true'
               or v_policy.output->'finalVerification'->>'approved' <> 'true' then
              v_block_reason := 'quality_evidence_failed';
            elsif coalesce(v_policy.output->>'finalReply', '')
                  <> coalesce(v_candidate.body->>'text', '') then
              v_block_reason := 'candidate_text_mismatch';
            end if;
          end if;
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
          last_error =
            'receptionist_preflight_' || v_block_reason,
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
      'receptionist_send_preflight_blocked',
      'outbox',
      p_approved_outbox_id::text,
      jsonb_build_object(
        'code', v_block_reason,
        'reviewId', p_review_id,
        'sourceMessageId', p_expected_source_message_id,
        'candidateHash', p_expected_candidate_hash,
        'finalResponseHash', p_expected_final_hash,
        'phoneEnding', p_expected_phone_ending,
        'channel', 'tanglin_whatsapp_360dialog'
      )
    );

    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', v_block_reason,
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id,
      'candidateHash', p_expected_candidate_hash,
      'responseHash', p_expected_final_hash,
      'editedByHuman', coalesce(v_review.edited_by_human, false)
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
    'candidateHash', v_candidate_hash,
    'responseHash', v_final_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'toWaId', v_outbox.to_wa_id,
    'messageText', v_outbox.body->>'text',
    'deliveryStatus', 'sending',
    'providerMessageId', null,
    'editedByHuman', v_review.edited_by_human,
    'details', jsonb_build_object(
      'doubleChecked', true,
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );
end;
$$;

revoke all on function public.ai_cc_reserve_receptionist_send(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_reserve_receptionist_send(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
) to service_role;

revoke all on function public.ai_cc_preflight_receptionist_send(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_preflight_receptionist_send(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text,
  text
) to service_role;

commit;
