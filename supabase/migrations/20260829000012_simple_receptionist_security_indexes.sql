begin;

create index if not exists ai_receptionist_regeneration_history_candidate_idx
  on public.ai_receptionist_regeneration_history(candidate_outbox_id);

create index if not exists ai_receptionist_regeneration_history_conversation_idx
  on public.ai_receptionist_regeneration_history(conversation_id, created_at desc);

create index if not exists ai_receptionist_regeneration_history_job_idx
  on public.ai_receptionist_regeneration_history(job_id)
  where job_id is not null;

drop policy if exists ai_receptionist_regeneration_history_deny_direct_access
  on public.ai_receptionist_regeneration_history;

create policy ai_receptionist_regeneration_history_deny_direct_access
  on public.ai_receptionist_regeneration_history
  as restrictive
  for all
  to public
  using (false)
  with check (false);

commit;
