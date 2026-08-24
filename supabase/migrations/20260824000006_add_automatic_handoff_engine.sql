begin;

do $$
begin
  if to_regclass('public.ai_handoff_tasks') is null
     or to_regclass('public.ai_handoff_events') is null
     or to_regclass('public.ai_handoff_sla_policies') is null then
    raise exception 'Command Centre foundation migration must be installed first';
  end if;
end;
$$;

create index if not exists ai_handoff_tasks_open_conversation_type_idx
  on public.ai_handoff_tasks(conversation_id, task_type, created_at desc)
  where status in ('new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal');

insert into public.ai_handoff_sla_policies (
  task_type,
  priority,
  target_minutes,
  escalation_role
) values
  ('booking_action', 'high', 5, 'salon_manager'),
  ('appointment_change', 'urgent', 5, 'salon_manager'),
  ('complaint_review', 'urgent', 5, 'managing_director'),
  ('refund_finance', 'urgent', 10, 'managing_director'),
  ('medical_safety', 'high', 5, 'technical_lead'),
  ('medical_safety', 'urgent', 2, 'salon_manager'),
  ('client_requested_human', 'urgent', 2, 'salon_manager'),
  ('technical_review', 'urgent', 5, 'technical_lead'),
  ('other', 'urgent', 5, 'salon_manager')
on conflict (task_type, priority) do update
set target_minutes = excluded.target_minutes,
    escalation_role = excluded.escalation_role,
    active = true,
    updated_at = now();

