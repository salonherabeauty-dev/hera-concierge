begin;

create or replace function public.ai_reply_mentions_known_service_context(
  p_reply text,
  p_service text
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reply text := lower(coalesce(p_reply, ''));
  v_service text := lower(coalesce(p_service, ''));
  v_term text;
  v_terms text[] := array[
    'balayage',
    'colour correction',
    'color correction',
    'curl cut',
    'curly haircut',
    'haircut',
    'bond repair',
    'toner',
    'gloss',
    'highlight',
    'keratin',
    'rebonding',
    'perm',
    'extension',
    'smoothing',
    'treatment'
  ];
begin
  if length(btrim(v_reply)) < 1 or length(btrim(v_service)) < 1 then
    return false;
  end if;

  foreach v_term in array v_terms loop
    if strpos(v_service, v_term) > 0 and strpos(v_reply, v_term) > 0 then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

revoke all on function public.ai_reply_mentions_known_service_context(text, text)
  from public, anon, authenticated;
grant execute on function public.ai_reply_mentions_known_service_context(text, text)
  to service_role;

create or replace function public.ai_reconcile_verified_complaint_quality()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_issues jsonb;
  v_reply text;
  v_service text;
begin
  if new.stage <> 'policy' then
    return new;
  end if;

  if coalesce(new.output->'finalVerification'->>'approved', 'false') <> 'true'
     or coalesce(new.output->'finalQuality'->>'passed', 'false') <> 'false'
     or coalesce(new.output->'handoff'->>'taskType', '') <> 'complaint_review'
  then
    return new;
  end if;

  v_issues := new.output->'finalQuality'->'issues';
  if jsonb_typeof(v_issues) <> 'array'
     or jsonb_array_length(v_issues) <> 1
     or v_issues->>0 <> 'The complaint reply omits the known service context.'
  then
    return new;
  end if;

  v_reply := btrim(coalesce(new.output->>'finalReply', ''));
  v_service := coalesce(
    new.output->'handoff'->'collectedFacts'->>'service',
    ''
  );

  if length(v_reply) < 1
     or length(v_reply) > 4000
     or not public.ai_reply_mentions_known_service_context(v_reply, v_service)
     or public.ai_tanglin_whatsapp_reply_violation(v_reply) is not null
  then
    return new;
  end if;

  new.output := jsonb_set(
    new.output,
    '{finalQuality,checks,specificity}',
    'true'::jsonb,
    true
  );
  new.output := jsonb_set(
    new.output,
    '{finalQuality,issues}',
    '[]'::jsonb,
    true
  );
  new.output := jsonb_set(
    new.output,
    '{finalQuality,passed}',
    'true'::jsonb,
    true
  );
  new.output := jsonb_set(
    new.output,
    '{deliveryEligible}',
    'true'::jsonb,
    true
  );
  new.output := new.output || jsonb_build_object(
    'deterministicReconciliation',
    jsonb_build_object(
      'version', 'verified-complaint-service-context-v1',
      'reason', 'specific_service_context_present_in_final_reply',
      'finalVerifierApproved', true,
      'automaticDeliveryAllowed', false
    )
  );
  new.confidence := greatest(new.confidence, 0.70);

  return new;
end;
$$;

revoke all on function public.ai_reconcile_verified_complaint_quality()
  from public, anon, authenticated;
grant execute on function public.ai_reconcile_verified_complaint_quality()
  to service_role;

drop trigger if exists ai_reconcile_verified_complaint_quality
  on public.ai_decisions;
create trigger ai_reconcile_verified_complaint_quality
before insert or update of output
on public.ai_decisions
for each row
execute function public.ai_reconcile_verified_complaint_quality();

create or replace function public.ai_persist_reconciled_complaint_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reply text;
  v_wa_id text;
  v_latest_inbound_id uuid;
  v_source_effective_at timestamptz;
  v_source_created_at timestamptz;
  v_inserted integer := 0;
begin
  if new.stage <> 'policy'
     or coalesce(new.output->>'deliveryEligible', 'false') <> 'true'
     or coalesce(
       new.output->'deterministicReconciliation'->>'version',
       ''
     ) <> 'verified-complaint-service-context-v1'
  then
    return null;
  end if;

  v_reply := btrim(coalesce(new.output->>'finalReply', ''));
  if length(v_reply) < 1 or length(v_reply) > 4000 then
    return null;
  end if;

  select
    contact.wa_id,
    coalesce(source.provider_timestamp, source.created_at),
    source.created_at
  into
    v_wa_id,
    v_source_effective_at,
    v_source_created_at
  from public.ai_messages as source
  join public.ai_conversations as conversation
    on conversation.id = source.conversation_id
  join public.ai_contacts as contact
    on contact.id = conversation.contact_id
  where source.id = new.source_message_id
    and source.conversation_id = new.conversation_id
    and source.direction = 'inbound'
    and conversation.status = 'active';

  if v_wa_id is null
     or now() - v_source_effective_at >= interval '24 hours'
  then
    return null;
  end if;

  select message.id into v_latest_inbound_id
  from public.ai_messages as message
  where message.conversation_id = new.conversation_id
    and message.direction = 'inbound'
  order by
    coalesce(message.provider_timestamp, message.created_at) desc,
    message.created_at desc,
    message.id desc
  limit 1;

  if v_latest_inbound_id is distinct from new.source_message_id then
    return null;
  end if;

  if exists (
    select 1
    from public.ai_messages as message
    where message.conversation_id = new.conversation_id
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
    return null;
  end if;

  insert into public.ai_outbox (
    conversation_id,
    source_message_id,
    to_wa_id,
    target_type,
    message_type,
    body,
    dedupe_key,
    send_authorization,
    status,
    attempts,
    max_attempts,
    available_at,
    last_error
  ) values (
    new.conversation_id,
    new.source_message_id,
    v_wa_id,
    'client',
    'text',
    jsonb_build_object('text', v_reply),
    'client-reply:' || new.source_message_id::text,
    'auto',
    'shadowed',
    0,
    8,
    now(),
    'reconciled_verified_complaint_service_context'
  )
  on conflict (dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted > 0 then
    insert into public.ai_audit_log (
      actor_type,
      actor_id,
      event_type,
      target_type,
      target_id,
      details
    ) values (
      'system',
      'final_quality_reconciliation',
      'verified_complaint_draft_recovered',
      'message',
      new.source_message_id::text,
      jsonb_build_object(
        'conversationId', new.conversation_id,
        'policyDecisionId', new.id,
        'reconciliationVersion',
          'verified-complaint-service-context-v1',
        'status', 'shadowed',
        'automaticDeliveryAllowed', false
      )
    );
  end if;

  return null;
end;
$$;

revoke all on function public.ai_persist_reconciled_complaint_candidate()
  from public, anon, authenticated;
grant execute on function public.ai_persist_reconciled_complaint_candidate()
  to service_role;

drop trigger if exists ai_persist_reconciled_complaint_candidate
  on public.ai_decisions;
create trigger ai_persist_reconciled_complaint_candidate
after insert or update of output
on public.ai_decisions
for each row
execute function public.ai_persist_reconciled_complaint_candidate();

create or replace function public.ai_settle_inbound_message_burst()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'process_inbound'
     and new.dedupe_key like 'inbound:%'
  then
    new.available_at := greatest(
      coalesce(new.available_at, now()),
      now() + interval '8 seconds'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists ai_settle_inbound_message_burst
  on public.ai_jobs;
create trigger ai_settle_inbound_message_burst
before insert
on public.ai_jobs
for each row
execute function public.ai_settle_inbound_message_burst();

update public.ai_decisions
set output = output
where stage = 'policy'
  and created_at >= now() - interval '7 days';

commit;
