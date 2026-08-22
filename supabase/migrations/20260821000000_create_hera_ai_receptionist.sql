begin;

create table public.ai_contacts (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique check (wa_id ~ '^[1-9][0-9]{7,14}$'),
  phone_e164 text generated always as ('+' || wa_id) stored,
  profile_name text,
  preferred_language text,
  consent jsonb not null default '{}'::jsonb,
  safety_flags jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.ai_contacts(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel = 'whatsapp'),
  status text not null default 'active'
    check (status in ('active', 'paused', 'resolved', 'blocked')),
  operating_mode text not null default 'ai'
    check (operating_mode in ('ai', 'management')),
  current_risk text not null default 'green'
    check (current_risk in ('green', 'amber', 'red', 'black')),
  state jsonb not null default '{}'::jsonb,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ai_conversations_one_active_per_contact
  on public.ai_conversations(contact_id)
  where status = 'active';

create index ai_conversations_last_message_idx
  on public.ai_conversations(last_message_at desc);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  contact_id uuid not null references public.ai_contacts(id) on delete cascade,
  provider_message_id text,
  direction text not null check (direction in ('inbound', 'outbound')),
  kind text not null check (
    kind in (
      'text', 'image', 'audio', 'video', 'document', 'sticker',
      'interactive', 'button', 'location', 'contacts', 'reaction',
      'order', 'system', 'unknown'
    )
  ),
  text_body text not null default '',
  media jsonb,
  context_message_id text,
  raw_payload jsonb,
  ai_generated boolean not null default false,
  delivery_status text not null default 'received'
    check (delivery_status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'deleted')),
  provider_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ai_messages_provider_id_unique
  on public.ai_messages(provider_message_id)
  where provider_message_id is not null;

create index ai_messages_conversation_created_idx
  on public.ai_messages(conversation_id, created_at desc);

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('process_inbound')),
  source_message_id uuid not null references public.ai_messages(id) on delete cascade,
  dedupe_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'completed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_jobs_claim_idx
  on public.ai_jobs(status, available_at, created_at)
  where status in ('pending', 'retry', 'processing');

create table public.ai_outbox (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.ai_conversations(id) on delete cascade,
  source_message_id uuid references public.ai_messages(id) on delete cascade,
  to_wa_id text not null check (to_wa_id ~ '^[1-9][0-9]{7,14}$'),
  target_type text not null default 'client'
    check (target_type in ('client', 'management')),
  message_type text not null default 'text' check (message_type = 'text'),
  body jsonb not null,
  dedupe_key text not null unique,
  send_authorization text not null default 'auto'
    check (send_authorization in ('auto', 'management')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'sent', 'shadowed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ai_outbox_provider_message_id_unique
  on public.ai_outbox(provider_message_id)
  where provider_message_id is not null;

create index ai_outbox_claim_idx
  on public.ai_outbox(status, available_at, created_at)
  where status in ('pending', 'retry', 'processing');

create table public.ai_decisions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  source_message_id uuid not null references public.ai_messages(id) on delete cascade,
  stage text not null check (stage in ('response', 'verification', 'policy')),
  model_id text,
  prompt_version text not null,
  policy_version text not null,
  risk text not null check (risk in ('green', 'amber', 'red', 'black')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  output jsonb not null,
  usage jsonb not null default '{}'::jsonb,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now()
);

create index ai_decisions_message_idx
  on public.ai_decisions(source_message_id, created_at desc);

create unique index ai_decisions_idempotency_unique
  on public.ai_decisions(source_message_id, stage, prompt_version, policy_version);

create table public.ai_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  document_key text not null unique,
  title text not null,
  body text not null check (length(body) > 0),
  source_url text,
  version text not null,
  checksum text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'retired')),
  valid_from timestamptz,
  valid_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_knowledge_search_idx
  on public.ai_knowledge_documents using gin(search_vector);

