-- ---------------------------------------------------------------------------
-- Row Level Security. Every row is private to the auth.users row that owns it;
-- there is no sharing between accounts, so each policy is simply
-- `user_id = auth.uid()`.
-- ---------------------------------------------------------------------------

alter table public.cards enable row level security;

create policy owner_select on public.cards
  for select using (user_id = (select auth.uid()));
create policy owner_insert on public.cards
  for insert with check (user_id = (select auth.uid()));
create policy owner_update on public.cards
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy owner_delete on public.cards
  for delete using (user_id = (select auth.uid()));

alter table public.card_reviews enable row level security;

create policy owner_select on public.card_reviews
  for select using (user_id = (select auth.uid()));

-- Also require the card itself to be owned by the caller. Without this a user
-- could insert a review row of their own naming someone else's card_id, and
-- the security-definer roll-up trigger would happily bump that card's
-- counters.
create policy owner_insert on public.card_reviews
  for insert with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.cards c
       where c.id = card_id and c.user_id = (select auth.uid())
    )
  );

-- The review log is append-only: no update or delete policy, so those are
-- denied for everyone but the service role.
