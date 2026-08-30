begin;

create table if not exists public.ai_reset_client_turns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  contact_id uuid not null references public.ai_contacts(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null default 'collecting' check (
    status in ('collecting', 'queued', 'processing', 'ready', 'failed', 'superseded')
  ),
  delivery_control text not null default 'human_only' check (
    delivery_control = 'human_only'
  ),
  fragment_ids uuid[] not null check (cardinality(fragment_ids) > 0),
  assembled_text text not null default '' check (length(assembled_text) <= 24000),
  attachments jsonb not null default '[]'::jsonb check (
    jsonb_typeof(attachments) = 'array'
  ),
  first_fragment_at timestamptz not null,
  last_fragment_at timestamptz not null,
  settle_at timestamptz not null,
  superseded_by_turn_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, version),
  unique (id, conversation_id),
  check (last_fragment_at >= first_fragment_at),
  check (
    (status = 'superseded') or superseded_by_turn_id is null
  )
);

alter table public.ai_reset_client_turns
  add constraint ai_reset_client_turns_superseded_by_fkey
  foreign key (superseded_by_turn_id)
  references public.ai_reset_client_turns(id)
  on delete set null;

create unique index if not exists ai_reset_one_current_turn_per_conversation
  on public.ai_reset_client_turns (conversation_id)
  where status <> 'superseded';

create index if not exists ai_reset_client_turns_activity_idx
  on public.ai_reset_client_turns (last_fragment_at desc);

create table if not exists public.ai_reset_draft_runs (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references public.ai_reset_client_turns(id) on delete cascade,
  generation integer not null default 1 check (generation > 0),
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'ready', 'failed', 'superseded', 'held', 'sent')
  ),
  origin text not null default 'ai' check (origin in ('ai', 'human_manual')),
  candidate_text text null check (
    candidate_text is null or (length(btrim(candidate_text)) between 1 and 4000)
  ),
  candidate_hash text null check (
    candidate_hash is null or candidate_hash ~ '^[a-f0-9]{64}$'
  ),
  reply_required boolean null,
  model_id text null,
  model_calls integer not null default 0 check (model_calls between 0 and 2),
  rewrite_used boolean not null default false,
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  validation_issues jsonb not null default '[]'::jsonb check (
    jsonb_typeof(validation_issues) = 'array'
  ),
  model_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(model_metadata) = 'object'
  ),
  failure_code text null check (
    failure_code is null or length(failure_code) between 1 and 120
  ),
  failure_message text null check (
    failure_message is null or length(failure_message) between 1 and 500
  ),
  process_attempts integer not null default 0 check (process_attempts between 0 and 3),
  available_at timestamptz not null default now(),
  locked_at timestamptz null,
  locked_by text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (turn_id, generation),
  check (
    (status in ('pending', 'processing')
      and candidate_text is null
      and candidate_hash is null
      and failure_code is null
      and failure_message is null)
    or
    (status in ('ready', 'held', 'sent')
      and candidate_text is not null
      and candidate_hash is not null
      and failure_code is null
      and failure_message is null)
    or
    (status = 'failed'
      and candidate_text is null
      and candidate_hash is null
      and failure_code is not null
      and failure_message is not null)
    or
    (status = 'superseded')
  ),
  check (
    origin = 'human_manual'
    or (model_id is null or model_id = 'openai/gpt-5.6-sol')
  ),
  check (
    (origin = 'human_manual' and model_calls = 0)
    or origin = 'ai'
  )
);

create unique index if not exists ai_reset_one_active_draft_per_turn
  on public.ai_reset_draft_runs (turn_id)
  where status in ('pending', 'processing', 'ready', 'held');

create index if not exists ai_reset_draft_claim_idx
  on public.ai_reset_draft_runs (status, available_at, created_at)
  where status in ('pending', 'processing');

