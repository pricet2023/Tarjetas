-- ---------------------------------------------------------------------------
-- Flash cards. One row per card, owned by the auth.users row that created it.
-- A card has exactly two sides: `english` and `spanish`.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

create table public.cards (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  english       text not null check (length(btrim(english)) > 0),
  spanish       text not null check (length(btrim(spanish)) > 0),
  -- Optional freeform hint shown under the answer (gender, register, an
  -- example sentence). Never used for matching.
  notes         text,
  -- Denormalised review counters, maintained by the trigger in 002_reviews.
  -- They live here so the study-deck query can order by them without a join.
  times_seen    integer not null default 0,
  times_known   integer not null default 0,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- The same English prompt twice in one deck is always a mistake, not a
  -- deliberate duplicate — cards are per-user so this scopes to the owner.
  unique (user_id, english)
);

create index cards_user_id_idx on public.cards (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Scoped to the content columns so the review counter roll-up in
-- 002_reviews doesn't count as "the user edited this card".
create trigger cards_set_updated_at
  before update of english, spanish, notes on public.cards
  for each row execute function public.set_updated_at();
