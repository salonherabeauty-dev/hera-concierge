begin;

alter table public.ai_handoff_tasks
  drop constraint if exists ai_handoff_tasks_client_visible_status_check;

alter table public.ai_handoff_tasks
  add constraint ai_handoff_tasks_client_visible_status_check
  check (
    client_visible_status is null
    or length(client_visible_status) <= 4000
  );

commit;
