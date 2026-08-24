begin;

create table public.ai_staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (length(trim(email)) between 3 and 320),
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  role text not null check (role in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer',
    'auditor'
  )),
  outlet_scope text[] not null default '{}'::text[],
  status text not null default 'active' check (status in ('active', 'suspended', 'disabled')),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ai_staff_profiles_email_lower_unique
  on public.ai_staff_profiles(lower(email));
create index ai_staff_profiles_role_status_idx
  on public.ai_staff_profiles(role, status);

create table public.ai_handoff_tasks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  source_message_id uuid references public.ai_messages(id) on delete set null,
  incident_id uuid references public.ai_incidents(id) on delete set null,
  task_type text not null check (task_type in (
    'booking_action',
    'appointment_change',
    'arrival_issue',
    'group_booking',
    'complaint_review',
    'refund_finance',
    'medical_safety',
    'technical_review',
    'privacy_legal',
    'accessibility_arrangement',
    'consent_media',
    'lost_property',
    'client_requested_human',
    'security_review',
    'system_failure',
    'other'
  )),
  scope text not null check (scope in ('task_only', 'full_takeover', 'emergency')),
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent', 'emergency')),
  status text not null default 'new' check (status in (
    'new',
    'assigned',
    'accepted',
    'waiting_client',
    'waiting_internal',
    'resolved',
    'cancelled'
  )),
  assigned_role text check (assigned_role is null or assigned_role in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  )),
  assigned_outlet text check (assigned_outlet is null or length(trim(assigned_outlet)) between 1 and 80),
  owner_user_id uuid references public.ai_staff_profiles(user_id) on delete set null,
  summary text not null check (length(trim(summary)) between 1 and 1000),
  requested_action text not null check (length(trim(requested_action)) between 1 and 1200),
  collected_facts jsonb not null default '{}'::jsonb check (jsonb_typeof(collected_facts) = 'object'),
  missing_facts jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_facts) = 'array'),
  client_visible_status text check (client_visible_status is null or length(client_visible_status) <= 500),
  due_at timestamptz,
  accepted_at timestamptz,
  resolved_at timestamptz,
  resolution jsonb not null default '{}'::jsonb check (jsonb_typeof(resolution) = 'object'),
  dedupe_key text not null unique check (length(trim(dedupe_key)) between 1 and 220),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_handoff_tasks_status_due_idx
  on public.ai_handoff_tasks(status, due_at, created_at);
create index ai_handoff_tasks_conversation_idx
  on public.ai_handoff_tasks(conversation_id, created_at desc);
create index ai_handoff_tasks_owner_idx
  on public.ai_handoff_tasks(owner_user_id, status, due_at);
create index ai_handoff_tasks_priority_idx
  on public.ai_handoff_tasks(priority, status, created_at desc);

create table public.ai_handoff_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ai_handoff_tasks(id) on delete cascade,
  actor_type text not null check (actor_type in ('system', 'ai', 'staff')),
  actor_user_id uuid references public.ai_staff_profiles(user_id) on delete set null,
  event_type text not null check (length(trim(event_type)) between 1 and 120),
  from_status text,
  to_status text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index ai_handoff_events_task_time_idx
  on public.ai_handoff_events(task_id, created_at desc);
create index ai_handoff_events_actor_time_idx
  on public.ai_handoff_events(actor_user_id, created_at desc);

create table public.ai_command_centre_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  task_id uuid references public.ai_handoff_tasks(id) on delete cascade,
  author_user_id uuid not null references public.ai_staff_profiles(user_id) on delete restrict,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_command_centre_notes_conversation_time_idx
  on public.ai_command_centre_notes(conversation_id, created_at desc);
create index ai_command_centre_notes_task_time_idx
  on public.ai_command_centre_notes(task_id, created_at desc)
  where task_id is not null;

create table public.ai_handoff_sla_policies (
  task_type text not null,
  priority text not null,
  target_minutes integer not null check (target_minutes between 1 and 10080),
  escalation_role text not null check (escalation_role in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  )),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (task_type, priority),
  check (task_type in (
    'booking_action',
    'appointment_change',
    'arrival_issue',
    'group_booking',
    'complaint_review',
    'refund_finance',
    'medical_safety',
    'technical_review',
    'privacy_legal',
    'accessibility_arrangement',
    'consent_media',
    'lost_property',
    'client_requested_human',
    'security_review',
    'system_failure',
    'other'
  )),
  check (priority in ('normal', 'high', 'urgent', 'emergency'))
);

