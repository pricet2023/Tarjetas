-- ---------------------------------------------------------------------------
-- Review log — one row per swipe. Kept as an append-only history rather than
-- just counters so a smarter scheduling algorithm (spaced repetition) can be
-- fitted to real data later without having thrown the timings away.
-- ---------------------------------------------------------------------------

create table public.card_reviews (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references public.cards (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- true = swiped "knew it", false = "didn't know it".
  knew        boolean not null,
  -- Which side was showing when the card was revealed, so we can later tell
  -- recognition (es -> en) apart from recall (en -> es).
  prompt_side text not null check (prompt_side in ('english', 'spanish')),
  reviewed_at timestamptz not null default now()
);

create index card_reviews_card_id_idx on public.card_reviews (card_id);
create index card_reviews_user_reviewed_idx on public.card_reviews (user_id, reviewed_at desc);

-- Roll each review up onto the card so the deck query stays a single-table
-- read. Insert-only: reviews are never updated or deleted in normal use.
create or replace function public.apply_review_to_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cards
     set times_seen   = times_seen + 1,
         times_known  = times_known + case when new.knew then 1 else 0 end,
         last_seen_at = new.reviewed_at
   where id = new.card_id;
  return new;
end;
$$;

create trigger card_reviews_apply
  after insert on public.card_reviews
  for each row execute function public.apply_review_to_card();
