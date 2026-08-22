begin;

create index if not exists ai_messages_contact_id_idx
  on public.ai_messages(contact_id);

create index if not exists ai_jobs_source_message_id_idx
  on public.ai_jobs(source_message_id);

create index if not exists ai_outbox_conversation_id_idx
  on public.ai_outbox(conversation_id);

create index if not exists ai_outbox_source_message_id_idx
  on public.ai_outbox(source_message_id);

create index if not exists ai_decisions_conversation_id_idx
  on public.ai_decisions(conversation_id);

create index if not exists ai_incidents_conversation_id_idx
  on public.ai_incidents(conversation_id);

commit;
