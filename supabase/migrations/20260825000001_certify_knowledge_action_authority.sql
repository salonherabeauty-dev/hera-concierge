begin;

create table if not exists public.ai_action_authority_contracts (
  action_key text primary key check (length(trim(action_key)) between 3 and 120),
  domain text not null check (length(trim(domain)) between 2 and 80),
  authority text not null check (authority in (
    'read_only',
    'ai_authorised_no_external_side_effect',
    'human_required',
    'prohibited'
  )),
  responsible_role text,
  task_type text,
  scope text check (scope is null or scope in ('task_only', 'full_takeover', 'emergency')),
  required_evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(required_evidence) = 'array'),
  allowed_claims jsonb not null default '[]'::jsonb
    check (jsonb_typeof(allowed_claims) = 'array'),
  prohibited_claims jsonb not null default '[]'::jsonb
    check (jsonb_typeof(prohibited_claims) = 'array'),
  external_mutation boolean not null default false,
  idempotency_required boolean not null default false,
  provider_confirmation_required boolean not null default false,
  before_after_audit_required boolean not null default false,
  reconciliation_required boolean not null default false,
  status text not null default 'approved' check (status in ('draft', 'approved', 'retired')),
  version text not null,
  constitution_version text not null,
  effective_from timestamptz not null,
  effective_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    authority <> 'human_required'
    or (responsible_role is not null and task_type is not null)
  ),
  check (
    not external_mutation
    or (
      idempotency_required
      and provider_confirmation_required
      and before_after_audit_required
      and reconciliation_required
    )
  )
);

create index if not exists ai_action_authority_status_idx
  on public.ai_action_authority_contracts(status, authority, domain);

