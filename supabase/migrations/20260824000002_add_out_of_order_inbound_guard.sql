begin;

create index if not exists ai_messages_conversation_provider_time_idx
  on public.ai_messages(
    conversation_id,
    provider_timestamp desc,
    created_at desc
  )
  where direction = 'inbound';

create or replace function public.ai_is_inbound_superseded(
  p_message_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select exists (
      select 1
      from public.ai_messages as newer
      where newer.conversation_id = current_message.conversation_id
        and newer.id <> current_message.id
        and newer.direction = 'inbound'
        and newer.kind not in ('reaction', 'system')
        and (
          coalesce(newer.provider_timestamp, newer.created_at)
            > coalesce(current_message.provider_timestamp, current_message.created_at)
          or (
            coalesce(newer.provider_timestamp, newer.created_at)
              = coalesce(current_message.provider_timestamp, current_message.created_at)
            and newer.created_at > current_message.created_at
          )
        )
    )
    from public.ai_messages as current_message
    where current_message.id = p_message_id
      and current_message.direction = 'inbound'
  ), false);
$$;

revoke all on function public.ai_is_inbound_superseded(uuid)
  from public, anon, authenticated;
grant execute on function public.ai_is_inbound_superseded(uuid)
  to service_role;

commit;