insert into public.ai_handoff_sla_policies (
  task_type,
  priority,
  target_minutes,
  escalation_role
) values
  ('booking_action', 'normal', 15, 'receptionist'),
  ('appointment_change', 'high', 10, 'receptionist'),
  ('arrival_issue', 'urgent', 2, 'salon_manager'),
  ('group_booking', 'normal', 30, 'salon_manager'),
  ('complaint_review', 'high', 10, 'salon_manager'),
  ('refund_finance', 'high', 30, 'managing_director'),
  ('medical_safety', 'emergency', 1, 'salon_manager'),
  ('technical_review', 'high', 15, 'technical_lead'),
  ('privacy_legal', 'urgent', 10, 'privacy_officer'),
  ('accessibility_arrangement', 'normal', 30, 'receptionist'),
  ('consent_media', 'high', 15, 'privacy_officer'),
  ('lost_property', 'normal', 30, 'receptionist'),
  ('client_requested_human', 'high', 5, 'receptionist'),
  ('security_review', 'urgent', 5, 'privacy_officer'),
  ('system_failure', 'urgent', 5, 'salon_manager'),
  ('other', 'normal', 30, 'receptionist')
on conflict (task_type, priority) do update
set target_minutes = excluded.target_minutes,
    escalation_role = excluded.escalation_role,
    active = true,
    updated_at = now();

create or replace function public.ai_command_centre_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger ai_staff_profiles_touch_updated_at
before update on public.ai_staff_profiles
for each row execute function public.ai_command_centre_touch_updated_at();

create trigger ai_handoff_tasks_touch_updated_at
before update on public.ai_handoff_tasks
for each row execute function public.ai_command_centre_touch_updated_at();

create trigger ai_command_centre_notes_touch_updated_at
before update on public.ai_command_centre_notes
for each row execute function public.ai_command_centre_touch_updated_at();

create trigger ai_handoff_sla_policies_touch_updated_at
before update on public.ai_handoff_sla_policies
for each row execute function public.ai_command_centre_touch_updated_at();

create or replace function public.ai_cc_staff_role(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select profile.role
  from public.ai_staff_profiles as profile
  where profile.user_id = p_user_id
    and profile.status = 'active';
$$;

create or replace function public.ai_cc_has_capability(
  p_user_id uuid,
  p_capability text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case p_capability
      when 'create_task' then profile.role in (
        'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
      )
      when 'assign_task' then profile.role in (
        'owner', 'managing_director', 'salon_manager'
      )
      when 'control_conversation' then profile.role in (
        'owner', 'managing_director', 'salon_manager', 'receptionist',
        'technical_lead', 'privacy_officer'
      )
      when 'add_note' then profile.role <> 'auditor'
      when 'manage_staff' then profile.role in ('owner', 'managing_director')
      when 'manage_system' then profile.role in ('owner', 'managing_director')
      else false
    end
    from public.ai_staff_profiles as profile
    where profile.user_id = p_user_id
      and profile.status = 'active'
  ), false);
$$;

create or replace function public.ai_cc_can_handle_task(
  p_user_id uuid,
  p_task_type text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case profile.role
      when 'owner' then true
      when 'managing_director' then true
      when 'salon_manager' then p_task_type not in ('privacy_legal', 'security_review')
      when 'receptionist' then p_task_type in (
        'booking_action',
        'appointment_change',
        'arrival_issue',
        'group_booking',
        'accessibility_arrangement',
        'lost_property',
        'client_requested_human',
        'other'
      )
      when 'technical_lead' then p_task_type in (
        'technical_review',
        'medical_safety',
        'complaint_review'
      )
      when 'finance_admin' then p_task_type = 'refund_finance'
      when 'privacy_officer' then p_task_type in (
        'privacy_legal',
        'consent_media',
        'security_review'
      )
      else false
    end
    from public.ai_staff_profiles as profile
    where profile.user_id = p_user_id
      and profile.status = 'active'
  ), false);
$$;

