begin;

alter table public.ai_audit_log
  drop constraint if exists ai_audit_log_actor_type_check;

alter table public.ai_audit_log
  add constraint ai_audit_log_actor_type_check
  check (actor_type in ('system', 'ai', 'management', 'human'));

commit;
