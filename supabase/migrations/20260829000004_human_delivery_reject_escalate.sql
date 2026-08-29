begin;

drop function if exists public.ai_cc_reject_human_delivery_candidate(
  uuid, uuid, uuid, text, text, text
);

create or replace function public.ai_cc_reject_human_delivery_candidate(
  p_candidate_outbox_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
  p_expected_response_hash text,
  p_expected_phone_ending text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_existing public.ai_human_delivery_reviews%rowtype;
  v_latest_inbound_id uuid;
  v_response_hash text;
  v_review_id uuid;
  v_block_reason text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery:' || p_candidate_outbox_id::text,
      0
    )
  );

  v_role := public.ai_cc_staff_role(p_actor_user_id);

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
      'ok', v_existing.decision = 'rejected',
      'state', case
        when v_existing.decision = 'rejected' then 'already_rejected'
        else 'blocked'
      end,
      'code', case
        when v_existing.decision = 'rejected' then null
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

  if v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'privacy_officer'
  ) then
    v_block_reason := case
      when v_role is null then 'inactive_staff'
      else 'role_not_authorized'
    end;
  elsif length(trim(coalesce(p_reason, ''))) < 5 then
    v_block_reason := 'rejection_reason_required';
  elsif v_candidate.target_type <> 'client'
     or v_candidate.source_message_id is null
     or v_candidate.conversation_id is null
     or v_candidate.provider_message_id is not null
     or v_candidate.send_authorization <> 'auto'
     or v_candidate.status not in ('pending', 'shadowed')
     or v_candidate.dedupe_key like 'human-approved:%' then
    v_block_reason := 'candidate_not_reviewable';
  elsif v_candidate.source_message_id is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  elsif v_response_hash <> p_expected_response_hash then
    v_block_reason := 'candidate_hash_changed';
  elsif right(v_candidate.to_wa_id, 4) <> p_expected_phone_ending then
    v_block_reason := 'recipient_display_changed';
  else
    select message.id into v_latest_inbound_id
    from public.ai_messages as message
    where message.conversation_id = v_candidate.conversation_id
      and message.direction = 'inbound'
    order by
      coalesce(message.provider_timestamp, message.created_at) desc,
      message.created_at desc,
      message.id desc
    limit 1;

    if v_latest_inbound_id is distinct from v_candidate.source_message_id then
      v_block_reason := 'candidate_not_latest';
    end if;
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
      'human_delivery_rejection_blocked',
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

  update public.ai_outbox
  set status = 'shadowed',
      locked_at = null,
      locked_by = null,
      last_error = 'human_delivery_candidate_rejected',
      updated_at = now()
  where id = p_candidate_outbox_id;

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
    delivery_status
  ) values (
    p_candidate_outbox_id,
    null,
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    p_actor_user_id,
    v_role,
    'rejected',
    v_response_hash,
    trim(p_reason),
    'human_approved_preview',
    'not_sent'
  )
  returning id into v_review_id;

  perform public.ai_cc_set_conversation_mode(
    v_candidate.conversation_id,
    p_actor_user_id,
    'management',
    trim(p_reason),
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
    'human_delivery_rejected',
    'outbox',
    p_candidate_outbox_id::text,
    jsonb_build_object(
      'reviewId', v_review_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'responseHash', v_response_hash,
      'reviewerRole', v_role,
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'deliveryMode', 'human_approved_preview',
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'rejected_and_taken_over',
    'code', null,
    'candidateId', p_candidate_outbox_id,
    'approvedOutboxId', null,
    'reviewId', v_review_id,
    'conversationId', v_candidate.conversation_id,
    'sourceMessageId', v_candidate.source_message_id,
    'responseHash', v_response_hash,
    'phoneEnding', right(v_candidate.to_wa_id, 4),
    'deliveryStatus', 'not_sent',
    'providerMessageId', null,
    'details', jsonb_build_object(
      'reviewerRole', v_role,
      'conversationMode', 'management',
      'duplicateSuppressed', false
    )
  );
end;
$$;

create or replace function public.ai_cc_escalate_human_delivery_candidate(
  p_candidate_outbox_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
  p_expected_response_hash text,
  p_expected_phone_ending text,
  p_escalation_role text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_existing public.ai_human_delivery_reviews%rowtype;
  v_latest_inbound_id uuid;
  v_response_hash text;
  v_review_id uuid;
  v_task_id uuid;
  v_task_type text;
  v_block_reason text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_human_delivery:' || p_candidate_outbox_id::text,
      0
    )
  );

  v_role := public.ai_cc_staff_role(p_actor_user_id);

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
      'ok', v_existing.decision = 'escalated',
      'state', case
        when v_existing.decision = 'escalated' then 'already_escalated'
        else 'blocked'
      end,
      'code', case
        when v_existing.decision = 'escalated' then null
        else 'candidate_already_reviewed'
      end,
      'candidateId', p_candidate_outbox_id,
      'reviewId', v_existing.id,
      'conversationId', v_existing.conversation_id,
      'sourceMessageId', v_existing.source_message_id,
      'responseHash', v_existing.candidate_response_hash,
      'deliveryStatus', v_existing.delivery_status,
      'details', jsonb_build_object('duplicateSuppressed', true)
    );
  end if;

  v_response_hash := pg_catalog.encode(
    extensions.digest(coalesce(v_candidate.body->>'text', ''), 'sha256'),
    'hex'
  );

  if v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  ) then
    v_block_reason := case
      when v_role is null then 'inactive_staff'
      else 'role_not_authorized'
    end;
  elsif p_escalation_role not in (
    'salon_manager',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  ) then
    v_block_reason := 'invalid_escalation_role';
  elsif length(trim(coalesce(p_reason, ''))) < 5 then
    v_block_reason := 'escalation_reason_required';
  elsif v_candidate.target_type <> 'client'
     or v_candidate.source_message_id is null
     or v_candidate.conversation_id is null
     or v_candidate.provider_message_id is not null
     or v_candidate.send_authorization <> 'auto'
     or v_candidate.status not in ('pending', 'shadowed')
     or v_candidate.dedupe_key like 'human-approved:%' then
    v_block_reason := 'candidate_not_reviewable';
  elsif v_candidate.source_message_id is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  elsif v_response_hash <> p_expected_response_hash then
    v_block_reason := 'candidate_hash_changed';
  elsif right(v_candidate.to_wa_id, 4) <> p_expected_phone_ending then
    v_block_reason := 'recipient_display_changed';
  else
    select message.id into v_latest_inbound_id
    from public.ai_messages as message
    where message.conversation_id = v_candidate.conversation_id
      and message.direction = 'inbound'
    order by
      coalesce(message.provider_timestamp, message.created_at) desc,
      message.created_at desc,
      message.id desc
    limit 1;

    if v_latest_inbound_id is distinct from v_candidate.source_message_id then
      v_block_reason := 'candidate_not_latest';
    end if;
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
      'human_delivery_escalation_blocked',
      'outbox',
      p_candidate_outbox_id::text,
      jsonb_build_object(
        'code', v_block_reason,
        'conversationId', v_candidate.conversation_id,
        'sourceMessageId', v_candidate.source_message_id,
        'responseHash', v_response_hash,
        'reviewerRole', v_role,
        'phoneEnding', right(v_candidate.to_wa_id, 4),
        'escalationRole', p_escalation_role,
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

  v_task_type := case p_escalation_role
    when 'technical_lead' then 'technical_review'
    when 'finance_admin' then 'refund_finance'
    when 'privacy_officer' then 'privacy_legal'
    else 'other'
  end;

  update public.ai_outbox
  set status = 'shadowed',
      locked_at = null,
      locked_by = null,
      last_error = 'human_delivery_candidate_escalated',
      updated_at = now()
  where id = p_candidate_outbox_id;

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
    escalation_role,
    delivery_mode,
    delivery_status
  ) values (
    p_candidate_outbox_id,
    null,
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    p_actor_user_id,
    v_role,
    'escalated',
    v_response_hash,
    trim(p_reason),
    p_escalation_role,
    'human_approved_preview',
    'not_sent'
  )
  returning id into v_review_id;

  insert into public.ai_handoff_tasks (
    conversation_id,
    source_message_id,
    task_type,
    scope,
    priority,
    status,
    assigned_role,
    assigned_outlet,
    owner_user_id,
    summary,
    requested_action,
    collected_facts,
    missing_facts,
    client_visible_status,
    resolution,
    dedupe_key
  ) values (
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    v_task_type,
    'full_takeover',
    'high',
    'new',
    p_escalation_role,
    null,
    null,
    'Human-approved AI response requires ' ||
      replace(p_escalation_role, '_', ' ') || ' review.',
    trim(p_reason),
    '{}'::jsonb,
    '[]'::jsonb,
    null,
    '{}'::jsonb,
    'human-delivery-escalation:' || v_candidate.source_message_id::text
  )
  on conflict (dedupe_key) do update
    set requested_action = excluded.requested_action,
        updated_at = now(),
        version = public.ai_handoff_tasks.version + 1
  returning id into v_task_id;

  perform public.ai_cc_set_conversation_mode(
    v_candidate.conversation_id,
    p_actor_user_id,
    'management',
    'AI response escalated to ' ||
      replace(p_escalation_role, '_', ' ') || ': ' || trim(p_reason),
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
    'human_delivery_escalated',
    'outbox',
    p_candidate_outbox_id::text,
    jsonb_build_object(
      'reviewId', v_review_id,
      'taskId', v_task_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'responseHash', v_response_hash,
      'reviewerRole', v_role,
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'escalationRole', p_escalation_role,
      'taskType', v_task_type,
      'deliveryMode', 'human_approved_preview',
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'escalated_and_taken_over',
    'code', null,
    'candidateId', p_candidate_outbox_id,
    'approvedOutboxId', null,
    'reviewId', v_review_id,
    'conversationId', v_candidate.conversation_id,
    'sourceMessageId', v_candidate.source_message_id,
    'responseHash', v_response_hash,
    'phoneEnding', right(v_candidate.to_wa_id, 4),
    'deliveryStatus', 'not_sent',
    'providerMessageId', null,
    'details', jsonb_build_object(
      'reviewerRole', v_role,
      'escalationRole', p_escalation_role,
      'taskId', v_task_id,
      'taskType', v_task_type,
      'conversationMode', 'management',
      'duplicateSuppressed', false
    )
  );
end;
$$;

commit;
