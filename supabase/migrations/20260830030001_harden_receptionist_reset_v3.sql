begin;

-- The append function changes an active turn to superseded and then records the
-- new turn id inside the same transaction. PostgreSQL check constraints are not
-- deferrable, so replace only the generated terminal-state check with a named
-- check plus a deferred constraint trigger. The committed state remains strict.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.ai_client_turns_v3'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) like '%status%candidate_id%failure_code%superseded_by_turn_id%'
  loop
    execute format(
      'alter table public.ai_client_turns_v3 drop constraint %I',
      v_constraint.conname
    );
  end loop;
end;
$$;

alter table public.ai_client_turns_v3
  drop constraint if exists ai_client_turns_v3_terminal_shape;
alter table public.ai_client_turns_v3
  add constraint ai_client_turns_v3_terminal_shape check (
    (status = 'ready' and candidate_id is not null and failure_code is null and failure_message is null)
    or (status = 'failed' and candidate_id is null and failure_code is not null and failure_message is not null)
    or (status = 'superseded' and candidate_id is null)
    or (status in ('collecting', 'processing') and candidate_id is null and failure_code is null and failure_message is null)
  );

create or replace function public.ai_validate_client_turn_v3_deferred()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'superseded' and new.superseded_by_turn_id is null then
    raise exception 'reset_v3_superseded_turn_requires_successor'
      using errcode = '23514';
  end if;
  if new.status <> 'superseded' and new.superseded_by_turn_id is not null then
    raise exception 'reset_v3_non_superseded_turn_cannot_name_successor'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists ai_validate_client_turn_v3_deferred
  on public.ai_client_turns_v3;
create constraint trigger ai_validate_client_turn_v3_deferred
after insert or update of status, superseded_by_turn_id
on public.ai_client_turns_v3
deferrable initially deferred
for each row
execute function public.ai_validate_client_turn_v3_deferred();

create or replace view public.ai_latest_client_turns_v3
with (security_invoker = true)
as
select distinct on (turn.conversation_id)
  turn.conversation_id,
  turn.id as turn_id,
  turn.version as turn_version,
  turn.status as turn_status,
  turn.delivery_control,
  turn.first_fragment_at,
  turn.last_fragment_at,
  turn.settle_at,
  turn.failure_code,
  turn.failure_message,
  candidate.id as candidate_id,
  candidate.body as candidate_text,
  candidate.body_hash as candidate_hash,
  candidate.status as candidate_status,
  candidate.model_id as candidate_model_id,
  candidate.model_attempts as candidate_model_attempts,
  job.id as job_id,
  job.status as job_status,
  job.attempts as job_attempts,
  job.model_attempts as job_model_attempts
from public.ai_client_turns_v3 turn
left join public.ai_reply_candidates_v3 candidate
  on candidate.id = turn.candidate_id
left join public.ai_turn_jobs_v3 job
  on job.turn_id = turn.id
order by turn.conversation_id, turn.version desc;

revoke all on public.ai_latest_client_turns_v3 from public, anon, authenticated;
grant select on public.ai_latest_client_turns_v3 to service_role;

create or replace function public.ai_hold_reply_candidate_v3(
  p_actor_user_id uuid,
  p_candidate_id uuid,
  p_expected_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.ai_reply_candidates_v3%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_candidate_id::text, 733));
  select * into strict v_candidate
  from public.ai_reply_candidates_v3
  where id = p_candidate_id
  for update;

  if v_candidate.body_hash is distinct from p_expected_hash then
    return jsonb_build_object('ok', false, 'code', 'candidate_hash_mismatch');
  end if;
  if v_candidate.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;

  update public.ai_reply_candidates_v3
  set status = 'rejected', updated_at = now()
  where id = p_candidate_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human',
    p_actor_user_id::text,
    'reset_v3_candidate_held_for_manual_reply',
    'reply_candidate_v3',
    p_candidate_id::text,
    jsonb_build_object(
      'turnId', v_candidate.turn_id,
      'conversationId', v_candidate.conversation_id,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object('ok', true, 'state', 'held');
end;
$$;

revoke all on function public.ai_validate_client_turn_v3_deferred()
  from public, anon, authenticated;
revoke all on function public.ai_hold_reply_candidate_v3(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ai_hold_reply_candidate_v3(uuid, uuid, text)
  to service_role;

commit;
