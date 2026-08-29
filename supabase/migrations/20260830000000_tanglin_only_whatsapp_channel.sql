begin;

create or replace function public.ai_tanglin_whatsapp_reply_violation(
  p_text text
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text := coalesce(p_text, '');
begin
  if length(btrim(v_text)) < 1 then
    return 'candidate_text_missing';
  end if;

  if v_text ~* '(which|what)[[:space:]]+(hera[[:space:]]+)?(outlet|atelier)'
     or v_text ~* '(outlet|atelier).{0,40}(do you prefer|would you prefer|you prefer|did you visit|you visited|are you at|suits you|would suit)'
     or v_text ~* '(tanglin mall).{0,80}(sentosa|quayside)'
     or v_text ~* '(sentosa|quayside).{0,80}(tanglin mall)'
  then
    return 'tanglin_channel_outlet_already_known';
  end if;

  if v_text ~* '((at|to|from|our)[[:space:]]+(the[[:space:]]+)?(sentosa([[:space:]]+cove)?|quayside([[:space:]]+isle)?)[[:space:]]+(salon|outlet|atelier|team|reception))'
     or v_text ~* '(sentosa([[:space:]]+cove)?|quayside([[:space:]]+isle)?).{0,50}(appointment|booking|availability|reception team|salon manager)'
  then
    return 'tanglin_channel_sentosa_routing';
  end if;

  return null;
end;
$$;

revoke all on function public.ai_tanglin_whatsapp_reply_violation(text)
  from public, anon, authenticated;
grant execute on function public.ai_tanglin_whatsapp_reply_violation(text)
  to service_role;

create or replace function public.ai_enforce_tanglin_human_approved_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_violation text;
begin
  if new.target_type = 'client'
     and new.send_authorization = 'management'
     and (
       new.dedupe_key like 'human-receptionist:%'
       or new.dedupe_key like 'human-approved:%'
     )
  then
    v_violation := public.ai_tanglin_whatsapp_reply_violation(
      new.body->>'text'
    );
    if v_violation is not null then
      raise exception
        'Tanglin Mall WhatsApp reply violates channel scope: %',
        v_violation
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists ai_enforce_tanglin_human_approved_reply
  on public.ai_outbox;
create trigger ai_enforce_tanglin_human_approved_reply
before insert or update of body, target_type, send_authorization, dedupe_key
on public.ai_outbox
for each row
execute function public.ai_enforce_tanglin_human_approved_reply();

do $$
declare
  v_document_key text := 'owner-authority:tanglin-whatsapp-channel:v1';
  v_version text := 'tanglin-whatsapp-channel-v1-2026-08-30';
  v_body text := 'OWNER-APPROVED TANGLIN MALL WHATSAPP CHANNEL RULE. The WhatsApp number connected to Hera Reception Desk is exclusively for Hera Hair Beauty at Tanglin Mall. Every inbound client message on this number must be handled as a Tanglin Mall conversation. Tanglin Mall is already verified by the communication channel, so the AI and receptionist must never ask which outlet or atelier the client visited or prefers, must never offer Tanglin Mall versus Sentosa, and must never route the client response to Sentosa Cove or Quayside Isle. When an outlet fact or task assignment is required, use Tanglin Mall without making the client repeat it. A client may ask a general informational question about Sentosa, but that does not change ownership of this Tanglin Mall WhatsApp conversation. Live appointment availability, booking changes and cancellations still require Timely verification; only the outlet is already known.';
begin
  insert into public.ai_knowledge_documents (
    document_key,
    title,
    body,
    source_url,
    version,
    checksum,
    status,
    valid_from,
    valid_until,
    metadata
  ) values (
    v_document_key,
    'Hera owner-approved Tanglin Mall WhatsApp channel scope',
    v_body,
    null,
    v_version,
    pg_catalog.encode(extensions.digest(v_body, 'sha256'), 'hex'),
    'approved',
    now(),
    null,
    jsonb_build_object(
      'sourceType', 'owner_approved_operational_rule',
      'documentClass', 'channel_routing',
      'runtimeAuthoritative', true,
      'ownerApproved', true,
      'approvedBy', 'Neo Chin Chuan',
      'channel', 'Tanglin Mall WhatsApp',
      'outlet', 'Tanglin Mall',
      'sentosaInboundExpected', false,
      'stagingOnly', true,
      'productionApproved', false
    )
  )
  on conflict (document_key) do update
    set title = excluded.title,
        body = excluded.body,
        version = excluded.version,
        checksum = excluded.checksum,
        status = excluded.status,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        metadata = excluded.metadata,
        updated_at = now();

  insert into public.ai_knowledge_claim_registry (
    claim_key,
    domain,
    canonical_value,
    authority_document_key,
    authority_version,
    source_class,
    precedence_rank,
    client_claim_allowed,
    outcome_promise_allowed,
    status,
    effective_from,
    effective_until
  ) values (
    'tanglin_whatsapp_channel_scope',
    'channel_routing',
    jsonb_build_object(
      'channel', 'Tanglin Mall WhatsApp',
      'outlet', 'Tanglin Mall',
      'askOutlet', false,
      'offerSentosaChoice', false,
      'routeToSentosa', false,
      'sentosaInboundExpected', false
    ),
    v_document_key,
    v_version,
    'owner_approved_operational_rule',
    100,
    true,
    false,
    'approved',
    now(),
    null
  )
  on conflict (claim_key) do update
    set domain = excluded.domain,
        canonical_value = excluded.canonical_value,
        authority_document_key = excluded.authority_document_key,
        authority_version = excluded.authority_version,
        source_class = excluded.source_class,
        precedence_rank = excluded.precedence_rank,
        client_claim_allowed = excluded.client_claim_allowed,
        outcome_promise_allowed = excluded.outcome_promise_allowed,
        status = excluded.status,
        effective_from = excluded.effective_from,
        effective_until = excluded.effective_until,
        updated_at = now();
end;
$$;

update public.ai_handoff_tasks
set assigned_outlet = 'Tanglin Mall',
    collected_facts = jsonb_set(
      coalesce(collected_facts, '{}'::jsonb),
      '{outlet}',
      to_jsonb('Tanglin Mall'::text),
      true
    ),
    missing_facts = coalesce(missing_facts, '[]'::jsonb) - 'outlet',
    version = version + 1,
    updated_at = now()
where status in ('new', 'assigned', 'accepted', 'waiting_client', 'waiting_internal')
  and (
    assigned_outlet is distinct from 'Tanglin Mall'
    or collected_facts->>'outlet' is distinct from 'Tanglin Mall'
    or coalesce(missing_facts, '[]'::jsonb) ? 'outlet'
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
  'owner_authority',
  'tanglin_whatsapp_channel_scope_recorded',
  'knowledge_document',
  'owner-authority:tanglin-whatsapp-channel:v1',
  jsonb_build_object(
    'approvedBy', 'Neo Chin Chuan',
    'channel', 'Tanglin Mall WhatsApp',
    'outlet', 'Tanglin Mall',
    'sentosaInboundExpected', false,
    'askOutlet', false,
    'outboundGuardInstalled', true
  )
);

commit;
