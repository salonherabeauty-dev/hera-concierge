begin;

create or replace function public.ai_cc_request_receptionist_regeneration(
  p_candidate_outbox_id uuid,
  p_actor_user_id uuid,
  p_expected_source_message_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_block_reason text;
  v_candidate_hash text;
  v_regeneration_key text;
  v_job_id uuid;
  v_history_id uuid;
  v_decisions jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_receptionist_regenerate:' ||
        p_candidate_outbox_id::text,
      0
    )
  );

  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'inactive_staff',
      'candidateId', p_candidate_outbox_id,
      'details', '{}'::jsonb
    );
  end if;

  if v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'role_not_authorized',
      'candidateId', p_candidate_outbox_id,
      'details', '{}'::jsonb
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
      'candidateId', p_candidate_outbox_id,
      'details', '{}'::jsonb
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

  v_candidate_hash := pg_catalog.encode(
    extensions.digest(
      coalesce(v_candidate.body->>'text', ''),
      'sha256'
    ),
    'hex'
  );

  if v_candidate.source_message_id
       is distinct from p_expected_source_message_id then
    v_block_reason := 'candidate_source_changed';
  elsif v_candidate_hash <> p_expected_candidate_hash then
    v_block_reason := 'candidate_hash_changed';
  elsif right(v_candidate.to_wa_id, 4) <> p_expected_phone_ending then
    v_block_reason := 'recipient_display_changed';
  else
    v_block_reason := public.ai_cc_receptionist_candidate_block_reason(
      p_candidate_outbox_id,
      p_actor_user_id
    );
  end if;

  if v_block_reason is not null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', v_block_reason,
      'candidateId', p_candidate_outbox_id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'details', '{}'::jsonb
    );
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(decision) order by decision.created_at),
    '[]'::jsonb
  )
  into v_decisions
  from public.ai_decisions as decision
  where decision.source_message_id = v_candidate.source_message_id
    and decision.conversation_id = v_candidate.conversation_id;

  v_regeneration_key := replace(
    gen_random_uuid()::text,
    '-',
    ''
  );

  insert into public.ai_receptionist_regeneration_history (
    candidate_outbox_id,
    conversation_id,
    source_message_id,
    requested_by_user_id,
    previous_dedupe_key,
    previous_candidate_body,
    previous_candidate_hash,
    previous_decisions,
    regeneration_key
  ) values (
    v_candidate.id,
    v_candidate.conversation_id,
    v_candidate.source_message_id,
    p_actor_user_id,
    v_candidate.dedupe_key,
    v_candidate.body,
    v_candidate_hash,
    v_decisions,
    v_regeneration_key
  )
  returning id into v_history_id;

  update public.ai_outbox
  set status = 'dead',
      dedupe_key =
        'regenerated-archive:' ||
        v_candidate.id::text ||
        ':' ||
        v_regeneration_key,
      locked_at = null,
      locked_by = null,
      last_error = 'replaced_by_human_regeneration',
      updated_at = now()
  where id = v_candidate.id;

  delete from public.ai_decisions
  where source_message_id = v_candidate.source_message_id
    and conversation_id = v_candidate.conversation_id;

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
    v_candidate.source_message_id,
    'human-regenerate:' ||
      v_candidate.source_message_id::text ||
      ':' ||
      v_regeneration_key,
    jsonb_build_object(
      'messageId', v_candidate.source_message_id,
      'humanRegeneration', true,
      'regenerationKey', v_regeneration_key,
      'requestedBy', p_actor_user_id,
      'historyId', v_history_id
    ),
    'pending',
    0,
    1,
    now()
  )
  returning id into v_job_id;

  update public.ai_receptionist_regeneration_history
  set job_id = v_job_id
  where id = v_history_id;

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
    'receptionist_regeneration_requested',
    'job',
    v_job_id::text,
    jsonb_build_object(
      'historyId', v_history_id,
      'candidateOutboxId', v_candidate.id,
      'conversationId', v_candidate.conversation_id,
      'sourceMessageId', v_candidate.source_message_id,
      'candidateHash', v_candidate_hash,
      'reviewerRole', v_role,
      'phoneEnding', right(v_candidate.to_wa_id, 4),
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'regeneration_requested',
    'code', null,
    'candidateId', v_candidate.id,
    'conversationId', v_candidate.conversation_id,
    'sourceMessageId', v_candidate.source_message_id,
    'jobId', v_job_id,
    'details', jsonb_build_object(
      'historyId', v_history_id,
      'regenerationKey', v_regeneration_key
    )
  );
end;
$$;

