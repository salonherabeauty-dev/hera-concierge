begin;

revoke all on function public.ai_suppress_superseded_job_insert()
  from public, anon, authenticated, service_role;

commit;