create or replace function public.ai_upsert_automatic_handoff(
  p_conversation_id uuid,
  p_source_message_id uuid,
  p_task_type text,
  p_scope text,
  p_priority text,
  p_assigned_role text,
  p_assigned_outlet text,
  p_summary text,
  p_requested_action text,
  p_collected_facts jsonb,
  p_missing_facts jsonb,
  p_client_visible_status text,
  p_due_at timestamptz,
  p_dedupe_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ai_handoff_tasks%rowtype;
  v_inserted boolean := false;
  v_updated boolean := false;
  v_target_minutes integer := 30;
  v_due_at timestamptz;
  v_previous_status text;
begin
  if p_conversation_id is null or p_source_message_id is null then
    raise exception 'conversation and source message are required';
  end if;
  if jsonb_typeof(coalesce(p_collected_facts, '{}'::jsonb)) <> 'object' then
    raise exception 'collected facts must be a JSON object';
  end if;
  if jsonb_typeof(coalesce(p_missing_facts, '[]'::jsonb)) <> 'array' then
    raise exception 'missing facts must be a JSON array';
  end if;

  -- Serialise every open-task decision for one conversation and task class.
  -- This closes the race where two concurrent messages could otherwise both
  -- observe no open task and create competing handoffs.
  perform pg_advisory_xact_lock(
    hashtextextended(p_conversation_id::text || ':' || p_task_type, 0)
  );

  select policy.target_minutes
  into v_target_minutes
  from public.ai_handoff_sla_policies as policy
  where policy.task_type = p_task_type
    and policy.priority = p_priority
    and policy.active
  limit 1;

  v_due_at := coalesce(
    p_due_at,
    now() + make_interval(mins => coalesce(v_target_minutes, 30))
  );

  select task.*
  into v_task
  from public.ai_handoff_tasks as task
  where task.conversation_id = p_conversation_id
    and task.task_type = p_task_type
    and task.status in (
      'new',
      'assigned',
      'accepted',
      'waiting_client',
      'waiting_internal'
    )
  order by task.created_at desc
  limit 1
  for update;

  if found then
    v_previous_status := v_task.status;

    update public.ai_handoff_tasks
    set source_message_id = p_source_message_id,
        scope = case
          when scope = 'emergency' or p_scope = 'emergency' then 'emergency'
          when scope = 'full_takeover' or p_scope = 'full_takeover' then 'full_takeover'
          else 'task_only'
        end,
        priority = case
          when priority = 'emergency' or p_priority = 'emergency' then 'emergency'
          when priority = 'urgent' or p_priority = 'urgent' then 'urgent'
          when priority = 'high' or p_priority = 'high' then 'high'
          else 'normal'
        end,
        status = case
          when status = 'waiting_client'
            and jsonb_array_length(coalesce(p_missing_facts, '[]'::jsonb)) = 0
            then case when owner_user_id is null then 'assigned' else 'accepted' end
          else status
        end,
        assigned_role = coalesce(p_assigned_role, assigned_role),
        assigned_outlet = coalesce(
          nullif(trim(coalesce(p_assigned_outlet, '')), ''),
          assigned_outlet
        ),
        summary = trim(p_summary),
        requested_action = trim(p_requested_action),
        collected_facts = coalesce(collected_facts, '{}'::jsonb)
          || jsonb_strip_nulls(coalesce(p_collected_facts, '{}'::jsonb)),
        missing_facts = coalesce(p_missing_facts, '[]'::jsonb),
        client_visible_status = coalesce(
          nullif(trim(coalesce(p_client_visible_status, '')), ''),
          client_visible_status
        ),
        due_at = case
          when due_at is null then v_due_at
          when v_due_at is null then due_at
          else least(due_at, v_due_at)
        end,
        version = version + 1
    where id = v_task.id
    returning * into v_task;

    v_updated := true;

    insert into public.ai_handoff_events (
      task_id,
      actor_type,
      actor_user_id,
      event_type,
      from_status,
      to_status,
      details
    ) values (
      v_task.id,
      'ai',
      null,
      'automatic_handoff_refreshed',
      v_previous_status,
      v_task.status,
      jsonb_build_object(
        'sourceMessageId', p_source_message_id,
        'priority', v_task.priority,
        'scope', v_task.scope,
        'assignedRole', v_task.assigned_role,
        'assignedOutlet', v_task.assigned_outlet,
        'version', v_task.version
      )
    );
  else
    insert into public.ai_handoff_tasks (
      conversation_id,
      source_message_id,
      task_type,
      scope,
      priority,
      status,
      assigned_role,
      assigned_outlet,
      summary,
      requested_action,
      collected_facts,
      missing_facts,
      client_visible_status,
      due_at,
      dedupe_key
    ) values (
      p_conversation_id,
      p_source_message_id,
      p_task_type,
      p_scope,
      p_priority,
      case when p_assigned_role is null then 'new' else 'assigned' end,
      p_assigned_role,
      nullif(trim(coalesce(p_assigned_outlet, '')), ''),
      trim(p_summary),
      trim(p_requested_action),
      jsonb_strip_nulls(coalesce(p_collected_facts, '{}'::jsonb)),
      coalesce(p_missing_facts, '[]'::jsonb),
      nullif(trim(coalesce(p_client_visible_status, '')), ''),
      v_due_at,
      trim(p_dedupe_key)
    )
    on conflict (dedupe_key) do nothing
    returning * into v_task;

    if found then
      v_inserted := true;

      insert into public.ai_handoff_events (
        task_id,
        actor_type,
        actor_user_id,
        event_type,
        from_status,
        to_status,
        details
      ) values (
        v_task.id,
        'ai',
        null,
        'automatic_handoff_created',
        null,
        v_task.status,
        jsonb_build_object(
          'sourceMessageId', p_source_message_id,
          'taskType', v_task.task_type,
          'priority', v_task.priority,
          'scope', v_task.scope,
          'assignedRole', v_task.assigned_role,
          'assignedOutlet', v_task.assigned_outlet,
          'version', v_task.version
        )
      );
    else
      select task.*
      into v_task
      from public.ai_handoff_tasks as task
      where task.dedupe_key = trim(p_dedupe_key);
    end if;
  end if;

  if v_task.id is null then
    raise exception 'automatic handoff could not be persisted';
  end if;

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
    case
      when v_inserted then 'automatic_handoff_created'
      when v_updated then 'automatic_handoff_refreshed'
      else 'automatic_handoff_deduplicated'
    end,
    'handoff_task',
    v_task.id::text,
    jsonb_build_object(
      'conversationId', v_task.conversation_id,
      'sourceMessageId', p_source_message_id,
      'taskType', v_task.task_type,
      'scope', v_task.scope,
      'priority', v_task.priority,
      'status', v_task.status,
      'version', v_task.version
    )
  );

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'taskId', v_task.id,
    'status', v_task.status,
    'version', v_task.version
  );
end;
$$;

revoke all on function public.ai_upsert_automatic_handoff(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  text,
  timestamptz,
  text
) from public, anon, authenticated;

grant execute on function public.ai_upsert_automatic_handoff(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  text,
  timestamptz,
  text
) to service_role;

commit;