create or replace function public.ai_cc_recover_receptionist_regeneration(
  p_job_id uuid,
  p_actor_user_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_history public.ai_receptionist_regeneration_history%rowtype;
  v_job public.ai_jobs%rowtype;
  v_candidate public.ai_outbox%rowtype;
  v_conflicting_outbox public.ai_outbox%rowtype;
  v_reason text;
begin
  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'inactive_staff',
      'jobId', p_job_id,
      'details', '{}'::jsonb
    );
  end if;
  if v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist'
  ) then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'role_not_authorized',
      'jobId', p_job_id,
      'details', '{}'::jsonb
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hera_receptionist_regenerate_job:' || p_job_id::text,
      0
    )
  );

  select * into v_history
  from public.ai_receptionist_regeneration_history
  where job_id = p_job_id
    and requested_by_user_id = p_actor_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'regeneration_history_not_found',
      'jobId', p_job_id,
      'details', '{}'::jsonb
    );
  end if;

  select * into v_job
  from public.ai_jobs
  where id = p_job_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'regeneration_job_not_found',
      'jobId', p_job_id,
      'details', '{}'::jsonb
    );
  end if;

  if v_job.status not in ('completed', 'dead') then
    return jsonb_build_object(
      'ok', true,
      'state', 'regeneration_pending',
      'code', null,
      'candidateId', v_history.candidate_outbox_id,
      'conversationId', v_history.conversation_id,
      'sourceMessageId', v_history.source_message_id,
      'jobId', p_job_id,
      'details', jsonb_build_object('jobStatus', v_job.status)
    );
  end if;

  select * into v_conflicting_outbox
  from public.ai_outbox as replacement
  where replacement.id <> v_history.candidate_outbox_id
    and replacement.dedupe_key = v_history.previous_dedupe_key
  for update;

  if found then
    if v_conflicting_outbox.status = 'dead'
       and v_conflicting_outbox.provider_message_id is null then
      update public.ai_outbox
      set dedupe_key =
            'failed-regeneration-archive:' ||
            v_conflicting_outbox.id::text ||
            ':' ||
            v_history.regeneration_key,
          updated_at = now()
      where id = v_conflicting_outbox.id;
    else
      return jsonb_build_object(
        'ok', true,
        'state', 'replacement_exists',
        'code', null,
        'candidateId', v_history.candidate_outbox_id,
        'conversationId', v_history.conversation_id,
        'sourceMessageId', v_history.source_message_id,
        'jobId', p_job_id,
        'details', jsonb_build_object(
          'jobStatus', v_job.status,
          'replacementStatus', v_conflicting_outbox.status
        )
      );
    end if;
  end if;

  select * into v_candidate
  from public.ai_outbox
  where id = v_history.candidate_outbox_id
  for update;

  if not found or v_candidate.provider_message_id is not null then
    return jsonb_build_object(
      'ok', false,
      'state', 'blocked',
      'code', 'original_candidate_not_restorable',
      'candidateId', v_history.candidate_outbox_id,
      'conversationId', v_history.conversation_id,
      'sourceMessageId', v_history.source_message_id,
      'jobId', p_job_id,
      'details', '{}'::jsonb
    );
  end if;

  delete from public.ai_decisions
  where source_message_id = v_history.source_message_id
    and conversation_id = v_history.conversation_id;

  insert into public.ai_decisions (
    id,
    conversation_id,
    source_message_id,
    stage,
    model_id,
    prompt_version,
    policy_version,
    risk,
    confidence,
    output,
    usage,
    latency_ms,
    created_at
  )
  select
    (entry.value->>'id')::uuid,
    (entry.value->>'conversation_id')::uuid,
    (entry.value->>'source_message_id')::uuid,
    entry.value->>'stage',
    nullif(entry.value->>'model_id', ''),
    entry.value->>'prompt_version',
    entry.value->>'policy_version',
    entry.value->>'risk',
    (entry.value->>'confidence')::numeric,
    entry.value->'output',
    coalesce(entry.value->'usage', '{}'::jsonb),
    nullif(entry.value->>'latency_ms', '')::integer,
    (entry.value->>'created_at')::timestamptz
  from jsonb_array_elements(v_history.previous_decisions) as entry(value);

  update public.ai_outbox
  set status = 'shadowed',
      dedupe_key = v_history.previous_dedupe_key,
      locked_at = null,
      locked_by = null,
      last_error = 'regeneration_failed_original_restored',
      updated_at = now()
  where id = v_history.candidate_outbox_id;

  v_reason := left(
    coalesce(nullif(btrim(p_reason), ''), 'regeneration did not complete'),
    500
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
    'receptionist_regeneration_original_restored',
    'outbox',
    v_history.candidate_outbox_id::text,
    jsonb_build_object(
      'historyId', v_history.id,
      'jobId', p_job_id,
      'conversationId', v_history.conversation_id,
      'sourceMessageId', v_history.source_message_id,
      'candidateHash', v_history.previous_candidate_hash,
      'reviewerRole', v_role,
      'reason', v_reason,
      'channel', 'tanglin_whatsapp_360dialog'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'original_restored',
    'code', 'regeneration_did_not_complete',
    'candidateId', v_history.candidate_outbox_id,
    'conversationId', v_history.conversation_id,
    'sourceMessageId', v_history.source_message_id,
    'jobId', p_job_id,
    'details', jsonb_build_object(
      'historyId', v_history.id,
      'jobStatus', v_job.status,
      'originalCandidateRestored', true
    )
  );
end;
$$;

revoke all on function public.ai_cc_request_receptionist_regeneration(
  uuid,
  uuid,
  uuid,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_request_receptionist_regeneration(
  uuid,
  uuid,
  uuid,
  text,
  text
) to service_role;

revoke all on function public.ai_cc_recover_receptionist_regeneration(
  uuid,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.ai_cc_recover_receptionist_regeneration(
  uuid,
  uuid,
  text
) to service_role;

commit;