create or replace function public.ai_cc_create_task(
  p_conversation_id uuid,
  p_source_message_id uuid,
  p_incident_id uuid,
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
  p_dedupe_key text,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ai_handoff_tasks%rowtype;
  v_inserted boolean := false;
  v_actor_type text := case when p_actor_user_id is null then 'system' else 'staff' end;
begin
  if p_actor_user_id is not null
     and not public.ai_cc_has_capability(p_actor_user_id, 'create_task') then
    raise exception 'staff member cannot create handoff tasks';
  end if;

  insert into public.ai_handoff_tasks (
    conversation_id,
    source_message_id,
    incident_id,
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
    p_incident_id,
    p_task_type,
    p_scope,
    p_priority,
    case when p_assigned_role is null then 'new' else 'assigned' end,
    p_assigned_role,
    nullif(trim(coalesce(p_assigned_outlet, '')), ''),
    trim(p_summary),
    trim(p_requested_action),
    coalesce(p_collected_facts, '{}'::jsonb),
    coalesce(p_missing_facts, '[]'::jsonb),
    nullif(trim(coalesce(p_client_visible_status, '')), ''),
    p_due_at,
    trim(p_dedupe_key)
  )
  on conflict (dedupe_key) do nothing
  returning * into v_task;

  if found then
    v_inserted := true;
  else
    select * into v_task
    from public.ai_handoff_tasks
    where dedupe_key = trim(p_dedupe_key);
  end if;

  if v_inserted then
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
      v_actor_type,
      p_actor_user_id,
      'task_created',
      null,
      v_task.status,
      jsonb_build_object(
        'taskType', v_task.task_type,
        'scope', v_task.scope,
        'priority', v_task.priority,
        'assignedRole', v_task.assigned_role,
        'assignedOutlet', v_task.assigned_outlet
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
      case when p_actor_user_id is null then 'system' else 'management' end,
      p_actor_user_id::text,
      'command_centre_task_created',
      'handoff_task',
      v_task.id::text,
      jsonb_build_object(
        'conversationId', v_task.conversation_id,
        'taskType', v_task.task_type,
        'scope', v_task.scope,
        'priority', v_task.priority
      )
    );
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'taskId', v_task.id,
    'status', v_task.status,
    'version', v_task.version
  );
end;
$$;

create or replace function public.ai_cc_accept_task(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ai_handoff_tasks%rowtype;
  v_previous_status text;
begin
  select * into v_task
  from public.ai_handoff_tasks
  where id = p_task_id
  for update;

  if not found then raise exception 'handoff task not found'; end if;
  if v_task.version <> p_expected_version then raise exception 'handoff task version conflict'; end if;
  if v_task.status not in ('new', 'assigned') then raise exception 'handoff task cannot be accepted'; end if;
  if not public.ai_cc_can_handle_task(p_actor_user_id, v_task.task_type) then
    raise exception 'staff member is not permitted to accept this task';
  end if;
  if v_task.owner_user_id is not null and v_task.owner_user_id <> p_actor_user_id then
    raise exception 'handoff task is already owned';
  end if;

  v_previous_status := v_task.status;

  update public.ai_handoff_tasks
  set owner_user_id = p_actor_user_id,
      status = 'accepted',
      accepted_at = coalesce(accepted_at, now()),
      version = version + 1
  where id = p_task_id
  returning * into v_task;

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
    'staff',
    p_actor_user_id,
    'task_accepted',
    v_previous_status,
    v_task.status,
    jsonb_build_object('version', v_task.version)
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
    'command_centre_task_accepted',
    'handoff_task',
    v_task.id::text,
    jsonb_build_object('conversationId', v_task.conversation_id)
  );

  return jsonb_build_object(
    'taskId', v_task.id,
    'status', v_task.status,
    'version', v_task.version,
    'ownerUserId', v_task.owner_user_id
  );
end;
$$;

create or replace function public.ai_cc_assign_task(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_owner_user_id uuid,
  p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ai_handoff_tasks%rowtype;
  v_actor_role text;
  v_previous_status text;
begin
  v_actor_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_actor_role not in ('owner', 'managing_director', 'salon_manager') then
    raise exception 'staff member cannot assign tasks';
  end if;

  select * into v_task
  from public.ai_handoff_tasks
  where id = p_task_id
  for update;

  if not found then raise exception 'handoff task not found'; end if;
  if v_task.version <> p_expected_version then raise exception 'handoff task version conflict'; end if;
  if v_task.status in ('resolved', 'cancelled') then raise exception 'terminal handoff task cannot be assigned'; end if;
  if not public.ai_cc_can_handle_task(p_owner_user_id, v_task.task_type) then
    raise exception 'assignee is not permitted to handle this task';
  end if;

  v_previous_status := v_task.status;

  update public.ai_handoff_tasks
  set owner_user_id = p_owner_user_id,
      status = case when status = 'new' then 'assigned' else status end,
      version = version + 1
  where id = p_task_id
  returning * into v_task;

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
    'staff',
    p_actor_user_id,
    'task_assigned',
    v_previous_status,
    v_task.status,
    jsonb_build_object(
      'ownerUserId', p_owner_user_id,
      'version', v_task.version
    )
  );

  return jsonb_build_object(
    'taskId', v_task.id,
    'status', v_task.status,
    'version', v_task.version,
    'ownerUserId', v_task.owner_user_id
  );