create table public.ai_incidents (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  source_message_id uuid references public.ai_messages(id) on delete set null,
  category text not null,
  severity text not null check (severity in ('amber', 'red', 'black')),
  status text not null default 'open'
    check (status in ('open', 'monitoring', 'resolved', 'closed')),
  client_summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  resolution jsonb not null default '{}'::jsonb,
  management_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ai_incidents_message_category_unique
  on public.ai_incidents(source_message_id, category)
  where source_message_id is not null;

create index ai_incidents_open_idx
  on public.ai_incidents(severity, created_at desc)
  where status in ('open', 'monitoring');

create table public.ai_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('system', 'ai', 'management')),
  actor_id text,
  event_type text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index ai_audit_log_created_idx
  on public.ai_audit_log(created_at desc);

alter table public.ai_contacts enable row level security;
alter table public.ai_contacts force row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_conversations force row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_messages force row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_jobs force row level security;
alter table public.ai_outbox enable row level security;
alter table public.ai_outbox force row level security;
alter table public.ai_decisions enable row level security;
alter table public.ai_decisions force row level security;
alter table public.ai_knowledge_documents enable row level security;
alter table public.ai_knowledge_documents force row level security;
alter table public.ai_incidents enable row level security;
alter table public.ai_incidents force row level security;
alter table public.ai_audit_log enable row level security;
alter table public.ai_audit_log force row level security;

revoke all on table public.ai_contacts from public, anon, authenticated;
revoke all on table public.ai_conversations from public, anon, authenticated;
revoke all on table public.ai_messages from public, anon, authenticated;
revoke all on table public.ai_jobs from public, anon, authenticated;
revoke all on table public.ai_outbox from public, anon, authenticated;
revoke all on table public.ai_decisions from public, anon, authenticated;
revoke all on table public.ai_knowledge_documents from public, anon, authenticated;
revoke all on table public.ai_incidents from public, anon, authenticated;
revoke all on table public.ai_audit_log from public, anon, authenticated;

grant select, insert, update, delete on table public.ai_contacts to service_role;
grant select, insert, update, delete on table public.ai_conversations to service_role;
grant select, insert, update, delete on table public.ai_messages to service_role;
grant select, insert, update, delete on table public.ai_jobs to service_role;
grant select, insert, update, delete on table public.ai_outbox to service_role;
grant select, insert, update, delete on table public.ai_decisions to service_role;
grant select, insert, update, delete on table public.ai_knowledge_documents to service_role;
grant select, insert, update, delete on table public.ai_incidents to service_role;
grant select, insert, update, delete on table public.ai_audit_log to service_role;

