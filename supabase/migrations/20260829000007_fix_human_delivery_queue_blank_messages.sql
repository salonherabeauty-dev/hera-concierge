begin;

create or replace function public.ai_cc_list_human_delivery_queue(
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
  can_approve boolean,
  can_reject boolean,
  can_escalate boolean,
  approval_block_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    candidate.id as candidate_outbox_id,
    candidate.conversation_id,
    candidate.source_message_id,
    coalesce(
      nullif(trim(contact.profile_name), ''),
      'Client •••• ' || right(contact.wa_id, 4)
    ) as client_display_name,
    right(contact.wa_id, 4) as phone_ending,
    policy.risk,
    coalesce(
      nullif(source.text_body, ''),
      '[Non-text WhatsApp message]'
    ) as client_message,
    candidate.body->>'text' as candidate_text,
    pg_catalog.encode(
      extensions.digest(candidate.body->>'text', 'sha256'),
      'hex'
    ) as response_hash,
    candidate.status as candidate_status,
    candidate.created_at as candidate_created_at,
    guard.block_reason is null as can_approve,
    public.ai_cc_staff_role(p_actor_user_id) in (
      'owner',
      'managing_director',
      'salon_manager',
      'receptionist',
      'technical_lead',
      'privacy_officer'
    ) as can_reject,
    public.ai_cc_staff_role(p_actor_user_id) in (
      'owner',
      'managing_director',
      'salon_manager',
      'receptionist',
      'technical_lead',
      'finance_admin',
      'privacy_officer'
    ) as can_escalate,
    guard.block_reason as approval_block_reason
  from public.ai_outbox as candidate
  join public.ai_conversations as conversation
    on conversation.id = candidate.conversation_id
  join public.ai_contacts as contact
    on contact.id = conversation.contact_id
  join public.ai_messages as source
    on source.id = candidate.source_message_id
  join lateral (
    select decision.risk, decision.output
    from public.ai_decisions as decision
    where decision.source_message_id = candidate.source_message_id
      and decision.conversation_id = candidate.conversation_id
      and decision.stage = 'policy'
    order by decision.created_at desc, decision.id desc
    limit 1
  ) as policy on true
  join lateral (
    select public.ai_cc_human_delivery_block_reason(
      candidate.id,
      p_actor_user_id
    ) as block_reason
  ) as guard on true
  where public.ai_cc_staff_role(p_actor_user_id) is not null
    and candidate.target_type = 'client'
    and candidate.source_message_id is not null
    and candidate.conversation_id is not null
    and candidate.provider_message_id is null
    and candidate.send_authorization = 'auto'
    and candidate.status in ('pending', 'shadowed')
    and candidate.dedupe_key not like 'human-approved:%'
    and source.direction = 'inbound'
    and (p_conversation_id is null or candidate.conversation_id = p_conversation_id)
    and not exists (
      select 1
      from public.ai_human_delivery_reviews as review
      where review.candidate_outbox_id = candidate.id
         or review.source_message_id = candidate.source_message_id
    )
    and source.id = (
      select latest.id
      from public.ai_messages as latest
      where latest.conversation_id = candidate.conversation_id
        and latest.direction = 'inbound'
      order by
        coalesce(latest.provider_timestamp, latest.created_at) desc,
        latest.created_at desc,
        latest.id desc
      limit 1
    )
  order by candidate.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke all on function public.ai_cc_list_human_delivery_queue(
  uuid,
  uuid,
  integer
) from public, anon, authenticated;
grant execute on function public.ai_cc_list_human_delivery_queue(
  uuid,
  uuid,
  integer
) to service_role;

commit;