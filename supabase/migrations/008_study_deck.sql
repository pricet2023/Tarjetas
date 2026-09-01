-- ---------------------------------------------------------------------------
-- Weighted study deck. Replaces the uniform shuffle from 004.
--
--   weight = urgency x utility
--
-- urgency — how likely you are to have forgotten it.
--     halflife = 10min x 3^streak / (1 + 0.35 x lapses)
--     urgency  = 1 - exp(-elapsed / halflife)
--   A card on a streak of six has a five-day halflife and is effectively out
--   of rotation for a day; a streak of eight is out for a month. This replaces
--   a hard "seen today, come back tomorrow" rule: it gives the same effect for
--   cards you *knew*, without exiling the ones you got wrong and without the
--   deck going empty once everything has been seen once.
--
--   Cards you got wrong are held at an urgency floor instead of on the curve
--   (see "Relearning" below) so they stay at the front until fixed.
--
-- utility — how much knowing it is worth, from corpus frequency (005).
--   Capped at Zipf 6 so that function words score high but not infinitely
--   high; they'd otherwise dominate every deck. Deliberately a cap and not a
--   stopword blocklist: if you made a card for "ser" you want to learn it, and
--   the streak term retires it after a few correct answers anyway.
--
-- Deliberately in SQL rather than the client so the algorithm can be changed
-- in a migration, and so the weighting can't drift out of step with the state
-- that feeds it.
-- ---------------------------------------------------------------------------

drop function if exists public.study_deck(integer);

create or replace function public.study_deck(
  deck_size integer default 20,
  -- Cap on unseen cards per deck. Without it, adding fifty cards means the
  -- next session is fifty things you've never met and you learn none of them.
  new_limit integer default 5,
  -- Which directions to draw from: EN->ES only, ES->EN only, or both.
  sides text[] default array['english', 'spanish']
)
returns table (
  id           uuid,
  english      text,
  spanish      text,
  notes        text,
  times_seen   integer,
  times_known  integer,
  last_seen_at timestamptz,
  created_at   timestamptz,
  updated_at   timestamptz,
  prompt_side  text,
  weight       real,
  is_new       boolean
)
language sql
volatile
as $$
  with pool as (
    select
      c.id, c.english, c.spanish, c.notes,
      c.times_seen, c.times_known, c.last_seen_at, c.created_at, c.updated_at,
      s.side as prompt_side,
      (st.last_reviewed_at is null) as is_new,
      case
        when st.last_reviewed_at is null
          -- Unseen: high but below a genuinely overdue card, so a backlog of
          -- forgotten material is cleared before new material is piled on.
          then 0.85::double precision
        -- Relearning. A card whose streak is 0 despite having been reviewed is
        -- one you got wrong and have not since fixed. The forgetting curve is
        -- the wrong model for it: it says "you saw this a minute ago, so you
        -- remember it", when in fact you demonstrably don't. Hold it at a
        -- floor until it is answered correctly, which is what makes a failed
        -- card the top of the next deck rather than the bottom.
        when st.streak = 0 and st.reps > 0
          then greatest(0.6::double precision, 1 - exp(
            - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
            / ((10.0 / 60.0) / (1 + 0.35 * coalesce(st.lapses, 0)))
          ))
        else 1 - exp(
          -- Elapsed hours over the halflife.
          - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
          / (
              (10.0 / 60.0)
              -- Streak capped at 8 (~45-day halflife): past that the interval
              -- is longer than any sensible review gap and power() starts
              -- producing absurd numbers.
              * power(3.0, least(coalesce(st.streak, 0), 8))
              / (1 + 0.35 * coalesce(st.lapses, 0))
            )
        )
      end as urgency,
      -- Zipf 3 -> 0.15, Zipf 6+ -> 1.0. Scored on the Spanish side, which is
      -- the vocabulary actually being learned.
      greatest(0.15, least(1.0,
        0.15 + 0.85 * (least(public.phrase_zipf(c.spanish), 6.0) - 3.0) / 3.0
      ))::double precision as utility
    from public.cards c
    cross join unnest(sides) as s(side)
    left join public.card_state st
      on st.card_id = c.id and st.prompt_side = s.side
  ),
  -- Cap new *cards*, not new (card, direction) rows, so a brand-new card
  -- doesn't consume two of the session's new slots.
  new_cards as (
    select p.id
      from pool p
     where p.is_new
     group by p.id
     order by max(p.utility) desc, random()
     limit greatest(0, new_limit)
  ),
  eligible as (
    select * from pool
     where not is_new or id in (select id from new_cards)
  ),
  -- Weighted sampling without replacement (Efraimidis-Spirakis): drawing the
  -- smallest -ln(U)/w picks each row with probability proportional to its
  -- weight, which is what makes this a weighted shuffle rather than a ranking.
  -- A plain `order by weight` would show the same few cards every session.
  raced as (
    select e.*,
           (e.urgency * e.utility) as w,
           -ln(random()) / greatest(e.urgency * e.utility, 1e-6) as race
      from eligible e
  ),
  -- One direction per card per deck: the direction that won its own race.
  winner as (
    select distinct on (r.id) r.*
      from raced r
     order by r.id, r.race
  )
  select
    w.id, w.english, w.spanish, w.notes,
    w.times_seen, w.times_known, w.last_seen_at, w.created_at, w.updated_at,
    w.prompt_side, w.w::real as weight, w.is_new
  from winner w
  order by w.race
  limit greatest(1, least(deck_size, 200));
$$;
