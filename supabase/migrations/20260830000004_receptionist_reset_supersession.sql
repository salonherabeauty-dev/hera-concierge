begin;

alter function public.ai_reset_mark_draft_ready(
  uuid, uuid, integer, text, boolean, text, integer, boolean, jsonb, jsonb, jsonb
) rename to ai_reset_mark_draft_ready_impl;

create function public.ai_reset_mark_draft_ready(
  p_draft_run_id uuid,
  p_turn_id uuid,
  p_turn_version integer,
  p_candidate_text text,
  p_reply_required boolean,
  p_model_id text,
  p_model_calls integer,
  p_rewrite_used boolean,
  p_evidence jsonb,
  p_validation_issues jsonb,
  p_model_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.ai_reset_mark_draft_ready_impl(
    p_draft_run_id,
    p_turn_id,
    p_turn_version,
    p_candidate_text,
    p_reply_required,
    p_model_id,
    p_model_calls,
    p_rewrite_used,
    p_evidence,
    p_validation_issues,
    p_model_metadata
  );

  if v_result->>'state' = 'superseded' then
    return jsonb_set(v_result, '{ok}', 'true'::jsonb, true);
  end if;
  return v_result;
end;
$$;

revoke all on function public.ai_reset_mark_draft_ready(
  uuid, uuid, integer, text, boolean, text, integer, boolean, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_mark_draft_ready(
  uuid, uuid, integer, text, boolean, text, integer, boolean, jsonb, jsonb, jsonb
) to service_role;

alter function public.ai_reset_mark_draft_failed(
  uuid, uuid, integer, text, text, integer, jsonb
) rename to ai_reset_mark_draft_failed_impl;

create function public.ai_reset_mark_draft_failed(
  p_draft_run_id uuid,
  p_turn_id uuid,
  p_turn_version integer,
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
  v_result jsonb;
begin
  v_result := public.ai_reset_mark_draft_failed_impl(
    p_draft_run_id,
    p_turn_id,
    p_turn_version,
    p_failure_code,
    p_failure_message,
    p_model_calls,
    p_model_metadata
  );

  if v_result->>'state' = 'superseded' then
    return jsonb_set(v_result, '{ok}', 'true'::jsonb, true);
  end if;
  return v_result;
end;
$$;

revoke all on function public.ai_reset_mark_draft_failed(
  uuid, uuid, integer, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_mark_draft_failed(
  uuid, uuid, integer, text, text, integer, jsonb
) to service_role;

commit;
