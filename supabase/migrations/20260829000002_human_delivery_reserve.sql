begin;

create or replace function public.ai_cc_reserve_human_delivery_send(
  p_candidate_outbox_id uuid,
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
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_existing public.ai_human_delivery_reviews%rowtype;
  v_block_reason text;
  v_response_hash text;
  v_policy_risk text;
  v_approved_outbox_id uuid;
  v_review_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery:' || p_candidate_outbox_id::text,
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
        coalesce(v_candidate.source_message_id::text, p_candidate_outbox_id::text),
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
      'ok', v_existing.decision = 'approved'
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
      'responseHash', v_existing.candidate_response_hash,
      'deliveryStatus', v_existing.delivery_status,
      'providerMessageId', v_existing.provider_message_id,
      'details', jsonb_build_object('duplicateSuppressed', true)
    );
  end if;

  v_response_hash := pg_catalog.encode(
    extensions.digest(coalesce(v_candidate.body->>'text', ''), 'sha256'),
    'hex'
  );

  if v_candidate.source_message_id is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  elsif v_response_hash <> p_expected_response_hash then
    v_block_reason := 'candidate_hash_changed';
  elsif right(v_candidate.to_wa_id, 4) <> p_expected_phone_ending then
    v_block_reason := 'recipient_display_changed';
  else
    v_block_reason := public.ai_cc_human_delivery_block_reason(
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
      'human_delivery_approval_blocked',
      'outbox',
      p_candidate_outbox_id::text,
      jsonb_build_object(
        'code', v_block_reason,
        'conversationId', v_candidate.conversation_id,
        'sourceMessageId', v_candidate.source_message_id,
        'responseHash', v_response_hash,
        'reviewerRole', v_role,
        'phoneEnding', right(v_candidate.to_wa_id, 4),
        'deliveryMode', 'human_approved_preview'
      )
    );

    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', v_block_reason,
      'candidateId', p_candidate_outbox_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'responseHash', v_response_hash
    );
  end if;

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
      last_error = 'human_delivery_candidate_approved',
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
    v_candidate.body,
    'human-approved:' || p_candidate_outbox_id::text,
    'management',
    'processing',
    1,
    1,
    now(),
    now(),
    'human-approved:' || p_actor_user_id::text
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
    v_response_hash,
    'Approved unchanged in the Hera Command Centre.',
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
    'human_delivery_send_reserved',
    'outbox',
    v_approved_outbox_id::text,
    jsonb_build_object(
      'reviewId', v_review_id,
      'candidateOutboxId', p_candidate_outbox_id,
      'approvedOutboxId', v_approved_outbox_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'responseHash', v_response_hash,
      'reviewerRole', v_role,
      'risk', v_policy_risk,
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'deliveryMode', 'human_approved_preview',
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
    'responseHash', v_response_hash,
    'phoneEnding', right(v_candidate.to_wa_id, 4),
    'toWaId', v_candidate.to_wa_id,
    'messageText', v_candidate.body->>'text',
    'deliveryStatus', 'sending',
    'providerMessageId', null,
    'details', jsonb_build_object(
      'reviewerRole', v_role,
      'risk', v_policy_risk,
      'duplicateSuppressed', false
    )
  );
end;
$$;

commit;
