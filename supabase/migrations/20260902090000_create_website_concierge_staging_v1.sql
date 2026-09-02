begin;

create table if not exists public.ai_website_concierge_sessions_v1 (
  id uuid primary key,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'expired', 'blocked')),
  outlet_preference text not null default 'unspecified'
    check (outlet_preference in ('unspecified', 'tanglin', 'sentosa', 'either')),
  message_count integer not null default 0
    check (message_count between 0 and 40),
  total_input_characters integer not null default 0
    check (total_input_characters between 0 and 30000),
  rate_window_started_at timestamptz not null default now(),
  rate_window_count integer not null default 0
    check (rate_window_count between 0 and 6),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (created_at <= expires_at)
);

create table if not exists public.ai_website_concierge_messages_v1 (
  id uuid primary key,
  session_id uuid not null
    references public.ai_website_concierge_sessions_v1(id) on delete cascade,
  reply_to_message_id uuid
    references public.ai_website_concierge_messages_v1(id) on delete set null,
  role text not null check (role in ('visitor', 'concierge')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  intent text,
  outlet_context text not null default 'unspecified'
    check (outlet_context in ('unspecified', 'tanglin', 'sentosa', 'either')),
  evidence jsonb not null default '{}'::jsonb,
  validation jsonb not null default '{}'::jsonb,
  model_id text,
  model_attempts integer check (model_attempts is null or model_attempts between 1 and 2),
  latency_ms integer check (latency_ms is null or latency_ms between 0 and 600000),
  created_at timestamptz not null default now(),
  check (
    (role = 'visitor' and model_id is null and model_attempts is null)
    or (role = 'concierge' and model_id is not null and model_attempts is not null)
  )
);

create index if not exists ai_website_concierge_messages_session_idx
  on public.ai_website_concierge_messages_v1(session_id, created_at desc);
create index if not exists ai_website_concierge_sessions_expiry_idx
  on public.ai_website_concierge_sessions_v1(status, expires_at);

alter table public.ai_website_concierge_sessions_v1 enable row level security;
alter table public.ai_website_concierge_sessions_v1 force row level security;
alter table public.ai_website_concierge_messages_v1 enable row level security;
alter table public.ai_website_concierge_messages_v1 force row level security;

revoke all on public.ai_website_concierge_sessions_v1 from public, anon, authenticated;
revoke all on public.ai_website_concierge_messages_v1 from public, anon, authenticated;
grant all on public.ai_website_concierge_sessions_v1 to service_role;
grant all on public.ai_website_concierge_messages_v1 to service_role;

create or replace function public.ai_consume_website_concierge_quota_v1(
  p_session_id uuid,
  p_token_hash text,
  p_input_chars integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.ai_website_concierge_sessions_v1%rowtype;
  v_window_count integer;
  v_window_started timestamptz;
begin
  if p_input_chars < 1 or p_input_chars > 2000 then
    return jsonb_build_object('ok', false, 'code', 'invalid_message_length');
  end if;

  select * into v_session
  from public.ai_website_concierge_sessions_v1
  where id = p_session_id
  for update;

  if not found
     or v_session.status <> 'active'
     or v_session.token_hash <> p_token_hash
     or v_session.expires_at <= now()
  then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;

  if v_session.message_count >= 40
     or v_session.total_input_characters + p_input_chars > 30000
  then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  if v_session.rate_window_started_at < now() - interval '1 minute' then
    v_window_started := now();
    v_window_count := 0;
  else
    v_window_started := v_session.rate_window_started_at;
    v_window_count := v_session.rate_window_count;
  end if;

  if v_window_count >= 6 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  update public.ai_website_concierge_sessions_v1
  set message_count = message_count + 1,
      total_input_characters = total_input_characters + p_input_chars,
      rate_window_started_at = v_window_started,
      rate_window_count = v_window_count + 1,
      last_seen_at = now()
  where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'outletPreference', v_session.outlet_preference,
    'remainingMessages', 39 - v_session.message_count
  );
end;
$$;

revoke all on function public.ai_consume_website_concierge_quota_v1(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.ai_consume_website_concierge_quota_v1(uuid, text, integer)
  to service_role;

commit;