create table if not exists public.ai_reset_human_sends (
  id uuid primary key default gen_random_uuid(),
  draft_run_id uuid not null references public.ai_reset_draft_runs(id) on delete restrict,
  turn_id uuid not null references public.ai_reset_client_turns(id) on delete restrict,
  conversation_id uuid not null references public.ai_conversations(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  to_wa_id text not null check (to_wa_id ~ '^[1-9][0-9]{7,14}$'),
  expected_phone_ending text not null check (expected_phone_ending ~ '^[0-9]{4}$'),
  candidate_hash text not null check (candidate_hash ~ '^[a-f0-9]{64}$'),
  final_text text not null check (length(btrim(final_text)) between 1 and 4000),
  final_hash text not null check (final_hash ~ '^[a-f0-9]{64}$'),
  edited_by_human boolean not null,
  status text not null default 'reserved' check (
    status in ('reserved', 'sent', 'failed')
  ),
  attempts integer not null default 1 check (attempts between 1 and 3),
  provider_message_id text null,
  failure_code text null,
  reserved_at timestamptz not null default now(),
  sent_at timestamptz null,
  failed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (draft_run_id),
  unique (provider_message_id),
  check (
    (status = 'reserved' and provider_message_id is null and sent_at is null)
    or
    (status = 'sent' and provider_message_id is not null and sent_at is not null)
    or
    (status = 'failed' and provider_message_id is null and failure_code is not null)
  )
);

create index if not exists ai_reset_human_sends_conversation_idx
  on public.ai_reset_human_sends (conversation_id, created_at desc);

alter table public.ai_reset_client_turns enable row level security;
alter table public.ai_reset_client_turns force row level security;
alter table public.ai_reset_draft_runs enable row level security;
alter table public.ai_reset_draft_runs force row level security;
alter table public.ai_reset_human_sends enable row level security;
alter table public.ai_reset_human_sends force row level security;

revoke all on public.ai_reset_client_turns from public, anon, authenticated;
revoke all on public.ai_reset_draft_runs from public, anon, authenticated;
revoke all on public.ai_reset_human_sends from public, anon, authenticated;
grant all on public.ai_reset_client_turns to service_role;
grant all on public.ai_reset_draft_runs to service_role;
grant all on public.ai_reset_human_sends to service_role;

create or replace function public.ai_reset_staff_role(p_actor_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select profile.role
  from public.ai_staff_profiles as profile
  where profile.user_id = p_actor_user_id
    and profile.status = 'active'
  limit 1;
$$;

revoke all on function public.ai_reset_staff_role(uuid)
  from public, anon, authenticated;
grant execute on function public.ai_reset_staff_role(uuid) to service_role;

create or replace function public.ai_reset_fragment_text(
  p_kind text,
  p_text text
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
begin
  if p_kind in ('reaction', 'system') then
    return '';
  end if;
  if p_kind = 'unknown'
     and v_text ~* '^\[unsupported (human )?whatsapp message (received|sent)\]$'
  then
    return '';
  end if;
  return v_text;
end;
$$;

revoke all on function public.ai_reset_fragment_text(text, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_fragment_text(text, text)
  to service_role;

create or replace function public.ai_reset_ingest_whatsapp_message(
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
  v_turn_id uuid := gen_random_uuid();
  v_draft_id uuid := gen_random_uuid();
  v_previous public.ai_reset_client_turns%rowtype;
  v_version integer := 1;
  v_fragment_ids uuid[];
  v_assembled_text text;
  v_fragment_text text;
  v_attachments jsonb := '[]'::jsonb;
  v_attachment jsonb;
  v_consolidate boolean := false;
  v_first_fragment_at timestamptz;
  v_settle_at timestamptz := now() + interval '8 seconds';
  v_inserted boolean := false;
begin
  if p_provider_message_id is null or length(btrim(p_provider_message_id)) < 1 then
    raise exception 'provider message id is required' using errcode = '22023';
  end if;
  if p_wa_id is null or p_wa_id !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'valid WhatsApp id is required' using errcode = '22023';
  end if;
  if p_kind not in (
    'text', 'image', 'audio', 'video', 'document', 'sticker',
    'interactive', 'button', 'location', 'contacts', 'reaction',
    'order', 'system', 'unknown'
  ) then
    raise exception 'invalid WhatsApp message kind' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('reset-wa:' || p_wa_id, 0));

  insert into public.ai_contacts (
    wa_id,
    phone_e164,
    profile_name,
    last_seen_at,
    updated_at
  ) values (
    p_wa_id,
    '+' || p_wa_id,
    nullif(btrim(p_profile_name), ''),
    now(),
    now()
  )
  on conflict (wa_id) do update
    set profile_name = coalesce(nullif(btrim(excluded.profile_name), ''), public.ai_contacts.profile_name),
        phone_e164 = coalesce(public.ai_contacts.phone_e164, excluded.phone_e164),
        last_seen_at = greatest(public.ai_contacts.last_seen_at, excluded.last_seen_at),
        updated_at = now()
  returning id into v_contact_id;

  select conversation.id
    into v_conversation_id
  from public.ai_conversations as conversation
  where conversation.contact_id = v_contact_id
    and conversation.status = 'active'
  for update;

  if v_conversation_id is null then
    insert into public.ai_conversations (
      contact_id,
      channel,
      status,
      operating_mode,
      current_risk,
      state,
      last_message_at
    ) values (
      v_contact_id,
      'whatsapp',
      'active',
      'ai',
      'green',
      jsonb_build_object(
        'resetArchitecture', 'hera-receptionist-reset-1.0.0',
        'deliveryControl', 'human_only'
      ),
      p_provider_timestamp
    )
    returning id into v_conversation_id;
  end if;

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
    ai_generated,
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
    coalesce(p_raw, '{}'::jsonb),
    false,
    'received',
    p_provider_timestamp
  )
  on conflict (provider_message_id)
    where provider_message_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select message.id
      into v_message_id
    from public.ai_messages as message
    where message.provider_message_id = p_provider_message_id;

    return jsonb_build_object(
      'inserted', false,
      'messageId', v_message_id,
      'conversationId', v_conversation_id,
      'contactId', v_contact_id,
      'turnId', null,
      'draftRunId', null
    );
  end if;
  v_inserted := true;

  update public.ai_conversations
  set last_message_at = greatest(last_message_at, p_provider_timestamp),
      state = coalesce(state, '{}'::jsonb) || jsonb_build_object(
        'resetArchitecture', 'hera-receptionist-reset-1.0.0',
        'deliveryControl', 'human_only'
      ),
      updated_at = now()
  where id = v_conversation_id;

  if p_kind in ('reaction', 'system') then
    return jsonb_build_object(
      'inserted', v_inserted,
      'messageId', v_message_id,
      'conversationId', v_conversation_id,
      'contactId', v_contact_id,
      'turnId', null,
      'draftRunId', null
    );
  end if;

  select turn.*
    into v_previous
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1
  for update;

  if v_previous.id is not null then
    v_version := v_previous.version + 1;
    v_consolidate :=
      p_provider_timestamp >= v_previous.last_fragment_at
      and p_provider_timestamp - v_previous.last_fragment_at <= interval '15 seconds';
  end if;

  v_fragment_text := public.ai_reset_fragment_text(p_kind, p_text);
  v_attachment := jsonb_build_object(
    'messageId', v_message_id,
    'kind', p_kind,
    'media', coalesce(p_media, 'null'::jsonb),
    'caption', nullif(v_fragment_text, ''),
    'readable', p_kind <> 'unknown'
  );

  if v_consolidate then
    v_fragment_ids := v_previous.fragment_ids || v_message_id;
    v_first_fragment_at := v_previous.first_fragment_at;
    v_assembled_text := btrim(
      concat_ws(E'\n', nullif(v_previous.assembled_text, ''), nullif(v_fragment_text, ''))
    );
    v_attachments := v_previous.attachments;
  else
    v_fragment_ids := array[v_message_id];
    v_first_fragment_at := p_provider_timestamp;
    v_assembled_text := v_fragment_text;
  end if;

  if p_kind in ('image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'order', 'unknown') then
    v_attachments := coalesce(v_attachments, '[]'::jsonb) || jsonb_build_array(v_attachment);
  end if;

  if length(v_assembled_text) = 0 and jsonb_array_length(v_attachments) > 0 then
    v_assembled_text := 'The client sent one or more attachments. Inspect the attached content before drafting.';
  end if;

  if v_previous.id is not null then
    update public.ai_reset_client_turns
    set status = 'superseded',
        superseded_by_turn_id = v_turn_id,
        updated_at = now()
    where id = v_previous.id;

    update public.ai_reset_draft_runs
    set status = 'superseded',
        locked_at = null,
        locked_by = null,
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where turn_id = v_previous.id
      and status <> 'sent';
  end if;

  insert into public.ai_reset_client_turns (
    id,
    conversation_id,
    contact_id,
    version,
    status,
    delivery_control,
    fragment_ids,
    assembled_text,
    attachments,
    first_fragment_at,
    last_fragment_at,
    settle_at
  ) values (
    v_turn_id,
    v_conversation_id,
    v_contact_id,
    v_version,
    'collecting',
    'human_only',
    v_fragment_ids,
    left(v_assembled_text, 24000),
    v_attachments,
    v_first_fragment_at,
    p_provider_timestamp,
    v_settle_at
  );

  insert into public.ai_reset_draft_runs (
    id,
    turn_id,
    generation,
    status,
    origin,
    available_at
  ) values (
    v_draft_id,
    v_turn_id,
    1,
    'pending',
    'ai',
    v_settle_at
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
    'hera_receptionist_reset',
    'reset_client_turn_created',
    'reset_client_turn',
    v_turn_id::text,
    jsonb_build_object(
      'conversationId', v_conversation_id,
      'messageId', v_message_id,
      'draftRunId', v_draft_id,
      'version', v_version,
      'fragmentCount', cardinality(v_fragment_ids),
      'consolidated', v_consolidate,
      'deliveryControl', 'human_only'
    )
  );

  return jsonb_build_object(
    'inserted', true,
    'messageId', v_message_id,
    'conversationId', v_conversation_id,
    'contactId', v_contact_id,
    'turnId', v_turn_id,
    'draftRunId', v_draft_id
  );
end;
$$;

revoke all on function public.ai_reset_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_ingest_whatsapp_message(
  text, text, text, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;

create or replace function public.ai_reset_note_human_outbound(
  p_conversation_id uuid,
  p_message_id uuid,
  p_provider_timestamp timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('reset-conversation:' || p_conversation_id::text, 0));

  select turn.id
    into v_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = p_conversation_id
    and turn.status <> 'superseded'
    and turn.last_fragment_at <= p_provider_timestamp
  order by turn.version desc
  limit 1
  for update;

  if v_turn_id is null then
    return;
  end if;

  update public.ai_reset_client_turns
  set status = 'superseded',
      updated_at = now()
  where id = v_turn_id;

  update public.ai_reset_draft_runs
  set status = 'superseded',
      locked_at = null,
      locked_by = null,
      completed_at = coalesce(completed_at, now()),
      updated_at = now()
  where turn_id = v_turn_id
    and status <> 'sent';

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'human',
    'whatsapp_business_app',
    'reset_turn_superseded_by_human_reply',
    'reset_client_turn',
    v_turn_id::text,
    jsonb_build_object(
      'conversationId', p_conversation_id,
      'humanMessageId', p_message_id,
      'providerTimestamp', p_provider_timestamp
    )
  );
end;
$$;

revoke all on function public.ai_reset_note_human_outbound(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ai_reset_note_human_outbound(uuid, uuid, timestamptz)
  to service_role;

create or replace function public.ai_reset_reconcile_timeouts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with expired as (
    update public.ai_reset_draft_runs as draft
    set status = 'failed',
        candidate_text = null,
        candidate_hash = null,
        failure_code = case
          when draft.status = 'processing' then 'worker_timeout'
          else 'queue_timeout'
        end,
        failure_message = case
          when draft.status = 'processing'
            then 'AI drafting did not finish within the protected processing window. Retry once or write the reply manually.'
          else 'AI drafting did not start within the protected queue window. Retry once or write the reply manually.'
        end,
        locked_at = null,
        locked_by = null,
        completed_at = now(),
        updated_at = now()
    where (
      draft.status = 'processing'
      and draft.locked_at < now() - interval '7 minutes'
    ) or (
      draft.status = 'pending'
      and draft.available_at < now() - interval '10 minutes'
    )
    returning draft.turn_id
  ), updated_turns as (
    update public.ai_reset_client_turns as turn
    set status = 'failed',
        updated_at = now()
    where turn.id in (select turn_id from expired)
      and turn.status <> 'superseded'
    returning turn.id
  )
  select count(*) into v_count from updated_turns;

  return v_count;
end;
$$;

revoke all on function public.ai_reset_reconcile_timeouts()
  from public, anon, authenticated;
grant execute on function public.ai_reset_reconcile_timeouts()
  to service_role;

create or replace function public.ai_reset_claim_draft_runs(
  p_worker_id text,
  p_limit integer default 3
) returns table (
  draft_run_id uuid,
  turn_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ai_reset_reconcile_timeouts();

  return query
  with candidates as (
    select draft.id
    from public.ai_reset_draft_runs as draft
    join public.ai_reset_client_turns as turn on turn.id = draft.turn_id
    where draft.status = 'pending'
      and draft.available_at <= now()
      and turn.status in ('collecting', 'queued')
      and turn.superseded_by_turn_id is null
    order by turn.last_fragment_at asc, draft.created_at asc
    for update of draft skip locked
    limit greatest(1, least(coalesce(p_limit, 3), 10))
  ), claimed as (
    update public.ai_reset_draft_runs as draft
    set status = 'processing',
        process_attempts = draft.process_attempts + 1,
        locked_at = now(),
        locked_by = left(coalesce(p_worker_id, ''), 160),
        started_at = coalesce(draft.started_at, now()),
        updated_at = now()
    from candidates
    where draft.id = candidates.id
    returning draft.id, draft.turn_id
  )
  update public.ai_reset_client_turns as turn
  set status = 'processing',
      updated_at = now()
  from claimed
  where turn.id = claimed.turn_id
  returning claimed.id, claimed.turn_id;
end;
$$;

revoke all on function public.ai_reset_claim_draft_runs(text, integer)
  from public, anon, authenticated;
grant execute on function public.ai_reset_claim_draft_runs(text, integer)
  to service_role;

create or replace function public.ai_reset_mark_draft_ready(
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
  v_turn public.ai_reset_client_turns%rowtype;
  v_draft public.ai_reset_draft_runs%rowtype;
  v_hash text;
  v_current_turn_id uuid;
begin
  if p_model_id is distinct from 'openai/gpt-5.6-sol' then
    raise exception 'reset model id is not allowed' using errcode = '23514';
  end if;
  if p_model_calls not between 1 and 2 then
    raise exception 'reset model-call count is invalid' using errcode = '23514';
  end if;
  if length(btrim(coalesce(p_candidate_text, ''))) not between 1 and 4000 then
    raise exception 'reset candidate text is invalid' using errcode = '23514';
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = p_turn_id
  for update;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = p_draft_run_id
    and turn_id = p_turn_id
  for update;

  if v_turn.id is null or v_draft.id is null then
    return jsonb_build_object('ok', false, 'state', 'not_found');
  end if;

  select turn.id into v_current_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_turn.conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1;

  if v_turn.version <> p_turn_version
     or v_current_turn_id is distinct from v_turn.id
     or v_turn.superseded_by_turn_id is not null
     or v_draft.status <> 'processing'
  then
    update public.ai_reset_draft_runs
    set status = 'superseded',
        locked_at = null,
        locked_by = null,
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where id = p_draft_run_id
      and status <> 'sent';
    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  v_hash := pg_catalog.encode(
    extensions.digest(btrim(p_candidate_text), 'sha256'),
    'hex'
  );

  update public.ai_reset_draft_runs
  set status = 'ready',
      candidate_text = btrim(p_candidate_text),
      candidate_hash = v_hash,
      reply_required = p_reply_required,
      model_id = p_model_id,
      model_calls = p_model_calls,
      rewrite_used = p_rewrite_used,
      evidence = coalesce(p_evidence, '[]'::jsonb),
      validation_issues = coalesce(p_validation_issues, '[]'::jsonb),
      model_metadata = coalesce(p_model_metadata, '{}'::jsonb),
      failure_code = null,
      failure_message = null,
      locked_at = null,
      locked_by = null,
      completed_at = now(),
      updated_at = now()
  where id = p_draft_run_id;

  update public.ai_reset_client_turns
  set status = 'ready',
      updated_at = now()
  where id = p_turn_id;

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'ai',
    p_model_id,
    'reset_draft_ready',
    'reset_draft_run',
    p_draft_run_id::text,
    jsonb_build_object(
      'turnId', p_turn_id,
      'turnVersion', p_turn_version,
      'candidateHash', v_hash,
      'modelCalls', p_model_calls,
      'rewriteUsed', p_rewrite_used,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'ready',
    'draftRunId', p_draft_run_id,
    'candidateHash', v_hash
  );
end;
$$;

revoke all on function public.ai_reset_mark_draft_ready(
  uuid, uuid, integer, text, boolean, text, integer, boolean, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_mark_draft_ready(
  uuid, uuid, integer, text, boolean, text, integer, boolean, jsonb, jsonb, jsonb
) to service_role;

create or replace function public.ai_reset_mark_draft_failed(
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
  v_turn public.ai_reset_client_turns%rowtype;
  v_draft public.ai_reset_draft_runs%rowtype;
  v_current_turn_id uuid;
begin
  if length(btrim(coalesce(p_failure_code, ''))) not between 1 and 120
     or length(btrim(coalesce(p_failure_message, ''))) not between 1 and 500
     or p_model_calls not between 0 and 2
  then
    raise exception 'reset failure record is invalid' using errcode = '23514';
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = p_turn_id
  for update;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = p_draft_run_id
    and turn_id = p_turn_id
  for update;

  if v_turn.id is null or v_draft.id is null then
    return jsonb_build_object('ok', false, 'state', 'not_found');
  end if;

  select turn.id into v_current_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_turn.conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1;

  if v_turn.version <> p_turn_version
     or v_current_turn_id is distinct from v_turn.id
     or v_turn.superseded_by_turn_id is not null
  then
    update public.ai_reset_draft_runs
    set status = 'superseded',
        locked_at = null,
        locked_by = null,
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where id = p_draft_run_id
      and status <> 'sent';
    return jsonb_build_object('ok', false, 'state', 'superseded');
  end if;

  update public.ai_reset_draft_runs
  set status = 'failed',
      candidate_text = null,
      candidate_hash = null,
      reply_required = null,
      model_calls = p_model_calls,
      failure_code = btrim(p_failure_code),
      failure_message = btrim(p_failure_message),
      model_metadata = coalesce(p_model_metadata, '{}'::jsonb),
      locked_at = null,
      locked_by = null,
      completed_at = now(),
      updated_at = now()
  where id = p_draft_run_id
    and status in ('pending', 'processing');

  update public.ai_reset_client_turns
  set status = 'failed',
      updated_at = now()
  where id = p_turn_id
    and status <> 'superseded';

  insert into public.ai_audit_log (
    actor_type,
    actor_id,
    event_type,
    target_type,
    target_id,
    details
  ) values (
    'system',
    'hera_receptionist_reset',
    'reset_draft_failed',
    'reset_draft_run',
    p_draft_run_id::text,
    jsonb_build_object(
      'turnId', p_turn_id,
      'turnVersion', p_turn_version,
      'failureCode', btrim(p_failure_code),
      'modelCalls', p_model_calls,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object('ok', true, 'state', 'failed');
end;
$$;

revoke all on function public.ai_reset_mark_draft_failed(
  uuid, uuid, integer, text, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.ai_reset_mark_draft_failed(
  uuid, uuid, integer, text, text, integer, jsonb
) to service_role;

create or replace function public.ai_reset_request_regeneration(
  p_actor_user_id uuid,
  p_turn_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_turn public.ai_reset_client_turns%rowtype;
  v_current public.ai_reset_draft_runs%rowtype;
  v_contact public.ai_contacts%rowtype;
  v_generation integer;
  v_new_draft_id uuid := gen_random_uuid();
begin
  v_role := public.ai_reset_staff_role(p_actor_user_id);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_authorized');
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = p_turn_id
    and status <> 'superseded'
  for update;
  if v_turn.id is null then
    return jsonb_build_object('ok', false, 'code', 'turn_not_current');
  end if;

  select * into v_contact
  from public.ai_contacts
  where id = v_turn.contact_id;
  if right(v_contact.wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;

  select * into v_current
  from public.ai_reset_draft_runs
  where turn_id = p_turn_id
    and status in ('pending', 'processing', 'ready', 'failed', 'held')
  order by generation desc
  limit 1
  for update;

  if v_current.id is not null
     and v_current.candidate_hash is not null
     and v_current.candidate_hash is distinct from p_expected_candidate_hash
  then
    return jsonb_build_object('ok', false, 'code', 'candidate_changed');
  end if;

  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and coalesce(message.provider_timestamp, message.created_at) > v_turn.last_fragment_at
  ) then
    return jsonb_build_object('ok', false, 'code', 'human_reply_already_recorded');
  end if;

  if v_current.id is not null then
    update public.ai_reset_draft_runs
    set status = 'superseded',
        locked_at = null,
        locked_by = null,
        completed_at = coalesce(completed_at, now()),
        updated_at = now()
    where id = v_current.id;
    v_generation := v_current.generation + 1;
  else
    select coalesce(max(generation), 0) + 1
      into v_generation
    from public.ai_reset_draft_runs
    where turn_id = p_turn_id;
  end if;

  insert into public.ai_reset_draft_runs (
    id, turn_id, generation, status, origin, available_at
  ) values (
    v_new_draft_id, p_turn_id, v_generation, 'pending', 'ai', now()
  );

  update public.ai_reset_client_turns
  set status = 'queued',
      updated_at = now()
  where id = p_turn_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_draft_regeneration_requested',
    'reset_draft_run', v_new_draft_id::text,
    jsonb_build_object(
      'turnId', p_turn_id,
      'generation', v_generation,
      'automaticDeliveryAllowed', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', null,
    'draftRunId', v_new_draft_id,
    'generation', v_generation
  );
end;
$$;

revoke all on function public.ai_reset_request_regeneration(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_request_regeneration(uuid, uuid, text, text)
  to service_role;

create or replace function public.ai_reset_create_manual_candidate(
  p_actor_user_id uuid,
  p_turn_id uuid,
  p_expected_phone_ending text,
  p_message_text text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_turn public.ai_reset_client_turns%rowtype;
  v_contact public.ai_contacts%rowtype;
  v_generation integer;
  v_draft_id uuid := gen_random_uuid();
  v_hash text;
begin
  v_role := public.ai_reset_staff_role(p_actor_user_id);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_authorized');
  end if;
  if length(btrim(coalesce(p_message_text, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'code', 'message_invalid');
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = p_turn_id
    and status <> 'superseded'
  for update;
  if v_turn.id is null then
    return jsonb_build_object('ok', false, 'code', 'turn_not_current');
  end if;

  select * into v_contact from public.ai_contacts where id = v_turn.contact_id;
  if right(v_contact.wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;

  update public.ai_reset_draft_runs
  set status = 'superseded',
      locked_at = null,
      locked_by = null,
      completed_at = coalesce(completed_at, now()),
      updated_at = now()
  where turn_id = p_turn_id
    and status in ('pending', 'processing', 'ready', 'failed', 'held');

  select coalesce(max(generation), 0) + 1
    into v_generation
  from public.ai_reset_draft_runs
  where turn_id = p_turn_id;

  v_hash := pg_catalog.encode(
    extensions.digest(btrim(p_message_text), 'sha256'),
    'hex'
  );

  insert into public.ai_reset_draft_runs (
    id, turn_id, generation, status, origin, candidate_text,
    candidate_hash, reply_required, model_calls, rewrite_used,
    evidence, validation_issues, model_metadata, completed_at
  ) values (
    v_draft_id, p_turn_id, v_generation, 'ready', 'human_manual',
    btrim(p_message_text), v_hash, true, 0, false,
    '[]'::jsonb, '[]'::jsonb,
    jsonb_build_object('createdBy', p_actor_user_id), now()
  );

  update public.ai_reset_client_turns
  set status = 'ready', updated_at = now()
  where id = p_turn_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_manual_candidate_created',
    'reset_draft_run', v_draft_id::text,
    jsonb_build_object('turnId', p_turn_id, 'candidateHash', v_hash)
  );

  return jsonb_build_object(
    'ok', true,
    'code', null,
    'draftRunId', v_draft_id,
    'candidateHash', v_hash
  );
end;
$$;

revoke all on function public.ai_reset_create_manual_candidate(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_create_manual_candidate(uuid, uuid, text, text)
  to service_role;

create or replace function public.ai_reset_hold_candidate(
  p_actor_user_id uuid,
  p_draft_run_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_draft public.ai_reset_draft_runs%rowtype;
  v_turn public.ai_reset_client_turns%rowtype;
  v_wa_id text;
begin
  v_role := public.ai_reset_staff_role(p_actor_user_id);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_authorized');
  end if;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = p_draft_run_id
  for update;
  if v_draft.id is null or v_draft.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;
  if v_draft.candidate_hash is distinct from p_expected_candidate_hash then
    return jsonb_build_object('ok', false, 'code', 'candidate_changed');
  end if;

  select * into v_turn from public.ai_reset_client_turns where id = v_draft.turn_id;
  select contact.wa_id into v_wa_id
  from public.ai_contacts as contact where contact.id = v_turn.contact_id;
  if right(v_wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;

  update public.ai_reset_draft_runs
  set status = 'held', updated_at = now()
  where id = p_draft_run_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_candidate_held',
    'reset_draft_run', p_draft_run_id::text,
    jsonb_build_object('turnId', v_turn.id)
  );

  return jsonb_build_object('ok', true, 'code', null, 'state', 'held');
end;
$$;

revoke all on function public.ai_reset_hold_candidate(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_hold_candidate(uuid, uuid, text, text)
  to service_role;

create or replace function public.ai_reset_reserve_human_send(
  p_actor_user_id uuid,
  p_draft_run_id uuid,
  p_expected_turn_id uuid,
  p_expected_candidate_hash text,
  p_expected_phone_ending text,
  p_final_text text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_draft public.ai_reset_draft_runs%rowtype;
  v_turn public.ai_reset_client_turns%rowtype;
  v_contact public.ai_contacts%rowtype;
  v_existing public.ai_reset_human_sends%rowtype;
  v_send_id uuid := gen_random_uuid();
  v_final_hash text;
  v_edited boolean;
  v_latest_turn_id uuid;
begin
  v_role := public.ai_reset_staff_role(p_actor_user_id);
  if v_role is null or v_role not in (
    'owner', 'managing_director', 'salon_manager', 'receptionist', 'technical_lead'
  ) then
    return jsonb_build_object('ok', false, 'code', 'role_not_authorized');
  end if;
  if length(btrim(coalesce(p_final_text, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'code', 'message_invalid');
  end if;

  select * into v_draft
  from public.ai_reset_draft_runs
  where id = p_draft_run_id
  for update;
  if v_draft.id is null or v_draft.status <> 'ready' then
    return jsonb_build_object('ok', false, 'code', 'candidate_not_ready');
  end if;
  if v_draft.turn_id is distinct from p_expected_turn_id
     or v_draft.candidate_hash is distinct from p_expected_candidate_hash
  then
    return jsonb_build_object('ok', false, 'code', 'candidate_changed');
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = v_draft.turn_id
  for update;
  if v_turn.id is null or v_turn.status = 'superseded' then
    return jsonb_build_object('ok', false, 'code', 'turn_not_current');
  end if;

  select turn.id into v_latest_turn_id
  from public.ai_reset_client_turns as turn
  where turn.conversation_id = v_turn.conversation_id
    and turn.status <> 'superseded'
  order by turn.version desc
  limit 1;
  if v_latest_turn_id is distinct from v_turn.id then
    return jsonb_build_object('ok', false, 'code', 'newer_client_turn');
  end if;

  select * into v_contact from public.ai_contacts where id = v_turn.contact_id;
  if right(v_contact.wa_id, 4) is distinct from p_expected_phone_ending then
    return jsonb_build_object('ok', false, 'code', 'recipient_mismatch');
  end if;
  if now() - v_turn.last_fragment_at >= interval '24 hours' then
    return jsonb_build_object('ok', false, 'code', 'customer_service_window_expired');
  end if;
  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = v_turn.conversation_id
      and message.direction = 'outbound'
      and coalesce(message.provider_timestamp, message.created_at) > v_turn.last_fragment_at
  ) then
    return jsonb_build_object('ok', false, 'code', 'human_reply_already_recorded');
  end if;

  select * into v_existing
  from public.ai_reset_human_sends
  where draft_run_id = v_draft.id
  for update;
  if v_existing.id is not null and v_existing.status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'sendId', v_existing.id,
      'providerMessageId', v_existing.provider_message_id
    );
  end if;
  if v_existing.id is not null
     and v_existing.status = 'reserved'
     and v_existing.reserved_at > now() - interval '2 minutes'
  then
    return jsonb_build_object(
      'ok', false,
      'state', 'already_sending',
      'code', 'send_already_in_progress'
    );
  end if;

  v_final_hash := pg_catalog.encode(
    extensions.digest(btrim(p_final_text), 'sha256'),
    'hex'
  );
  v_edited := v_final_hash is distinct from v_draft.candidate_hash;

  if v_existing.id is null then
    insert into public.ai_reset_human_sends (
      id, draft_run_id, turn_id, conversation_id, actor_user_id,
      to_wa_id, expected_phone_ending, candidate_hash,
      final_text, final_hash, edited_by_human, status, attempts
    ) values (
      v_send_id, v_draft.id, v_turn.id, v_turn.conversation_id,
      p_actor_user_id, v_contact.wa_id, p_expected_phone_ending,
      v_draft.candidate_hash, btrim(p_final_text), v_final_hash,
      v_edited, 'reserved', 1
    );
  else
    v_send_id := v_existing.id;
    update public.ai_reset_human_sends
    set actor_user_id = p_actor_user_id,
        final_text = btrim(p_final_text),
        final_hash = v_final_hash,
        edited_by_human = v_edited,
        status = 'reserved',
        attempts = least(attempts + 1, 3),
        provider_message_id = null,
        failure_code = null,
        reserved_at = now(),
        sent_at = null,
        failed_at = null,
        updated_at = now()
    where id = v_send_id;
  end if;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_human_send_reserved',
    'reset_human_send', v_send_id::text,
    jsonb_build_object(
      'draftRunId', v_draft.id,
      'turnId', v_turn.id,
      'candidateHash', v_draft.candidate_hash,
      'finalHash', v_final_hash,
      'editedByHuman', v_edited,
      'phoneEnding', p_expected_phone_ending,
      'channel', 'Tanglin Mall WhatsApp'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'send_reserved',
    'code', null,
    'sendId', v_send_id,
    'draftRunId', v_draft.id,
    'turnId', v_turn.id,
    'conversationId', v_turn.conversation_id,
    'toWaId', v_contact.wa_id,
    'phoneEnding', p_expected_phone_ending,
    'candidateHash', v_draft.candidate_hash,
    'finalHash', v_final_hash,
    'messageText', btrim(p_final_text),
    'editedByHuman', v_edited
  );
end;
$$;

revoke all on function public.ai_reset_reserve_human_send(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.ai_reset_reserve_human_send(
  uuid, uuid, uuid, text, text, text
) to service_role;

create or replace function public.ai_reset_complete_human_send(
  p_actor_user_id uuid,
  p_send_id uuid,
  p_provider_message_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_send public.ai_reset_human_sends%rowtype;
  v_turn public.ai_reset_client_turns%rowtype;
  v_contact_id uuid;
  v_message_id uuid;
begin
  if length(btrim(coalesce(p_provider_message_id, ''))) < 1 then
    raise exception 'provider message id is required' using errcode = '22023';
  end if;

  select * into v_send
  from public.ai_reset_human_sends
  where id = p_send_id
  for update;
  if v_send.id is null then
    return jsonb_build_object('ok', false, 'code', 'send_not_found');
  end if;
  if v_send.actor_user_id is distinct from p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'actor_mismatch');
  end if;
  if v_send.status = 'sent' then
    return jsonb_build_object(
      'ok', true,
      'state', 'already_sent',
      'providerMessageId', v_send.provider_message_id
    );
  end if;
  if v_send.status <> 'reserved' then
    return jsonb_build_object('ok', false, 'code', 'send_not_reserved');
  end if;

  select * into v_turn
  from public.ai_reset_client_turns
  where id = v_send.turn_id;
  select conversation.contact_id into v_contact_id
  from public.ai_conversations as conversation
  where conversation.id = v_send.conversation_id;

  insert into public.ai_messages (
    conversation_id, contact_id, provider_message_id, direction,
    kind, text_body, media, context_message_id, raw_payload,
    ai_generated, delivery_status, provider_timestamp
  ) values (
    v_send.conversation_id, v_contact_id, p_provider_message_id,
    'outbound', 'text', v_send.final_text, null, null,
    jsonb_build_object(
      'source', 'hera_reset_human_approved_send',
      'sendId', v_send.id,
      'draftRunId', v_send.draft_run_id,
      'editedByHuman', v_send.edited_by_human
    ),
    true, 'sent', now()
  )
  on conflict (provider_message_id)
    where provider_message_id is not null
  do update set updated_at = now()
  returning id into v_message_id;

  update public.ai_reset_human_sends
  set status = 'sent',
      provider_message_id = p_provider_message_id,
      sent_at = now(),
      failure_code = null,
      updated_at = now()
  where id = p_send_id;

  update public.ai_reset_draft_runs
  set status = 'sent', updated_at = now()
  where id = v_send.draft_run_id;

  update public.ai_conversations
  set last_message_at = now(), updated_at = now()
  where id = v_send.conversation_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_human_send_completed',
    'reset_human_send', p_send_id::text,
    jsonb_build_object(
      'providerMessageId', p_provider_message_id,
      'outboundMessageId', v_message_id,
      'draftRunId', v_send.draft_run_id,
      'turnId', v_send.turn_id,
      'editedByHuman', v_send.edited_by_human,
      'channel', 'Tanglin Mall WhatsApp'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'sent',
    'providerMessageId', p_provider_message_id,
    'outboundMessageId', v_message_id
  );
end;
$$;

revoke all on function public.ai_reset_complete_human_send(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_complete_human_send(uuid, uuid, text)
  to service_role;

create or replace function public.ai_reset_fail_human_send(
  p_actor_user_id uuid,
  p_send_id uuid,
  p_failure_code text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_send public.ai_reset_human_sends%rowtype;
begin
  select * into v_send
  from public.ai_reset_human_sends
  where id = p_send_id
  for update;
  if v_send.id is null then
    return jsonb_build_object('ok', false, 'code', 'send_not_found');
  end if;
  if v_send.actor_user_id is distinct from p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'actor_mismatch');
  end if;
  if v_send.status = 'sent' then
    return jsonb_build_object('ok', true, 'state', 'already_sent');
  end if;

  update public.ai_reset_human_sends
  set status = 'failed',
      provider_message_id = null,
      failure_code = left(btrim(coalesce(p_failure_code, 'provider_send_failed')), 120),
      failed_at = now(),
      updated_at = now()
  where id = p_send_id;

  insert into public.ai_audit_log (
    actor_type, actor_id, event_type, target_type, target_id, details
  ) values (
    'human', p_actor_user_id::text, 'reset_human_send_failed',
    'reset_human_send', p_send_id::text,
    jsonb_build_object('failureCode', left(btrim(coalesce(p_failure_code, 'provider_send_failed')), 120))
  );

  return jsonb_build_object('ok', true, 'state', 'failed');
end;
$$;

revoke all on function public.ai_reset_fail_human_send(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ai_reset_fail_human_send(uuid, uuid, text)
  to service_role;

commit;
