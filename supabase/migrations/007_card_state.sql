-- ---------------------------------------------------------------------------
-- Per-card, per-direction scheduling state.
--
-- Keyed on (card_id, prompt_side) rather than just card_id because the two
-- directions are genuinely different skills: recognising "la casa" as "the
-- house" (prompt_side = 'spanish') arrives long before being able to produce
-- "la casa" from "the house" (prompt_side = 'english'). Sharing one schedule
-- between them lets a card you can only recognise count as fully known.
--
-- This is scheduling state. The `times_seen` / `times_known` counters on
-- public.cards remain lifetime totals for display in the card list; they are
-- deliberately not the same numbers.
-- ---------------------------------------------------------------------------

create table public.card_state (
  card_id          uuid not null references public.cards (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- Which side was face-up. 'english' = produce the Spanish (the harder
  -- direction); 'spanish' = recognise it.
  prompt_side      text not null check (prompt_side in ('english', 'spanish')),

  reps             integer not null default 0,
  -- Consecutive correct answers. Reset to 0 by any wrong answer — this is the
  -- "do I know it *now*" measure that drives the review interval, and it is
  -- why we don't schedule on the lifetime times_known/times_seen ratio, which
  -- can't tell 1/1 from 20/20 and treats a card you've just forgotten as 95%
  -- known.
  streak           integer not null default 0,
  -- Right-then-wrong transitions. Some cards are personally difficult (ser vs
  -- estar) and stay difficult; lapses permanently shorten the interval for
  -- that card rather than letting a fresh streak paper over the history.
  lapses           integer not null default 0,
  last_reviewed_at timestamptz,

  primary key (card_id, prompt_side)
);

create index card_state_user_idx on public.card_state (user_id);

alter table public.card_state enable row level security;

-- Rows are written only by the trigger below (security definer), so no insert
-- or update policy is needed — just the read the deck builder relies on.
create policy owner_select on public.card_state
  for select using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Replaces the counter-only version from 002_reviews: each review now updates
-- the lifetime totals on the card *and* the scheduling state for the direction
-- it was asked in.
-- ---------------------------------------------------------------------------
create or replace function public.apply_review_to_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_knew boolean := new.knew;
begin
  update public.cards
     set times_seen   = times_seen + 1,
         times_known  = times_known + case when v_knew then 1 else 0 end,
         last_seen_at = new.reviewed_at
   where id = new.card_id;

  insert into public.card_state as st
    (card_id, user_id, prompt_side, reps, streak, lapses, last_reviewed_at)
  values
    (new.card_id, new.user_id, new.prompt_side, 1,
     case when v_knew then 1 else 0 end, 0, new.reviewed_at)
  on conflict (card_id, prompt_side) do update
    set reps   = st.reps + 1,
        streak = case when v_knew then st.streak + 1 else 0 end,
        -- A wrong answer only counts as a lapse if the card had been going
        -- right; failing it twice running is one lapse, not two.
        lapses = st.lapses + case when not v_knew and st.streak > 0 then 1 else 0 end,
        last_reviewed_at = new.reviewed_at;

  return new;
end;
$$;

-- Replay any history that predates this table so existing cards don't all
-- look brand new.
insert into public.card_state (card_id, user_id, prompt_side, reps, streak, lapses, last_reviewed_at)
with ordered as (
  select card_id, user_id, prompt_side, knew, reviewed_at,
         lag(knew) over (partition by card_id, prompt_side order by reviewed_at) as prev_knew
    from public.card_reviews
),
agg as (
  select card_id, user_id, prompt_side,
         count(*)                                       as reps,
         count(*) filter (where not knew and prev_knew)  as lapses,
         max(reviewed_at)                               as last_reviewed_at,
         max(reviewed_at) filter (where not knew)        as last_wrong_at
    from ordered
   group by card_id, user_id, prompt_side
)
select a.card_id, a.user_id, a.prompt_side, a.reps,
       -- The streak is however many reviews have happened since the last
       -- wrong answer (all of them, if there has never been one).
       (select count(*)
          from public.card_reviews r
         where r.card_id = a.card_id
           and r.prompt_side = a.prompt_side
           and r.reviewed_at > coalesce(a.last_wrong_at, '-infinity'::timestamptz)),
       a.lapses, a.last_reviewed_at
  from agg a
on conflict (card_id, prompt_side) do nothing;
