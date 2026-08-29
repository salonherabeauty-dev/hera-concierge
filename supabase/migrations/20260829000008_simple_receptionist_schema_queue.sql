begin;

alter table public.ai_human_delivery_reviews
  add column if not exists final_response_hash text,
  add column if not exists edited_by_human boolean not null default false;

alter table public.ai_human_delivery_reviews
  drop constraint if exists ai_human_delivery_reviews_final_response_hash_check;

alter table public.ai_human_delivery_reviews
  add constraint ai_human_delivery_reviews_final_response_hash_check
  check (
    final_response_hash is null
    or final_response_hash ~ '^[a-f0-9]{64}$'
  );

create table if not exists public.ai_receptionist_regeneration_history (
  id uuid primary key default gen_random_uuid(),
  candidate_outbox_id uuid not null
    references public.ai_outbox(id) on delete restrict,
  conversation_id uuid not null
    references public.ai_conversations(id) on delete restrict,
  source_message_id uuid not null
    references public.ai_messages(id) on delete restrict,
  requested_by_user_id uuid not null
    references public.ai_staff_profiles(user_id) on delete restrict,
  previous_dedupe_key text not null,
  previous_candidate_body jsonb not null,
  previous_candidate_hash text not null
    check (previous_candidate_hash ~ '^[a-f0-9]{64}$'),
  previous_decisions jsonb not null default '[]'::jsonb,
  regeneration_key text not null unique,
  job_id uuid
    references public.ai_jobs(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists ai_receptionist_regeneration_history_source_idx
  on public.ai_receptionist_regeneration_history(
    source_message_id,
    created_at desc
  );

create index if not exists ai_receptionist_regeneration_history_requester_idx
  on public.ai_receptionist_regeneration_history(
    requested_by_user_id,
    created_at desc
  );

alter table public.ai_receptionist_regeneration_history
  enable row level security;
alter table public.ai_receptionist_regeneration_history
  force row level security;

revoke all on table public.ai_receptionist_regeneration_history
  from public, anon, authenticated;
grant select, insert, update
  on table public.ai_receptionist_regeneration_history
  to service_role;

create or replace function public.ai_cc_receptionist_candidate_block_reason(
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
    'receptionist'
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
     or v_candidate.dedupe_key like 'human-approved:%'
     or v_candidate.dedupe_key like 'human-receptionist:%'
     or v_candidate.dedupe_key like 'regenerated-archive:%' then
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
        coalesce(message.provider_timestamp, message.created_at)
          > v_source_effective_at
        or (
          coalesce(message.provider_timestamp, message.created_at)
            = v_source_effective_at
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

  return null;
end;
$$;

create or replace function public.ai_cc_list_receptionist_queue(
  p_actor_user_id uuid,
  p_conversation_id uuid default null,
  p_limit integer default 50
) returns table (
  candidate_outbox_id uuid,
  conversation_id uuid,
  source_message_id uuid,
  client_display_name text,
  phone_ending text,
  risk text,
  client_message text,
  candidate_text text,
  response_hash text,
  candidate_status text,
  candidate_created_at timestamptz,
  can_send boolean,
  block_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    candidate.id,
    candidate.conversation_id,
    candidate.source_message_id,
    coalesce(
      nullif(trim(contact.profile_name), ''),
      'Client •••• ' || right(contact.wa_id, 4)
    ),
    right(contact.wa_id, 4),
    policy.risk,
    coalesce(
      nullif(source.text_body, ''),
      '[Non-text WhatsApp message]'
    ),
    candidate.body->>'text',
    pg_catalog.encode(
      extensions.digest(candidate.body->>'text', 'sha256'),
      'hex'
    ),
    candidate.status,
    candidate.created_at,
    true,
    null::text
  from public.ai_outbox as candidate
  join public.ai_conversations as conversation
    on conversation.id = candidate.conversation_id
  join public.ai_contacts as contact
    on contact.id = conversation.contact_id
  join public.ai_messages as source
    on source.id = candidate.source_message_id
  join lateral (
    select decision.risk
    from public.ai_decisions as decision
    where decision.source_message_id = candidate.source_message_id
      and decision.conversation_id = candidate.conversation_id
      and decision.stage = 'policy'
    order by decision.created_at desc, decision.id desc
    limit 1
  ) as policy on true
  join lateral (
    select public.ai_cc_receptionist_candidate_block_reason(
      candidate.id,
      p_actor_user_id
    ) as reason
  ) as guard on true
  where guard.reason is null
    and (p_conversation_id is null or candidate.conversation_id = p_conversation_id)
  order by candidate.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on function public.ai_cc_receptionist_candidate_block_reason(
  uuid,
  uuid
) from public, anon, authenticated;
grant execute on function public.ai_cc_receptionist_candidate_block_reason(
  uuid,
  uuid
) to service_role;

revoke all on function public.ai_cc_list_receptionist_queue(
  uuid,
  uuid,
  integer
) from public, anon, authenticated;
grant execute on function public.ai_cc_list_receptionist_queue(
  uuid,
  uuid,
  integer
) to service_role;

commit;
