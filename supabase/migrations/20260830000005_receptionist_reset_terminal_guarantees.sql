begin;

create or replace function public.ai_reset_mark_claim_failed(
  p_draft_run_id uuid,
  p_turn_id uuid,
  p_failure_code text,
  p_failure_message text,
  p_model_calls integer,
  p_model_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.ai_reset_draft_runs%rowtype;
  v_turn public.ai_reset_client_turns%rowtype;
  v_latest_turn_id uuid;
begin
  if length(btrim(coalesce(p_failure_code, ''))) not between 1 and 120
     or length(btrim(coalesce(p_failure_message, ''))) not between 1 and 500
     or p_model_calls not between 0 and 2
  then
    raise exception 'reset claim failure record is invalid' using errcode = '23514';
  end if;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = p_draft_run_id
    and turn_id = p_turn_id
  for update;
  select * into v_turn
  from public.ai_reset_client_turns
  where id = p_turn_id
  for update;

  if v_draft.id is null or v_turn.id is null then
    return jsonb_build_object('ok', false, 'state', 'not_found');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_turn.conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1;

  if v_latest_turn_id is distinct from v_turn.id
     or v_turn.status = 'superseded'
     or v_turn.superseded_by_turn_id is not null
     or v_draft.status = 'superseded'
  then
    if v_draft.status <> 'sent' then
      update public.ai_reset_draft_runs
      set status = 'superseded',
          locked_at = null,
          locked_by = null,
          completed_at = coalesce(completed_at, now()),
          updated_at = now()
      where id = p_draft_run_id;
    end if;
    return jsonb_build_object('ok', true, 'state', 'superseded');
  end if;

  if v_draft.status not in ('pending', 'processing') then
    return jsonb_build_object('ok', false, 'state', 'terminal_state_changed');
  end if;

  update public.ai_reset_draft_runs
  set status = 'failed',
      candidate_text = null,
      candidate_hash = null,
      reply_required = null,
      model_calls = p_model_calls,
      failure_code = btrim(p_failure_code),
      failure_message = btrim(p_failure_message),
      model_metadata = coalesce(p_model_metadata, '{}'::jsonb),
      locked_at = null,
      locked_by = null,
      completed_at = now(),
      updated_at = now()
  where id = p_draft_run_id;

  update public.ai_reset_client_turns
  set status = 'failed', updated_at = now()
  where id = p_turn_id
    and status <> 'superseded';

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'system', 'hera_receptionist_reset', 'reset_draft_claim_failed',
    'reset_draft_run', p_draft_run_id::text,
    jsonb_build_object(
      'turnId', p_turn_id,
      'failureCode', btrim(p_failure_code),
      'modelCalls', p_model_calls,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object('ok', true, 'state', 'failed');
end;
$$;

revoke all on function public.ai_reset_mark_claim_failed(
  uuid, uuid, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_mark_claim_failed(
  uuid, uuid, text, text, integer, jsonb
) to service_role;

-- Preserve the original reservation implementation behind a wrapper that
-- makes repeated button presses idempotent and never recycles an uncertain
-- provider outcome.
alter function public.ai_reset_reserve_human_send(
  uuid, uuid, uuid, text, text, text
) rename to ai_reset_reserve_human_send_impl;

create function public.ai_reset_reserve_human_send(
  p_actor_user_id uuid,
  p_draft_run_id uuid,
  p_expected_turn_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text,
  p_final_text text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.ai_reset_human_sends%rowtype;
begin
  select * into v_existing
  from public.ai_reset_human_sends
  where draft_run_id = p_draft_run_id
  for update;

  if v_existing.id is not null and v_existing.status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'code', null,
      'sendId', v_existing.id,
      'providerMessageId', v_existing.provider_message_id
    );
  end if;

  if v_existing.id is not null and v_existing.status = 'reserved' then
    return jsonb_build_object(
      'ok', false,
      'state', 'already_sending',
      'code', 'send_reconciliation_required',
      'sendId', v_existing.id
    );
  end if;

  return public.ai_reset_reserve_human_send_impl(
    p_actor_user_id,
    p_draft_run_id,
    p_expected_turn_id,
    p_expected_candidate_hash,
    p_expected_phone_ending,
    p_final_text
  );
end;
$$;

revoke all on function public.ai_reset_reserve_human_send(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.ai_reset_reserve_human_send(
  uuid, uuid, uuid, text, text, text
) to service_role;

commit;