create table if not exists public.ai_knowledge_claim_registry (
  claim_key text primary key check (length(trim(claim_key)) between 3 and 120),
  domain text not null check (length(trim(domain)) between 2 and 80),
  canonical_value jsonb not null,
  authority_document_key text not null,
  authority_version text not null,
  source_class text not null,
  precedence_rank integer not null check (precedence_rank between 1 and 100),
  client_claim_allowed boolean not null default true,
  outcome_promise_allowed boolean not null default false,
  status text not null default 'approved' check (status in ('draft', 'approved', 'retired')),
  effective_from timestamptz not null,
  effective_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_knowledge_claim_status_idx
  on public.ai_knowledge_claim_registry(status, domain, precedence_rank);

alter table public.ai_action_authority_contracts enable row level security;
alter table public.ai_action_authority_contracts force row level security;
alter table public.ai_knowledge_claim_registry enable row level security;
alter table public.ai_knowledge_claim_registry force row level security;

revoke all on table public.ai_action_authority_contracts from public, anon, authenticated;
revoke all on table public.ai_knowledge_claim_registry from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_action_authority_contracts to service_role;
grant select, insert, update, delete on table public.ai_knowledge_claim_registry to service_role;

insert into public.ai_action_authority_contracts (
  action_key,
  domain,
  authority,
  responsible_role,
  task_type,
  scope,
  required_evidence,
  allowed_claims,
  prohibited_claims,
  external_mutation,
  idempotency_required,
  provider_confirmation_required,
  before_after_audit_required,
  reconciliation_required,
  status,
  version,
  constitution_version,
  effective_from,
  effective_until
) values
  (
    'answer_approved_service_information', 'service_information',
    'ai_authorised_no_external_side_effect', null, null, null,
    '["approved_current_source","final_response_quality_pass"]'::jsonb,
    '["grounded_service_fact"]'::jsonb,
    '["invented_hera_fact","unverified_live_availability"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'calculate_nine_percent_gst', 'pricing',
    'ai_authorised_no_external_side_effect', null, null, null,
    '["approved_base_price","deterministic_calculation"]'::jsonb,
    '["calculated_gst_amount","calculated_gst_inclusive_amount"]'::jsonb,
    '["final_service_quote_without_consultation"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'read_current_client_booking_record', 'booking',
    'read_only', null, null, null,
    '["current_client_identity_scope","authorised_booking_record"]'::jsonb,
    '["verified_existing_booking_details"]'::jsonb,
    '["another_clients_booking","inferred_or_stale_booking_state"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'quote_live_availability', 'booking',
    'human_required', 'receptionist', 'booking_action', 'task_only',
    '["verified_live_timely_record"]'::jsonb,
    '["verified_available_option"]'::jsonb,
    '["invented_slot","unverified_stylist_schedule"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'create_booking', 'booking',
    'human_required', 'receptionist', 'booking_action', 'task_only',
    '["complete_client_request","timely_success_or_authorised_human_outcome"]'::jsonb,
    '["request_received","verified_booking_confirmation_after_success"]'::jsonb,
    '["booking_confirmed_before_success"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'reschedule_booking', 'booking',
    'human_required', 'receptionist', 'appointment_change', 'task_only',
    '["verified_existing_booking","requested_new_option","timely_success_or_authorised_human_outcome"]'::jsonb,
    '["change_request_received","verified_reschedule_confirmation_after_success"]'::jsonb,
    '["rescheduled_before_success"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'cancel_booking', 'booking',
    'human_required', 'receptionist', 'appointment_change', 'task_only',
    '["verified_existing_booking","client_cancellation_request","timely_success_or_authorised_human_outcome"]'::jsonb,
    '["cancellation_request_received","verified_cancellation_confirmation_after_success"]'::jsonb,
    '["cancelled_before_success"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'confirm_booking_outcome', 'booking',
    'human_required', 'receptionist', 'booking_action', 'task_only',
    '["timely_success_or_authorised_human_outcome"]'::jsonb,
    '["verified_booking_outcome"]'::jsonb,
    '["confirmation_from_client_request_alone"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'complaint_review', 'service_recovery',
    'human_required', 'salon_manager', 'complaint_review', 'full_takeover',
    '["client_concern","service_context","authorised_review"]'::jsonb,
    '["manager_review_arranged","review_process_explained"]'::jsonb,
    '["liability_admission","automatic_refund","automatic_redo","blame_assignment"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'authorise_policy_refinement', 'service_recovery',
    'human_required', 'salon_manager', 'complaint_review', 'full_takeover',
    '["within_seven_calendar_days","original_service_relationship_confirmed","safe_correction_confirmed"]'::jsonb,
    '["authorised_complimentary_refinement"]'::jsonb,
    '["automatic_eligibility","completely_different_result","entirely_new_service"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'authorise_outside_policy_exception', 'service_recovery',
    'human_required', 'managing_director_or_owner', 'complaint_review', 'full_takeover',
    '["documented_exception_reason","senior_approval"]'::jsonb,
    '["verified_exception_outcome"]'::jsonb,
    '["predicted_exception_approval"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'apply_waiting_time_recovery', 'service_recovery',
    'human_required', 'salon_manager', 'complaint_review', 'task_only',
    '["wait_exceeded_ten_minutes_beyond_agreed_time","transaction_record_or_manager_confirmation"]'::jsonb,
    '["policy_explanation","verified_discount_application"]'::jsonb,
    '["discount_applied_without_transaction_evidence"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'approve_refund', 'finance',
    'human_required', 'managing_director_or_owner', 'refund_finance', 'full_takeover',
    '["case_review","senior_approval","transaction_confirmation"]'::jsonb,
    '["verified_refund_decision","verified_refund_completion"]'::jsonb,
    '["refund_promised_by_ai","refund_promised_by_receptionist"]'::jsonb,
    true, true, true, true, true, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'approve_voucher', 'finance',
    'human_required', 'managing_director_or_owner', 'refund_finance', 'full_takeover',
    '["case_review","senior_approval","voucher_record"]'::jsonb,
    '["verified_voucher_decision"]'::jsonb,
    '["voucher_promised_without_approval"]'::jsonb,
    true, true, true, true, true, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'approve_compensation', 'finance',
    'human_required', 'managing_director_or_owner', 'refund_finance', 'full_takeover',
    '["case_review","senior_approval","transaction_confirmation"]'::jsonb,
    '["verified_compensation_decision"]'::jsonb,
    '["compensation_promised_without_approval"]'::jsonb,
    true, true, true, true, true, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'provide_urgent_safety_containment', 'medical_safety',
    'ai_authorised_no_external_side_effect', 'salon_manager', 'medical_safety', 'emergency',
    '["deterministic_symptom_trigger"]'::jsonb,
    '["urgent_medical_attention_guidance","stop_service_or_product_guidance","hera_follow_up_arranged"]'::jsonb,
    '["medical_diagnosis","guaranteed_safety","delay_urgent_care"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'diagnose_medical_condition', 'medical_safety',
    'prohibited', null, 'medical_safety', 'emergency',
    '[]'::jsonb, '[]'::jsonb,
    '["diagnosis","prescription","medical_clearance"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'determine_technical_damage_or_fault', 'technical_review',
    'human_required', 'technical_lead_or_salon_manager', 'technical_review', 'full_takeover',
    '["service_records","hair_or_scalp_evidence","qualified_review"]'::jsonb,
    '["verified_technical_findings"]'::jsonb,
    '["ai_damage_diagnosis","fault_assignment_before_review"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'admit_legal_liability', 'legal',
    'prohibited', null, 'privacy_legal', 'full_takeover',
    '[]'::jsonb, '[]'::jsonb,
    '["liability_admission","legal_conclusion"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'process_privacy_access_request', 'privacy',
    'human_required', 'privacy_officer', 'privacy_legal', 'full_takeover',
    '["identity_verification","request_scope","approved_response_record"]'::jsonb,
    '["request_received","verified_completion"]'::jsonb,
    '["completed_without_verified_record","another_clients_data"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'process_privacy_deletion_request', 'privacy',
    'human_required', 'privacy_officer', 'privacy_legal', 'full_takeover',
    '["identity_verification","retention_and_legal_review","verified_action_record"]'::jsonb,
    '["request_received","verified_completion_or_lawful_limitation"]'::jsonb,
    '["deletion_completed_without_record"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'record_media_capture_consent', 'privacy',
    'human_required', 'privacy_officer_or_authorised_staff', 'consent_media', 'task_only',
    '["explicit_capture_consent","approved_consent_record"]'::jsonb,
    '["verified_capture_consent_status"]'::jsonb,
    '["consent_assumed_from_attendance"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'record_media_publication_consent', 'privacy',
    'human_required', 'privacy_officer_or_authorised_staff', 'consent_media', 'task_only',
    '["separate_explicit_publication_consent","approved_consent_record"]'::jsonb,
    '["verified_publication_consent_status"]'::jsonb,
    '["capture_consent_treated_as_publication_consent"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'withdraw_media_consent', 'privacy',
    'human_required', 'privacy_officer', 'consent_media', 'full_takeover',
    '["verified_withdrawal_request","future_use_block","published_material_review_if_applicable"]'::jsonb,
    '["request_received","verified_future_use_block","verified_review_outcome"]'::jsonb,
    '["all_published_material_removed_without_verification"]'::jsonb,
    false, false, false, false, false, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  ),
  (
    'send_ai_generated_whatsapp_reply', 'messaging',
    'prohibited', null, null, null,
    '["all_required_gates_passed","immutable_release_approved","healthy_readiness","live_send_mode","independent_live_confirmation","chronology_guard","human_takeover_guard","final_quality_pass"]'::jsonb,
    '[]'::jsonb,
    '["provider_send_while_shadow_or_gate_open"]'::jsonb,
    true, true, true, true, true, 'approved',
    'hera-action-authority-2026-08-25.1',
    'hera-service-constitution-2026-08-25.1',
    '2026-08-25T00:00:00+08:00', null
  )
on conflict (action_key) do update
set domain = excluded.domain,
    authority = excluded.authority,
    responsible_role = excluded.responsible_role,
    task_type = excluded.task_type,
    scope = excluded.scope,
    required_evidence = excluded.required_evidence,
    allowed_claims = excluded.allowed_claims,
    prohibited_claims = excluded.prohibited_claims,
    external_mutation = excluded.external_mutation,
    idempotency_required = excluded.idempotency_required,
    provider_confirmation_required = excluded.provider_confirmation_required,
    before_after_audit_required = excluded.before_after_audit_required,
    reconciliation_required = excluded.reconciliation_required,
    status = excluded.status,
    version = excluded.version,
    constitution_version = excluded.constitution_version,
    effective_from = excluded.effective_from,
    effective_until = excluded.effective_until,
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
) values
  ('service_concern_window', 'service_recovery',
   '{"value":"seven_calendar_days_from_appointment_completion"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('conditional_complimentary_refinement', 'service_recovery',
   '{"value":"manager_review_original_service_and_safe_correction_required"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('booking_source_of_truth', 'booking',
   '{"value":"Timely"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('live_availability', 'booking',
   '{"value":"requires_verified_live_record"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('waiting_time_recovery', 'service_recovery',
   '{"value":"ten_percent_after_more_than_ten_minutes_beyond_agreed_time"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('published_price_gst', 'pricing',
   '{"value":"published_prices_before_nine_percent_gst_unless_explicitly_stated"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('failed_strand_test', 'chemical_safety',
   '{"value":"no_bleach"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('financial_authority', 'finance',
   '{"value":"no_ai_or_receptionist_refund_or_compensation_authority"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null),
  ('media_consent', 'privacy',
   '{"value":"separate_explicit_capture_and_external_use_consent"}'::jsonb,
   'hera-service-constitution-2026-08-25.1', 'hera-service-constitution-2026-08-25.1',
   'approved_service_constitution', 2, true, false, 'approved',
   '2026-08-25T00:00:00+08:00', null)
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

with authority_body as (
  select $body$HERA KNOWLEDGE AND ACTION AUTHORITY CATALOGUE
Version: hera-action-authority-2026-08-25.1
Constitution: hera-service-constitution-2026-08-25.1

SOURCE PRECEDENCE
1. Deterministic safety and legal constraints.
2. Approved Hera Service Constitution.
3. Other signed effective operator policy.
4. Approved current non-expired dynamic knowledge.
5. Hera approved knowledge base v4.
6. Approved official website snapshot.
7. General hairdressing knowledge for explanation only.

ACTION AUTHORITY
- Hera AI may answer grounded service information and calculate 9% GST without external side effects.
- Timely remains the booking source of truth. Live availability, booking creation, rescheduling, cancellation and confirmation require a verified Timely record or authorised human outcome.
- Complaints require salon-manager ownership. Refinement eligibility is conditional and cannot be promised by AI.
- Refunds, vouchers and compensation require managing-director or owner approval.
- Medical diagnosis and legal-liability admission are prohibited.
- Privacy access, deletion and media-consent actions require verified human records.
- AI-generated WhatsApp provider sending remains prohibited while any mandatory launch gate is open or shadow mode is active.
- Any future external mutation requires eligibility, idempotency, provider confirmation, before/after audit and reconciliation.
$body$::text as body
)
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
  metadata,
  updated_at
)
select
  'hera-action-authority-catalog-2026-08-25.1',
  'Hera Knowledge and Action Authority Catalogue',
  authority_body.body,
  null,
  'hera-action-authority-2026-08-25.1',
  encode(digest(authority_body.body, 'sha256'), 'hex'),
  'approved',
  '2026-08-25T00:00:00+08:00',
  null,
  jsonb_build_object(
    'sourceType', 'approved_operator_governance',
    'runtimeAuthoritative', true,
    'constitutionVersion', 'hera-service-constitution-2026-08-25.1',
    'authorityVersion', 'hera-action-authority-2026-08-25.1',
    'liveUseAllowed', false
  ),
  now()