end;
$$;

create or replace function public.ai_cc_transition_task(
  p_task_id uuid,
  p_actor_user_id uuid,
  p_expected_version integer,
  p_to_status text,
  p_note text,
  p_resolution jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ai_handoff_tasks%rowtype;
  v_actor_role text;
  v_allowed boolean := false;
  v_previous_status text;
begin
  select * into v_task
  from public.ai_handoff_tasks
  where id = p_task_id
  for update;

  if not found then raise exception 'handoff task not found'; end if;
  if v_task.version <> p_expected_version then raise exception 'handoff task version conflict'; end if;
  if p_to_status not in ('accepted', 'waiting_client', 'waiting_internal', 'resolved', 'cancelled') then
    raise exception 'invalid handoff task transition';
  end if;

  v_actor_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_actor_role is null then raise exception 'inactive or unknown command centre user'; end if;

  if v_actor_role in ('owner', 'managing_director', 'salon_manager') then
    v_allowed := true;
  elsif v_task.owner_user_id = p_actor_user_id
        and public.ai_cc_can_handle_task(p_actor_user_id, v_task.task_type) then
    v_allowed := true;
  end if;
  if not v_allowed then raise exception 'staff member cannot transition this task'; end if;

  if v_task.status in ('resolved', 'cancelled') then
    raise exception 'terminal handoff task cannot transition';
  end if;
  if v_task.status in ('new', 'assigned') and p_to_status not in ('accepted', 'cancelled') then
    raise exception 'handoff task must be accepted first';
  end if;

  v_previous_status := v_task.status;

  update public.ai_handoff_tasks
  set status = p_to_status,
      accepted_at = case
        when p_to_status = 'accepted' then coalesce(accepted_at, now())
        else accepted_at
      end,
      resolved_at = case
        when p_to_status in ('resolved', 'cancelled') then now()
        else null
      end,
      resolution = case
        when p_to_status in ('resolved', 'cancelled')
          then coalesce(p_resolution, '{}'::jsonb)
        else resolution
      end,
      version = version + 1
  where id = p_task_id
  returning * into v_task;

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
    'staff',
    p_actor_user_id,
    'task_status_changed',
    v_previous_status,
    v_task.status,
    jsonb_build_object(
      'note', nullif(trim(coalesce(p_note, '')), ''),
      'version', v_task.version,
      'resolution', case
        when v_task.status in ('resolved', 'cancelled') then v_task.resolution
        else null
      end
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
    'management',
    p_actor_user_id::text,
    'command_centre_task_transitioned',
    'handoff_task',
    v_task.id::text,
    jsonb_build_object(
      'fromStatus', v_previous_status,
      'toStatus', v_task.status,
      'conversationId', v_task.conversation_id
    )
  );

  return jsonb_build_object(
    'taskId', v_task.id,
    'status', v_task.status,
    'version', v_task.version,
    'resolvedAt', v_task.resolved_at
  );
end;
$$;

create or replace function public.ai_cc_set_conversation_mode(
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_mode text,
  p_reason text,
  p_takeover_until timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_previous_mode text;
  v_conversation public.ai_conversations%rowtype;
begin
  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null
     or not public.ai_cc_has_capability(p_actor_user_id, 'control_conversation') then
    raise exception 'staff member cannot control conversation mode';
  end if;
  if p_mode not in ('ai', 'management') then raise exception 'invalid conversation mode'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'conversation mode reason is required'; end if;
  if p_mode = 'management'
     and p_takeover_until is not null
     and p_takeover_until <= now() then
    raise exception 'takeover expiry must be in the future';
  end if;

  select * into v_conversation
  from public.ai_conversations
  where id = p_conversation_id
  for update;

  if not found then raise exception 'conversation not found'; end if;
  v_previous_mode := v_conversation.operating_mode;

  update public.ai_conversations
  set operating_mode = p_mode,
      human_takeover_until = case
        when p_mode = 'management' then p_takeover_until
        else null
      end,
      state = case
        when p_mode = 'management' then state || jsonb_build_object(
          'commandCentreTakeover', true,
          'commandCentreTakeoverReason', trim(p_reason),
          'commandCentreTakeoverBy', p_actor_user_id,
          'commandCentreTakeoverAt', now()
        )
        else state
          - 'commandCentreTakeover'
          - 'commandCentreTakeoverReason'
          - 'commandCentreTakeoverBy'
          - 'commandCentreTakeoverAt'
          - 'humanTakeoverUntil'
          - 'humanTakeoverProvider'
      end,
      updated_at = now()
  where id = p_conversation_id
  returning * into v_conversation;

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
    'command_centre_conversation_mode_changed',
    'conversation',
    p_conversation_id::text,
    jsonb_build_object(
      'fromMode', v_previous_mode,
      'toMode', p_mode,
      'reason', trim(p_reason),
      'takeoverUntil', v_conversation.human_takeover_until
    )
  );

  return jsonb_build_object(
    'conversationId', v_conversation.id,
    'mode', v_conversation.operating_mode,
    'takeoverUntil', v_conversation.human_takeover_until
  );
end;
$$;

create or replace function public.ai_cc_add_note(
  p_conversation_id uuid,
  p_task_id uuid,
  p_actor_user_id uuid,
  p_body text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note_id uuid;
begin
  if not public.ai_cc_has_capability(p_actor_user_id, 'add_note') then
    raise exception 'staff member cannot add command centre notes';
  end if;

  insert into public.ai_command_centre_notes (
    conversation_id,
    task_id,
    author_user_id,
    body
  ) values (
    p_conversation_id,
    p_task_id,
    p_actor_user_id,
    trim(p_body)
  ) returning id into v_note_id;

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
    'command_centre_note_added',
    'conversation',
    p_conversation_id::text,
    jsonb_build_object('noteId', v_note_id, 'taskId', p_task_id)
  );

  return jsonb_build_object('noteId', v_note_id);
end;
$$;

alter table public.ai_staff_profiles enable row level security;
alter table public.ai_staff_profiles force row level security;
alter table public.ai_handoff_tasks enable row level security;
alter table public.ai_handoff_tasks force row level security;
alter table public.ai_handoff_events enable row level security;
alter table public.ai_handoff_events force row level security;
alter table public.ai_command_centre_notes enable row level security;
alter table public.ai_command_centre_notes force row level security;
alter table public.ai_handoff_sla_policies enable row level security;
alter table public.ai_handoff_sla_policies force row level security;

revoke all on table public.ai_staff_profiles from public, anon, authenticated;
revoke all on table public.ai_handoff_tasks from public, anon, authenticated;
revoke all on table public.ai_handoff_events from public, anon, authenticated;
revoke all on table public.ai_command_centre_notes from public, anon, authenticated;
revoke all on table public.ai_handoff_sla_policies from public, anon, authenticated;

grant select, insert, update, delete on table public.ai_staff_profiles to service_role;
grant select, insert, update, delete on table public.ai_handoff_tasks to service_role;
grant select, insert on table public.ai_handoff_events to service_role;
grant select, insert, update, delete on table public.ai_command_centre_notes to service_role;
grant select, insert, update, delete on table public.ai_handoff_sla_policies to service_role;

revoke all on function public.ai_command_centre_touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.ai_cc_staff_role(uuid) from public, anon, authenticated;
revoke all on function public.ai_cc_has_capability(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_cc_can_handle_task(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_cc_create_task(uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, timestamptz, text, uuid) from public, anon, authenticated;
revoke all on function public.ai_cc_accept_task(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.ai_cc_assign_task(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.ai_cc_transition_task(uuid, uuid, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ai_cc_set_conversation_mode(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.ai_cc_add_note(uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.ai_cc_staff_role(uuid) to service_role;
grant execute on function public.ai_cc_has_capability(uuid, text) to service_role;
grant execute on function public.ai_cc_can_handle_task(uuid, text) to service_role;
grant execute on function public.ai_cc_create_task(uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, jsonb, text, timestamptz, text, uuid) to service_role;
grant execute on function public.ai_cc_accept_task(uuid, uuid, integer) to service_role;
grant execute on function public.ai_cc_assign_task(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.ai_cc_transition_task(uuid, uuid, integer, text, text, jsonb) to service_role;
grant execute on function public.ai_cc_set_conversation_mode(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.ai_cc_add_note(uuid, uuid, uuid, text) to service_role;

commit;
