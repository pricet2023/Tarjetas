-- ---------------------------------------------------------------------------
-- Deck builder. Deliberately a database function rather than an `order by
-- random()` in the client: the shuffle is the piece we expect to replace with
-- a real spaced-repetition schedule, and keeping it here means that change is
-- one migration and no app deploy.
--
-- For now: uniform random over the caller's cards. `times_seen`,
-- `times_known` and `last_seen_at` are already maintained on public.cards and
-- are returned with each row, so a weighted or due-date ordering can be
-- dropped in without touching the callers or the return shape.
--
-- security invoker (the default) so the caller's RLS policies still apply and
-- the function can only ever see that user's own cards.
-- ---------------------------------------------------------------------------

create or replace function public.study_deck(deck_size integer default 20)
returns setof public.cards
language sql
volatile
as $$
  select *
    from public.cards
   order by random()
   limit greatest(1, least(deck_size, 200));
$$;
