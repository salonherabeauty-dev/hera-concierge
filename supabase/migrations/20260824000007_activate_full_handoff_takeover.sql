begin;

create or replace function public.ai_activate_automatic_handoff_takeover()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
begin
  if new.scope not in ('full_takeover', 'emergency')
     or new.status not in (
       'new',
       'assigned',
       'accepted',
       'waiting_client',
       'waiting_internal'
     ) then
    return new;
  end if;

  update public.ai_conversations as conversation
  set operating_mode = 'management',
      human_takeover_until = null,
      state = coalesce(conversation.state, '{}'::jsonb) || jsonb_build_object(
        'automaticHandoffTaskId', new.id,
        'automaticHandoffTaskType', new.task_type,
        'automaticHandoffScope', new.scope,
        'automaticHandoffPriority', new.priority,
        'automaticHandoffActivatedAt', now()
      ),
      updated_at = now()
  where conversation.id = new.conversation_id
    and (
      conversation.operating_mode <> 'management'
      or conversation.state ->> 'automaticHandoffTaskId' is distinct from new.id::text
    )
  returning conversation.id into v_conversation_id;

  if v_conversation_id is not null then
    insert into public.ai_handoff_events (
      task_id,
      actor_type,
      actor_user_id,
      event_type,
      from_status,
      to_status,
      details
    ) values (
      new.id,
      'system',
      null,
      'automatic_conversation_takeover_activated',
      new.status,
      new.status,
      jsonb_build_object(
        'conversationId', new.conversation_id,
        'taskType', new.task_type,
        'scope', new.scope,
        'priority', new.priority,
        'reason', 'full_or_emergency_automatic_handoff'
      )
    );

    insert into public.ai_audit_log (
      actor_type,
      actor_id,
      event_type,
      target_type,
      target_id,
      details
    ) values (
      'system',
      'hera_receptionist',
      'automatic_handoff_takeover_activated',
      'conversation',
      new.conversation_id::text,
      jsonb_build_object(
        'taskId', new.id,
        'taskType', new.task_type,
        'scope', new.scope,
        'priority', new.priority
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists ai_handoff_tasks_activate_takeover
  on public.ai_handoff_tasks;

create trigger ai_handoff_tasks_activate_takeover
after insert or update of scope, status, priority, task_type
on public.ai_handoff_tasks
for each row
execute function public.ai_activate_automatic_handoff_takeover();

revoke all on function public.ai_activate_automatic_handoff_takeover()
  from public, anon, authenticated;
grant execute on function public.ai_activate_automatic_handoff_takeover()
  to service_role;

commit;
