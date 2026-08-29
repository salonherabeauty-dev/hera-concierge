begin;

revoke all on function public.ai_cc_human_delivery_block_reason(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.ai_cc_list_human_delivery_queue(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.ai_cc_reserve_human_delivery_send(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.ai_cc_preflight_human_delivery_send(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.ai_cc_complete_human_delivery_send(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.ai_cc_fail_human_delivery_send(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function public.ai_cc_reject_human_delivery_candidate(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.ai_cc_escalate_human_delivery_candidate(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.ai_cc_human_delivery_block_reason(uuid, uuid)
  to service_role;
grant execute on function public.ai_cc_list_human_delivery_queue(uuid, uuid, integer)
  to service_role;
grant execute on function public.ai_cc_reserve_human_delivery_send(
  uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.ai_cc_preflight_human_delivery_send(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.ai_cc_complete_human_delivery_send(
  uuid, uuid, uuid, text
) to service_role;
grant execute on function public.ai_cc_fail_human_delivery_send(
  uuid, uuid, uuid, text
) to service_role;
grant execute on function public.ai_cc_reject_human_delivery_candidate(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.ai_cc_escalate_human_delivery_candidate(
  uuid, uuid, uuid, text, text, text, text
) to service_role;

comment on table public.ai_human_delivery_reviews is
  'Named human review and delivery evidence for exact AI reply candidates. Service-role only.';
comment on function public.ai_cc_reserve_human_delivery_send(
  uuid, uuid, uuid, text, text
) is
  'Atomically revalidates and reserves one exact AI candidate for a named human-triggered Preview send.';
comment on function public.ai_cc_preflight_human_delivery_send(
  uuid, uuid, uuid, uuid, text, text
) is
  'Second fail-closed latest-message and recipient check immediately before 360dialog transmission.';

commit;
