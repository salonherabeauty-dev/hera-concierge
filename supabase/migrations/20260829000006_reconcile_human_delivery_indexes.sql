begin;

drop index if exists public.ai_human_delivery_reviews_approved_outbox_unique;

create unique index if not exists ai_human_delivery_reviews_approved_outbox_id_unique
  on public.ai_human_delivery_reviews(approved_outbox_id)
  where approved_outbox_id is not null;

create index if not exists ai_human_delivery_reviews_reviewer_idx
  on public.ai_human_delivery_reviews(reviewer_user_id, reviewed_at desc);

commit;