create or replace function public.ai_ingest_whatsapp_message(
  p_provider_message_id text,
  p_wa_id text,
  p_profile_name text,
  p_phone_number_id text,
  p_business_account_id text,
  p_kind text,
  p_text text,
  p_media jsonb,
  p_context_message_id text,
  p_provider_timestamp timestamptz,
  p_raw jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_job_id uuid;
  v_inserted boolean := false;
begin
  if p_provider_message_id is null or length(trim(p_provider_message_id)) = 0 then
    raise exception 'provider message id is required';
  end if;

  if p_wa_id is null or p_wa_id !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid WhatsApp id';
  end if;

  if p_kind not in (
    'text', 'image', 'audio', 'video', 'document', 'sticker',
    'interactive', 'button', 'location', 'contacts', 'reaction',
    'order', 'system', 'unknown'
  ) then
    raise exception 'invalid message kind';
  end if;

  insert into public.ai_contacts (wa_id, profile_name, last_seen_at, updated_at)
  values (p_wa_id, nullif(trim(p_profile_name), ''), now(), now())
  on conflict (wa_id) do update
    set profile_name = coalesce(excluded.profile_name, public.ai_contacts.profile_name),
        last_seen_at = now(),
        updated_at = now()
  returning id into v_contact_id;

  insert into public.ai_conversations (contact_id, status, last_message_at, updated_at)
  values (v_contact_id, 'active', coalesce(p_provider_timestamp, now()), now())
  on conflict (contact_id) where status = 'active' do update
    set last_message_at = greatest(
          public.ai_conversations.last_message_at,
          excluded.last_message_at
        ),
        updated_at = now()
  returning id into v_conversation_id;

  insert into public.ai_messages (
    conversation_id,
    contact_id,
    provider_message_id,
    direction,
    kind,
    text_body,
    media,
    context_message_id,
    raw_payload,
    delivery_status,
    provider_timestamp
  ) values (
    v_conversation_id,
    v_contact_id,
    p_provider_message_id,
    'inbound',
    p_kind,
    coalesce(p_text, ''),
    p_media,
    p_context_message_id,
    p_raw,
    'received',
    p_provider_timestamp
  )
  on conflict (provider_message_id) where provider_message_id is not null do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    v_inserted := true;

    insert into public.ai_jobs (
      kind,
      source_message_id,
      dedupe_key,
      payload
    ) values (
      'process_inbound',
      v_message_id,
      'inbound:' || p_provider_message_id,
      jsonb_build_object(
        'messageId', v_message_id,
        'phoneNumberId', p_phone_number_id,
        'businessAccountId', p_business_account_id
      )
    )
    on conflict (dedupe_key) do nothing
    returning id into v_job_id;
  else
    select id, conversation_id, contact_id
      into v_message_id, v_conversation_id, v_contact_id
    from public.ai_messages
    where provider_message_id = p_provider_message_id;

    select id into v_job_id
    from public.ai_jobs
    where dedupe_key = 'inbound:' || p_provider_message_id;
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
    'meta_webhook',
    case when v_inserted then 'message_ingested' else 'duplicate_ignored' end,
    'message',
    v_message_id::text,
    jsonb_build_object('providerMessageId', p_provider_message_id)
  );

  return jsonb_build_object(
    'inserted', v_inserted,
    'messageId', v_message_id,
    'conversationId', v_conversation_id,
    'contactId', v_contact_id,
    'jobId', v_job_id
  );
end;
$$;

create or replace function public.ai_claim_jobs(
  p_worker_id text,
  p_limit integer default 10
) returns setof public.ai_jobs
language sql
security definer
set search_path = ''
as $$
  with selected as (
    select candidate.id
    from public.ai_jobs as candidate
    join public.ai_messages as candidate_message
      on candidate_message.id = candidate.source_message_id
    where (
      (
        candidate.status in ('pending', 'retry') and candidate.available_at <= now()
      ) or (
        candidate.status = 'processing' and candidate.locked_at < now() - interval '5 minutes'
      )
    )
    and not exists (
      select 1
      from public.ai_jobs as predecessor
      join public.ai_messages as predecessor_message
        on predecessor_message.id = predecessor.source_message_id
      where predecessor_message.conversation_id = candidate_message.conversation_id
        and predecessor.status in ('pending', 'processing', 'retry')
        and (
          predecessor.created_at < candidate.created_at
          or (
            predecessor.created_at = candidate.created_at
            and predecessor.id::text < candidate.id::text
          )
        )
    )
    order by candidate.available_at asc, candidate.created_at asc
    for update of candidate skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  update public.ai_jobs as job
  set status = 'processing',
      attempts = job.attempts + 1,
      locked_at = now(),
      locked_by = nullif(trim(p_worker_id), ''),
      updated_at = now()
  from selected
  where job.id = selected.id
  returning job.*;
$$;

create or replace function public.ai_claim_outbox(
  p_worker_id text,
  p_limit integer default 10
) returns setof public.ai_outbox
language sql
security definer
set search_path = ''
as $$
  with selected as (
    select candidate.id
    from public.ai_outbox as candidate
    where (
      (
        candidate.status in ('pending', 'retry') and candidate.available_at <= now()
      ) or (
        candidate.status = 'processing' and candidate.locked_at < now() - interval '5 minutes'
      )
    )
    and not exists (
      select 1
      from public.ai_outbox as predecessor
      where predecessor.to_wa_id = candidate.to_wa_id
        and predecessor.status in ('pending', 'processing', 'retry')
        and (
          predecessor.created_at < candidate.created_at
          or (
            predecessor.created_at = candidate.created_at
            and predecessor.id::text < candidate.id::text
          )
        )
    )
    order by candidate.available_at asc, candidate.created_at asc
    for update of candidate skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  )
  update public.ai_outbox as item
  set status = 'processing',
      attempts = item.attempts + 1,
      locked_at = now(),
      locked_by = nullif(trim(p_worker_id), ''),
      updated_at = now()
  from selected
  where item.id = selected.id
  returning item.*;
$$;

create or replace function public.ai_lookup_bookings_by_mobile(
  p_mobile text,
  p_limit integer default 10
) returns table (
  id uuid,
  client_name text,
  service_name text,
  stylist_name text,
  location_name text,
  appointment_at timestamptz,
  booking_status text,
  price numeric,
  currency text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    booking.id,
    booking.client_name,
    booking.service_name,
    booking.stylist_name,
    booking.location_name,
    booking.appointment_at,
    booking.booking_status,
    booking.price,
    booking.currency
  from public.bookings as booking
  where regexp_replace(coalesce(booking.client_mobile, ''), '[^0-9]', '', 'g')
      = regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g')
    and length(regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g')) >= 8
  order by booking.appointment_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 20));
$$;

create or replace function public.ai_search_knowledge(
  p_query text,
  p_limit integer default 5
) returns table (
  id uuid,
  title text,
  excerpt text,
  source_url text,
  version text,
  score real
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    document.id,
    document.title,
    left(document.body, 4000) as excerpt,
    document.source_url,
    document.version,
    ts_rank(
      document.search_vector,
      websearch_to_tsquery('pg_catalog.english'::regconfig, p_query)
    ) as score
  from public.ai_knowledge_documents as document
  where document.status = 'approved'
    and (document.valid_from is null or document.valid_from <= now())
    and (document.valid_until is null or document.valid_until > now())
    and document.search_vector @@ websearch_to_tsquery(
      'pg_catalog.english'::regconfig,
      p_query
    )
  order by score desc, document.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 5), 10));