from authority_body
on conflict (document_key) do update
set title = excluded.title,
    body = excluded.body,
    source_url = excluded.source_url,
    version = excluded.version,
    checksum = excluded.checksum,
    status = excluded.status,
    valid_from = excluded.valid_from,
    valid_until = excluded.valid_until,
    metadata = excluded.metadata,
    updated_at = now();

create or replace function public.ai_get_action_authority_contract(
  p_action_key text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(contract)
  from public.ai_action_authority_contracts as contract
  where contract.action_key = trim(p_action_key)
    and contract.status = 'approved'
    and contract.effective_from <= now()
    and (contract.effective_until is null or contract.effective_until > now());
$$;

create or replace function public.ai_stage2_authority_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with metrics as (
    select
      (
        select count(*)::int
        from public.ai_knowledge_documents
        where status = 'approved'
      ) as approved_documents,
      (
        select count(*)::int
        from public.ai_knowledge_documents
        where status = 'approved'
          and valid_until is not null
          and valid_until <= now()
      ) as expired_approved_documents,
      (
        select count(*)::int
        from public.ai_knowledge_documents
        where status = 'approved'
          and lower(body) like '%7 working days%'
      ) as approved_legacy_window_conflicts,
      (
        select count(*)::int
        from public.ai_action_authority_contracts
        where status = 'approved'
          and effective_from <= now()
          and (effective_until is null or effective_until > now())
      ) as approved_action_contracts,
      (
        select count(*)::int
        from public.ai_knowledge_claim_registry
        where status = 'approved'
          and effective_from <= now()
          and (effective_until is null or effective_until > now())
      ) as approved_claims,
      exists (
        select 1
        from public.ai_knowledge_documents
        where document_key = 'hera-service-constitution-2026-08-25.1'
          and status = 'approved'
      ) as constitution_present,
      exists (
        select 1
        from public.ai_knowledge_documents
        where document_key = 'hera-action-authority-catalog-2026-08-25.1'
          and status = 'approved'
      ) as authority_catalogue_present
  )
  select jsonb_build_object(
    'healthy',
      expired_approved_documents = 0
      and approved_legacy_window_conflicts = 0
      and approved_action_contracts >= 24
      and approved_claims >= 9
      and constitution_present
      and authority_catalogue_present,
    'approvedDocuments', approved_documents,
    'expiredApprovedDocuments', expired_approved_documents,
    'approvedLegacyWindowConflicts', approved_legacy_window_conflicts,
    'approvedActionContracts', approved_action_contracts,
    'approvedClaims', approved_claims,
    'constitutionPresent', constitution_present,
    'authorityCataloguePresent', authority_catalogue_present
  )
  from metrics;
$$;

revoke all on function public.ai_get_action_authority_contract(text)
  from public, anon, authenticated;
revoke all on function public.ai_stage2_authority_health()
  from public, anon, authenticated;
grant execute on function public.ai_get_action_authority_contract(text) to service_role;
grant execute on function public.ai_stage2_authority_health() to service_role;

insert into public.ai_audit_log (
  actor_type,
  actor_id,
  event_type,
  target_type,
  target_id,
  details
) values (
  'management',
  'neo-chin-chuan-owner-approval',
  'stage2_knowledge_action_authority_registered',
  'governance',
  'hera-action-authority-2026-08-25.1',
  jsonb_build_object(
    'constitutionVersion', 'hera-service-constitution-2026-08-25.1',
    'actionContracts', (
      select count(*) from public.ai_action_authority_contracts
      where status = 'approved'
    ),
    'canonicalClaims', (
      select count(*) from public.ai_knowledge_claim_registry
      where status = 'approved'
    ),
    'liveUseAllowed', false,
    'productionTouched', false
  )
);

commit;
