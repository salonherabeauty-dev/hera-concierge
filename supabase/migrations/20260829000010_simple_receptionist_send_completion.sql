begin;

create or replace function public.ai_cc_complete_receptionist_send(
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
  v_final_hash text;
begin
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

  if v_review.id is null
     or v_outbox.id is null
     or v_review.approved_outbox_id is distinct from v_outbox.id
     or v_review.reviewer_user_id is distinct from p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_reservation_not_found',
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id,
      'editedByHuman', false
    );
  end if;

  if v_review.delivery_status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'code', null,
      'candidateId', v_review.candidate_outbox_id,
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'candidateHash', v_review.candidate_response_hash,
      'responseHash', coalesce(
        v_review.final_response_hash,
        v_review.candidate_response_hash
      ),
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'providerMessageId', v_review.provider_message_id,
      'deliveryStatus', 'sent',
      'editedByHuman', v_review.edited_by_human,
      'details', jsonb_build_object(
        'duplicateSuppressed', true,
        'channel', 'tanglin_whatsapp_360dialog'
      )
    );
  end if;

  if v_review.delivery_status <> 'sending'
     or length(btrim(coalesce(p_provider_message_id, ''))) < 8 then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_completion_invalid',
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id,
      'editedByHuman', v_review.edited_by_human
    );
  end if;

  perform public.ai_mark_outbox_sent(
    v_outbox.id,
    btrim(p_provider_message_id)
  );

  update public.ai_messages
  set ai_generated = false,
      updated_at = now()
  where provider_message_id = btrim(p_provider_message_id);

  v_final_hash := coalesce(
    v_review.final_response_hash,
    v_review.candidate_response_hash
  );

  update public.ai_human_delivery_reviews
  set delivery_status = 'sent',
      provider_message_id = btrim(p_provider_message_id),
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
    'receptionist_message_sent',
    'outbox',
    v_outbox.id::text,
    jsonb_build_object(
      'reviewId', v_review.id,
      'candidateOutboxId', v_review.candidate_outbox_id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'candidateHash', v_review.candidate_response_hash,
      'finalResponseHash', v_final_hash,
      'editedByHuman', v_review.edited_by_human,
      'reviewerRole', v_review.reviewer_role,
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'providerMessageId', btrim(p_provider_message_id),
      'channel', 'tanglin_whatsapp_360dialog'
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
    'candidateHash', v_review.candidate_response_hash,
    'responseHash', v_final_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'deliveryStatus', 'sent',
    'providerMessageId', btrim(p_provider_message_id),
    'editedByHuman', v_review.edited_by_human,
    'details', jsonb_build_object(
      'reviewerRole', v_review.reviewer_role,
      'namedHumanApproval', true,
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );
end;
$$;

create or replace function public.ai_cc_fail_receptionist_send(
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
  v_final_hash text;
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

  if v_review.id is null
     or v_outbox.id is null
     or v_review.approved_outbox_id is distinct from v_outbox.id
     or v_review.reviewer_user_id is distinct from p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'send_reservation_not_found',
      'approvedOutboxId', p_approved_outbox_id,
      'reviewId', p_review_id,
      'editedByHuman', false
    );
  end if;

  if v_review.delivery_status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'code', null,
      'candidateId', v_review.candidate_outbox_id,
      'approvedOutboxId', v_outbox.id,
      'reviewId', v_review.id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'candidateHash', v_review.candidate_response_hash,
      'responseHash', coalesce(
        v_review.final_response_hash,
        v_review.candidate_response_hash
      ),
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'providerMessageId', v_review.provider_message_id,
      'deliveryStatus', 'sent',
      'editedByHuman', v_review.edited_by_human,
      'details', jsonb_build_object('duplicateSuppressed', true)
    );
  end if;

  update public.ai_outbox
  set status = 'dead',
      locked_at = null,
      locked_by = null,
      last_error = 'receptionist_send_' || v_code,
      updated_at = now()
  where id = v_outbox.id
    and provider_message_id is null;

  update public.ai_human_delivery_reviews
  set delivery_status = 'failed',
      failure_code = v_code,
      updated_at = now()
  where id = v_review.id
    and delivery_status <> 'sent';

  update public.ai_conversations
  set operating_mode = 'management',
      human_takeover_until = null,
      state = state || jsonb_build_object(
        'commandCentreTakeover', true,
        'commandCentreTakeoverReason',
          'Tanglin WhatsApp delivery failed; reception must respond manually.',
        'commandCentreTakeoverBy', p_actor_user_id,
        'commandCentreTakeoverAt', now()
      ),
      updated_at = now()
  where id = v_outbox.conversation_id;

  v_final_hash := coalesce(
    v_review.final_response_hash,
    v_review.candidate_response_hash
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
    'receptionist_message_send_failed',
    'outbox',
    v_outbox.id::text,
    jsonb_build_object(
      'reviewId', v_review.id,
      'candidateOutboxId', v_review.candidate_outbox_id,
      'conversationId', v_outbox.conversation_id,
      'sourceMessageId', v_outbox.source_message_id,
      'candidateHash', v_review.candidate_response_hash,
      'finalResponseHash', v_final_hash,
      'editedByHuman', v_review.edited_by_human,
      'reviewerRole', v_review.reviewer_role,
      'phoneEnding', right(v_outbox.to_wa_id, 4),
      'failureCode', v_code,
      'channel', 'tanglin_whatsapp_360dialog'
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
    'candidateHash', v_review.candidate_response_hash,
    'responseHash', v_final_hash,
    'phoneEnding', right(v_outbox.to_wa_id, 4),
    'deliveryStatus', 'failed',
    'providerMessageId', null,
    'editedByHuman', v_review.edited_by_human,
    'details', jsonb_build_object(
      'reviewerRole', v_review.reviewer_role,
      'conversationMode', 'management',
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );
end;
$$;

revoke all on function public.ai_cc_complete_receptionist_send(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_complete_receptionist_send(
  uuid,
  uuid,
  uuid,
  text
) to service_role;

revoke all on function public.ai_cc_fail_receptionist_send(
  uuid,
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_fail_receptionist_send(
  uuid,
  uuid,
  uuid,
  text
) to service_role;

commit;