$$;

create or replace function public.ai_upsert_website_knowledge(
  p_title text,
  p_body text,
  p_source_url text,
  p_checksum text,
  p_version text,
  p_auto_approve boolean,
  p_metadata jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_source_url !~ '^https://(www\.)?herabeauty\.sg/' then
    raise exception 'website source is not on the Hera allowlist';
  end if;
  if length(coalesce(p_body, '')) < 20 or length(p_body) > 120000 then
    raise exception 'website content length is outside the allowed range';
  end if;
  if p_checksum !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid knowledge checksum';
  end if;

  insert into public.ai_knowledge_documents (
    document_key,
    title,
    body,
    source_url,
    version,
    checksum,
    status,
    metadata
  ) values (
    'website:' || p_source_url,
    left(trim(p_title), 500),
    p_body,
    p_source_url,
    p_version,
    p_checksum,
    case when p_auto_approve then 'approved' else 'draft' end,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (document_key) do update
    set title = excluded.title,
        body = excluded.body,
        source_url = excluded.source_url,
        version = excluded.version,
        checksum = excluded.checksum,
        status = case
          when public.ai_knowledge_documents.checksum = excluded.checksum
            then public.ai_knowledge_documents.status
          else excluded.status
        end,
        metadata = excluded.metadata,
        updated_at = now()
  returning status into v_status;

  return v_status;
end;
$$;

create or replace function public.ai_apply_whatsapp_status(
  p_provider_message_id text,
  p_status text,
  p_provider_timestamp timestamptz,
  p_errors jsonb,
  p_raw jsonb
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated boolean := false;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed', 'deleted', 'unknown') then
    raise exception 'invalid WhatsApp status';
  end if;

  if p_status <> 'unknown' then
    update public.ai_messages as message
    set delivery_status = p_status,
        updated_at = now()
    where message.provider_message_id = p_provider_message_id
      and (
        p_status in ('failed', 'deleted')
        or case p_status
             when 'read' then 4
             when 'delivered' then 3
             when 'sent' then 2
             else 0
           end >= case message.delivery_status
             when 'read' then 4
             when 'delivered' then 3
             when 'sent' then 2
             when 'queued' then 1
             else 0
           end
      );
    v_updated := found;
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
    'meta_webhook',
    'delivery_status_received',
    'provider_message',
    p_provider_message_id,
    jsonb_build_object(
      'status', p_status,
      'providerTimestamp', p_provider_timestamp,
      'errors', coalesce(p_errors, '[]'::jsonb),
      'matched', v_updated,
      'raw', p_raw
    )
  );

  return v_updated;
end;
$$;

create or replace function public.ai_mark_outbox_sent(
  p_outbox_id uuid,
  p_provider_message_id text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.ai_outbox%rowtype;
  v_contact_id uuid;
  v_message_id uuid;
begin
  select * into v_item
  from public.ai_outbox
  where id = p_outbox_id
  for update;

  if v_item.id is null then
    raise exception 'outbox item not found';
  end if;

  if v_item.status = 'sent' then
    select id into v_message_id
    from public.ai_messages
    where provider_message_id = coalesce(v_item.provider_message_id, p_provider_message_id);
    return v_message_id;
  end if;

  if v_item.target_type = 'client' and v_item.conversation_id is null then
    raise exception 'client outbox item requires a conversation';
  end if;

  update public.ai_outbox
  set status = 'sent',
      provider_message_id = p_provider_message_id,
      sent_at = now(),
      locked_at = null,
      locked_by = null,
      last_error = null,
      updated_at = now()
  where id = p_outbox_id;

  if v_item.target_type = 'client' then
    select contact_id into v_contact_id
    from public.ai_conversations
    where id = v_item.conversation_id;

    insert into public.ai_messages (
      conversation_id,
      contact_id,
      provider_message_id,
      direction,
      kind,
      text_body,
      ai_generated,
      delivery_status,
      provider_timestamp
    ) values (
      v_item.conversation_id,
      v_contact_id,
      p_provider_message_id,
      'outbound',
      'text',
      coalesce(v_item.body->>'text', ''),
      true,
      'sent',
      now()
    )
    on conflict (provider_message_id) where provider_message_id is not null do update
      set delivery_status = 'sent', updated_at = now()
    returning id into v_message_id;
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
    'outbox_worker',
    'message_sent',
    'outbox',
    p_outbox_id::text,
    jsonb_build_object('providerMessageId', p_provider_message_id)
  );

  return v_message_id;
end;
$$;

revoke all on function public.ai_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_claim_jobs(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_claim_outbox(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_lookup_bookings_by_mobile(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_search_knowledge(text, integer)
  from public, anon, authenticated;
revoke all on function public.ai_upsert_website_knowledge(
  text, text, text, text, text, boolean, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_apply_whatsapp_status(
  text, text, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.ai_mark_outbox_sent(uuid, text)
  from public, anon, authenticated;

grant execute on function public.ai_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;
grant execute on function public.ai_claim_jobs(text, integer) to service_role;
grant execute on function public.ai_claim_outbox(text, integer) to service_role;
grant execute on function public.ai_lookup_bookings_by_mobile(text, integer) to service_role;
grant execute on function public.ai_search_knowledge(text, integer) to service_role;
grant execute on function public.ai_upsert_website_knowledge(
  text, text, text, text, text, boolean, jsonb
) to service_role;
grant execute on function public.ai_apply_whatsapp_status(
  text, text, timestamptz, jsonb, jsonb
) to service_role;
grant execute on function public.ai_mark_outbox_sent(uuid, text) to service_role;

comment on table public.ai_contacts is
  'Private WhatsApp contacts for Hera AI Receptionist; server-side service role only.';
comment on table public.ai_outbox is
  'Durable idempotent outbound queue. Shadow mode records without sending.';
comment on table public.ai_knowledge_documents is
  'Versioned, approved Hera and expert knowledge. Draft documents are never retrieved.';

commit;
