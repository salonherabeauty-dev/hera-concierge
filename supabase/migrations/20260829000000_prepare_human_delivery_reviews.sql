begin;

create table if not exists public.ai_human_delivery_reviews (
  id uuid primary key default gen_random_uuid(),
  candidate_outbox_id uuid not null unique
    references public.ai_outbox(id) on delete restrict,
  approved_outbox_id uuid
    references public.ai_outbox(id) on delete restrict,
  conversation_id uuid not null
    references public.ai_conversations(id) on delete restrict,
  source_message_id uuid not null unique
    references public.ai_messages(id) on delete restrict,
  reviewer_user_id uuid not null
    references public.ai_staff_profiles(user_id) on delete restrict,
  reviewer_role text not null,
  decision text not null,
  candidate_response_hash text not null
    check (candidate_response_hash ~ '^[a-f0-9]{64}$'),
  review_note text,
  escalation_role text,
  delivery_mode text not null default 'human_approved_preview',
  delivery_status text not null default 'not_sent',
  provider_message_id text,
  send_started_at timestamptz,
  sent_at timestamptz,
  failure_code text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_human_delivery_reviews
  add column if not exists escalation_role text,
  add column if not exists delivery_status text not null default 'not_sent',
  add column if not exists provider_message_id text,
  add column if not exists send_started_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists failure_code text;

alter table public.ai_human_delivery_reviews
  alter column delivery_mode set default 'human_approved_preview';

alter table public.ai_human_delivery_reviews
  drop constraint if exists ai_human_delivery_reviews_decision_check,
  drop constraint if exists ai_human_delivery_reviews_check,
  drop constraint if exists ai_human_delivery_reviews_delivery_mode_check,
  drop constraint if exists ai_human_delivery_reviews_reviewer_role_check,
  drop constraint if exists ai_human_delivery_reviews_shape_check,
  drop constraint if exists ai_human_delivery_reviews_escalation_shape_check,
  drop constraint if exists ai_human_delivery_reviews_delivery_status_check,
  drop constraint if exists ai_human_delivery_reviews_escalation_role_check;

alter table public.ai_human_delivery_reviews
  add constraint ai_human_delivery_reviews_decision_check
    check (decision in ('approved', 'rejected', 'escalated')),
  add constraint ai_human_delivery_reviews_shape_check
    check (
      (decision = 'approved' and approved_outbox_id is not null)
      or
      (decision in ('rejected', 'escalated') and approved_outbox_id is null)
    ),
  add constraint ai_human_delivery_reviews_delivery_mode_check
    check (delivery_mode in ('shadow', 'pilot', 'human_approved_preview')),
  add constraint ai_human_delivery_reviews_reviewer_role_check
    check (
      reviewer_role in (
        'owner',
        'managing_director',
        'salon_manager',
        'receptionist',
        'technical_lead',
        'finance_admin',
        'privacy_officer'
      )
    ),
  add constraint ai_human_delivery_reviews_delivery_status_check
    check (delivery_status in ('not_sent', 'sending', 'sent', 'failed')),
  add constraint ai_human_delivery_reviews_escalation_role_check
    check (
      escalation_role is null
      or escalation_role in (
        'salon_manager',
        'technical_lead',
        'finance_admin',
        'privacy_officer'
      )
    ),
  add constraint ai_human_delivery_reviews_escalation_shape_check
    check (
      (decision = 'escalated' and escalation_role is not null)
      or
      (decision <> 'escalated' and escalation_role is null)
    );

create unique index if not exists ai_human_delivery_reviews_approved_outbox_id_unique
  on public.ai_human_delivery_reviews(approved_outbox_id)
  where approved_outbox_id is not null;

create unique index if not exists ai_human_delivery_reviews_provider_message_id_unique
  on public.ai_human_delivery_reviews(provider_message_id)
  where provider_message_id is not null;

create index if not exists ai_human_delivery_reviews_reviewed_at_idx
  on public.ai_human_delivery_reviews(reviewed_at desc);

alter table public.ai_human_delivery_reviews enable row level security;
alter table public.ai_human_delivery_reviews force row level security;

revoke all on table public.ai_human_delivery_reviews
  from public, anon, authenticated;
grant select, insert, update
  on table public.ai_human_delivery_reviews
  to service_role;

create or replace function public.ai_cc_human_delivery_block_reason(
  p_candidate_outbox_id uuid,
  p_actor_user_id uuid
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_candidate public.ai_outbox%rowtype;
  v_conversation public.ai_conversations%rowtype;
  v_contact_wa_id text;
  v_latest_inbound_id uuid;
  v_source_effective_at timestamptz;
  v_source_created_at timestamptz;
  v_policy public.ai_decisions%rowtype;
  v_candidate_text text;
begin
  v_role := public.ai_cc_staff_role(p_actor_user_id);
  if v_role is null then return 'inactive_staff'; end if;
  if v_role not in (
    'owner',
    'managing_director',
    'salon_manager',
    'receptionist',
    'technical_lead',
    'finance_admin',
    'privacy_officer'
  ) then
    return 'role_not_authorized';
  end if;

  select * into v_candidate
  from public.ai_outbox
  where id = p_candidate_outbox_id;

  if not found then return 'candidate_not_found'; end if;
  if v_candidate.target_type <> 'client'
     or v_candidate.source_message_id is null
     or v_candidate.conversation_id is null
     or v_candidate.provider_message_id is not null
     or v_candidate.send_authorization <> 'auto'
     or v_candidate.status not in ('pending', 'shadowed')
     or v_candidate.dedupe_key like 'human-approved:%' then
    return 'candidate_not_reviewable';
  end if;

  if exists (
    select 1
    from public.ai_human_delivery_reviews as review
    where review.candidate_outbox_id = p_candidate_outbox_id
       or review.source_message_id = v_candidate.source_message_id
  ) then
    return 'candidate_already_reviewed';
  end if;

  select * into v_conversation
  from public.ai_conversations
  where id = v_candidate.conversation_id;

  if not found then return 'conversation_not_found'; end if;
  if v_conversation.status <> 'active' then return 'conversation_not_active'; end if;
  if v_conversation.operating_mode <> 'ai' then
    return 'conversation_in_human_control';
  end if;

  select contact.wa_id into v_contact_wa_id
  from public.ai_contacts as contact
  where contact.id = v_conversation.contact_id;

  if v_contact_wa_id is null
     or v_contact_wa_id is distinct from v_candidate.to_wa_id then
    return 'recipient_mismatch';
  end if;

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
    return 'candidate_not_latest';
  end if;

  select
    coalesce(message.provider_timestamp, message.created_at),
    message.created_at
  into v_source_effective_at, v_source_created_at
  from public.ai_messages as message
  where message.id = v_candidate.source_message_id
    and message.conversation_id = v_candidate.conversation_id
    and message.direction = 'inbound';

  if not found then return 'source_message_not_found'; end if;
  if now() - v_source_effective_at >= interval '24 hours' then
    return 'customer_service_window_expired';
  end if;

  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = v_candidate.conversation_id
      and message.direction = 'outbound'
      and (
        coalesce(message.provider_timestamp, message.created_at) > v_source_effective_at
        or (
          coalesce(message.provider_timestamp, message.created_at) = v_source_effective_at
          and message.created_at > v_source_created_at
        )
      )
  ) then
    return 'human_reply_already_recorded';
  end if;

  select * into v_policy
  from public.ai_decisions as decision
  where decision.source_message_id = v_candidate.source_message_id
    and decision.conversation_id = v_candidate.conversation_id
    and decision.stage = 'policy'
  order by decision.created_at desc, decision.id desc
  limit 1;

  if not found then return 'quality_evidence_missing'; end if;

  if v_policy.risk in ('red', 'black')
     and v_role in ('receptionist', 'finance_admin') then
    return 'risk_requires_specialist';
  end if;

  v_candidate_text := coalesce(v_candidate.body->>'text', '');
  if length(v_candidate_text) < 1 then return 'candidate_text_missing'; end if;

  if v_policy.output->>'deliveryEligible' <> 'true'
     or v_policy.output->'finalQuality'->>'passed' <> 'true'
     or v_policy.output->'finalVerification'->>'approved' <> 'true' then
    return 'quality_evidence_failed';
  end if;

  if coalesce(v_policy.output->>'finalReply', '') <> v_candidate_text then
    return 'candidate_text_mismatch';
  end if;

  if v_role = 'technical_lead' and not exists (
    select 1
    from public.ai_handoff_tasks as task
    where task.conversation_id = v_candidate.conversation_id
      and task.status in (
        'new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal'
      )
      and task.task_type in (
        'technical_review', 'medical_safety', 'complaint_review'
      )
  ) then
    return 'role_not_authorized';
  end if;

  if v_role = 'finance_admin' and not exists (
    select 1
    from public.ai_handoff_tasks as task
    where task.conversation_id = v_candidate.conversation_id
      and task.status in (
        'new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal'
      )
      and task.task_type = 'refund_finance'
  ) then
    return 'role_not_authorized';
  end if;

  if v_role = 'privacy_officer' and not exists (
    select 1
    from public.ai_handoff_tasks as task
    where task.conversation_id = v_candidate.conversation_id
      and task.status in (
        'new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal'
      )
      and task.task_type in (
        'privacy_legal', 'consent_media', 'security_review'
      )
  ) then
    return 'role_not_authorized';
  end if;

  if exists (
    select 1
    from public.ai_handoff_tasks as task
    where task.conversation_id = v_candidate.conversation_id
      and task.status in (
        'new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal'
      )
      and not (
        v_role in ('owner', 'managing_director')
        or (
          v_role = 'salon_manager'
          and task.task_type not in (
            'privacy_legal', 'consent_media', 'security_review'
          )
        )
        or (
          v_role = 'receptionist'
          and task.task_type in (
            'booking_action',
            'appointment_change',
            'arrival_issue',
            'group_booking',
            'accessibility_arrangement',
            'lost_property',
            'client_requested_human',
            'other'
          )
          and (task.assigned_role is null or task.assigned_role = 'receptionist')
          and (task.owner_user_id is null or task.owner_user_id = p_actor_user_id)
        )
        or (
          v_role = 'technical_lead'
          and task.task_type in (
            'technical_review', 'medical_safety', 'complaint_review'
          )
          and (task.assigned_role is null or task.assigned_role = 'technical_lead')
          and (task.owner_user_id is null or task.owner_user_id = p_actor_user_id)
        )
        or (
          v_role = 'finance_admin'
          and task.task_type = 'refund_finance'
          and (task.assigned_role is null or task.assigned_role = 'finance_admin')
          and (task.owner_user_id is null or task.owner_user_id = p_actor_user_id)
        )
        or (
          v_role = 'privacy_officer'
          and task.task_type in (
            'privacy_legal', 'consent_media', 'security_review'
          )
          and (task.assigned_role is null or task.assigned_role = 'privacy_officer')
          and (task.owner_user_id is null or task.owner_user_id = p_actor_user_id)
        )
      )
  ) then
    return 'role_not_authorized_for_open_task';
  end if;

  return null;
end;
$$;

commit;
