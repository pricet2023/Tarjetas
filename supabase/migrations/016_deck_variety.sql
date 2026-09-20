-- ---------------------------------------------------------------------------
-- study_deck, fourth revision: variety, difficulty, and a cooldown.
--
-- Reported from live use: "the cards don't seem very difficult and I keep
-- seeing the same ones — I saw 'ya' about eight times in a row". Three
-- separate mechanisms were stacking up to produce that, and all three are
-- addressed here. None of them was the sampling: 008's exponential race has
-- been right the whole time, it was simply being fed a tiny pool and a weight
-- that pointed at the easiest cards in it.
--
-- ## 1. The new-card gate was the pool, not a cap on it
--
-- `eligible` was "every card you have already seen, plus at most `new_limit`
-- unseen ones", and `new_limit` was 5. On the seeded deck (3,479 cards, 011)
-- that means a learner who has reviewed 150 cards is drawing a 20-card deck
-- from ~155 candidates and meeting the remaining ~3,300 at five a session —
-- about 700 sessions to get through the deck once. The cap was written when
-- the deck was a dozen hand-made cards and "adding fifty cards" was the
-- failure mode worth guarding against (010's header). At three and a half
-- thousand it is the failure mode.
--
-- Some limit on new material has to stay: with every card eligible there are
-- ~6,600 unseen (card, direction) rows against a couple of hundred seen ones,
-- and no weighting can close a 30x count asymmetry — a deck drawn purely on
-- weight would be ~97% new material and nothing would ever be reviewed. But
-- `new_limit` stops being a gate on a shared pool and becomes a *reservation*
-- of deck slots, and three things change with it:
--
--   * the deck is stratified into a review lane and a new lane, filled
--     separately. As a gate, `new_limit` did almost nothing: the unseen cards
--     got through it and then lost every slot to the overdue cards they had to
--     race. Measured below, and it is the single reason the old fix for this
--     complaint would not have worked;
--   * the default doubles, 5 -> 10, half a deck. At the old five a session the
--     seeded deck takes ~700 sessions to get through once;
--   * **which** unseen cards fill the lane is drawn, not ranked. 010 took the
--     top N by utility, which is a stable curriculum: the same commonest
--     unseen words, in the same order, every session. 014 already fixed this
--     for pronunciation prompts after measuring three consecutive decks that
--     shared 21 distinct cards between them; the same argument applies to
--     translation prompts and the fix is now shared by both.
--
-- Whichever lane runs short, the other tops the deck up, so a first session is
-- 20 cards rather than 5 and a deck is never returned short because the review
-- side is all on cooldown.
--
-- ## 2. utility was doing the ordering, and it points at the easy words
--
-- The weight was `urgency x utility`, and the two terms are not remotely
-- comparable in range. `urgency` saturates: with a 10-minute base halflife
-- anything not reviewed within the hour is already at 0.85-1.0, so across a
-- normal deck it is very nearly a constant. README's own tuning note said so
-- out loud — "everything at streak <= 4 is saturated at urgency 1.0 after a
-- day, so below that the frequency term does the ordering". `utility` spans
-- 0.15 (Zipf 3) to 1.0 (Zipf 6+), a 6.7x range.
--
-- So in practice the deck was ranked by corpus word frequency. `('already',
-- 'ya')` is about as common as Spanish gets — utility 1.0 — and won nearly
-- every race it entered, while the rarer vocabulary that is actually worth
-- drilling sat at 0.15 and effectively never came up. "Not very difficult" is
-- exactly what a frequency-ranked deck feels like.
--
--   weight = urgency
--
-- Word frequency no longer scores cards. `phrase_zipf` is untouched and still
-- granted — 012's index-probe rewrite stands — but study_deck no longer calls
-- it, which as a side effect removes 6,958 probes from every deck build.
--
-- ## 3. Nothing suppressed a card you had just seen
--
-- There was no recency term at all. `urgency` only ever *rises* with elapsed
-- time, so the only thing keeping a just-answered card out of the next deck
-- was its own halflife — and at a 10-minute base a card answered correctly ten
-- minutes ago is back at 0.28 and one answered an hour ago at 0.86.
--
-- Two hard limits now, per card and per user, applied before anything is
-- weighted:
--
--   * not more than once in an hour;
--   * not more than twice in six hours.
--
-- Per *card*, deliberately, not per (card, direction): being asked "ya" ->
-- "already" and then "already" -> "ya" is still being asked "ya" twice, and
-- the complaint was about seeing the card.
--
-- These are limits on what a *deck* may contain. A session can no longer show
-- the same card twice at all — `advance` in session-queue.ts used to requeue a
-- failed card every four cards, indefinitely, which is the most likely literal
-- source of "eight times in a row" and is removed in the same change.
--
-- ## The halflife, lengthened to match
--
-- Dropping utility puts the whole ordering on urgency, which only works if
-- urgency discriminates. At a 10-minute base it did not: the ladder reached a
-- one-day interval only at streak 6, so essentially everything a learner had
-- not yet mastered sat pinned at ~1.0 and the race was uniform over it.
--
-- The base goes to one hour, and the streak cap from 8 to 7 to keep the
-- longest interval sane:
--
--   halflife = 1h x 3^min(streak, 7) / (1 + 0.35 x lapses)
--
--   streak | 1  2  3   4    5     6     7
--   -------+---------------------------------
--   half   | 1h 3h 9h  27h  3.4d  10d   91d
--
-- A card answered right four times running is now a day away rather than four
-- and a half hours, and one answered right seven times is a quarter away
-- rather than a month and a half. That is what "the ones I know keep
-- appearing" asks for, and it is the term to turn if reviews get too sparse.
--
-- **The relearning branch keeps the short halflife.** It is not part of the
-- ladder — the point of a failed card is that it comes back at the first
-- opportunity, and the first opportunity is now set by the hour cooldown
-- rather than by the curve. Left on the 10-minute halflife it reaches ~1.0 by
-- the time the cooldown lifts, so a failed card leads the next deck. Moved
-- onto the one-hour base it would come back at 0.63 — below an unseen card's
-- 0.85 — and failed material would rank behind new material, which is the
-- opposite of what the floor exists to do.
--
-- Unchanged and load-bearing: the per-user `card_state` join (010), one
-- direction per card per deck, and the phoneme-predicted urgency for unseen
-- pronunciation prompts (014).
-- ---------------------------------------------------------------------------

create or replace function public.study_deck(
  deck_size integer default 20,
  -- Now a floor on new material rather than a ceiling on the deck: see the
  -- header. Still a cap in the sense that review cards get first refusal on
  -- the remaining slots.
  new_limit integer default 10,
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
  with
  -- --- the cooldown --------------------------------------------------------
  -- Every card this caller has reviewed in the last six hours, with how many
  -- times and how recently. An index-only range scan on
  -- card_reviews_user_reviewed_idx (user_id, reviewed_at desc) over at most a
  -- few hundred rows — a session's worth of history, not a table scan.
  --
  -- The explicit user_id predicate rather than a reliance on RLS, matching
  -- card_progress in 009: the numbers are per-user whether or not RLS is doing
  -- its job.
  recent as (
    select r.card_id,
           count(*)           as reviews_6h,
           max(r.reviewed_at) as last_at
      from public.card_reviews r
     where r.user_id = (select auth.uid())
       and r.reviewed_at > now() - interval '6 hours'
     group by r.card_id
  ),
  -- The shared deck minus anything on cooldown. Filtered here, before the
  -- cross join onto sides, so a card is excluded in every direction at once —
  -- the limits are per card, not per prompt.
  candidates as (
    select c.id, c.english, c.spanish, c.notes, c.created_at, c.updated_at
      from public.cards c
      left join recent rc on rc.card_id = c.id
     where coalesce(rc.reviews_6h, 0) < 2
       and coalesce(rc.last_at, '-infinity'::timestamptz)
             <= now() - interval '1 hour'
  ),
  -- One Thompson draw per phoneme for the whole deck build. Materialised so
  -- the planner cannot re-evaluate a volatile function per row, which would
  -- turn sampling into noise. See 014.
  ability as materialized (
    select a.phone, a.ability
      from public.phone_ability() a
     where 'pronounce' = any(sides)
  ),
  -- The weakest phone in the phrase, per distinct phrase. The minimum rather
  -- than the mean, and that was measured — see 014's header.
  predicted as (
    select pp.phrase,
           min(a.ability) as score
      from public.phrase_phones pp
      cross join lateral unnest(pp.phones) as u(phone)
      join ability a on a.phone = u.phone
     where 'pronounce' = any(sides)
     group by pp.phrase
  ),
  pool as (
    select
      c.id, c.english, c.spanish, c.notes,
      coalesce(pr.times_seen, 0)  as times_seen,
      coalesce(pr.times_known, 0) as times_known,
      pr.last_seen_at,
      c.created_at, c.updated_at,
      s.side as prompt_side,
      (st.last_reviewed_at is null) as is_new,
      case
        when st.last_reviewed_at is null
          -- Unseen. A translation prompt is new *material* and takes the flat
          -- constant, high but below a genuinely overdue card so a backlog of
          -- forgotten material is cleared before more is piled on. An unseen
          -- pronunciation prompt is a word already being met in the other two
          -- directions and takes the difficulty predicted from its phonemes
          -- over the full range instead — 014's header for why the 0.85 floor
          -- deliberately does not carry over to it.
          then case
                 when s.side = 'pronounce' and pd.score is not null
                   then greatest(0.05, 1.0 - pd.score)
                 else 0.85::double precision
               end
        -- Relearning: got wrong, not since fixed. Held at a floor until it is
        -- answered correctly, and kept on the 10-minute halflife rather than
        -- the lengthened one below so that it reaches ~1.0 by the time the
        -- hour cooldown lifts. See the header.
        when st.streak = 0 and st.reps > 0
          then greatest(0.6::double precision, 1 - exp(
            - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
            / ((10.0 / 60.0) / (1 + 0.35 * coalesce(st.lapses, 0)))
          ))
        -- The ladder. Base one hour (was ten minutes), streak capped at 7
        -- (~91 days). `lapses` counts right-then-wrong transitions, so a card
        -- that is personally difficult keeps a shorter interval even after a
        -- fresh streak.
        else 1 - exp(
          - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
          / (
              1.0
              * power(3.0, least(coalesce(st.streak, 0), 7))
              / (1 + 0.35 * coalesce(st.lapses, 0))
            )
        )
      end as urgency
    from candidates c
    cross join unnest(sides) as s(side)
    -- The per-user join: the deck draws from every card in the shared
    -- portfolio but weights them by the caller's own history. Drop this
    -- predicate and my partner's answers retire cards out of my deck. See 010.
    left join public.card_state st
      on st.card_id = c.id
     and st.prompt_side = s.side
     and st.user_id = (select auth.uid())
    left join public.card_progress pr
      on pr.card_id = c.id
    left join predicted pd
      on pd.phrase = c.spanish
     and s.side = 'pronounce'
  ),
  -- Weighted sampling without replacement (Efraimidis-Spirakis): drawing the
  -- smallest -ln(U)/w picks each row with probability proportional to its
  -- weight, which is what makes this a weighted shuffle rather than a ranking.
  -- The weight is now urgency alone — see the header.
  raced as (
    select p.*,
           p.urgency as w,
           -ln(random()) / greatest(p.urgency, 1e-6) as race
      from pool p
  ),
  -- One direction per card per deck: the direction that won its own race. Done
  -- before the deck is filled, so a card takes one slot rather than two.
  winner as (
    select distinct on (r.id) r.*
      from raced r
     order by r.id, r.race
  ),
  counts as (
    select count(*) filter (where is_new) as n_new from winner
  ),
  -- --- the two lanes -------------------------------------------------------
  -- `new_limit` is a *reservation*, not a candidate pool, and the difference
  -- is the whole reason this revision exists. 010 and 014 let the unseen cards
  -- through the gate and then made them race the review cards for every slot,
  -- which they lose: an overdue card is at urgency ~1.0 against an unseen
  -- card's 0.85, and there are a couple of hundred of the former against ten
  -- of the latter. Measured on a learner with 150 cards reviewed and
  -- new_limit = 5: ten consecutive decks contained *one* new card each, and
  -- 200 dealt cards covered 103 distinct ones. The cap was never the binding
  -- constraint; the race was.
  --
  -- So the deck is stratified. The review lane and the new lane are filled
  -- separately, each by its own exponential race, and neither can crowd the
  -- other out. Sampling is preserved inside each lane, which is what §4.7 of
  -- the plan actually asks for — it objects to replacing the race with a sort,
  -- not to deciding how many of each kind of card a session should contain.
  --
  -- The review lane is filled first so that it gets its full share whenever it
  -- can. Whichever lane runs short, the other tops the deck up: a learner on
  -- their first session gets 20 new cards rather than an empty deck, and one
  -- who has reviewed everything recently enough to be on cooldown gets a deck
  -- of new material rather than nothing.
  seen_side as (
    select * from winner
     where not is_new
     order by race
     limit greatest(0, deck_size - least(greatest(new_limit, 0),
                                         (select n_new from counts)))
  ),
  -- For a translation prompt every unseen row carries the same 0.85, and a
  -- race between equal weights is a uniform shuffle — which is exactly the
  -- "pick at random from the entire portfolio" this lane is for. For a
  -- pronunciation prompt the urgencies differ and the race samples
  -- proportional to them, favouring the weak sounds without dealing the same
  -- twenty cards until they are fixed (014).
  new_side as (
    select * from winner
     where is_new
     order by race
     limit greatest(0, deck_size - (select count(*) from seen_side))
  ),
  picked as (
    select * from seen_side
    union all
    select * from new_side
  )
  select
    p.id, p.english, p.spanish, p.notes,
    p.times_seen, p.times_known, p.last_seen_at, p.created_at, p.updated_at,
    p.prompt_side, p.w::real as weight, p.is_new
  from picked p
  -- Interleaved by race rather than lane, so new cards are spread through the
  -- session instead of arriving in a block at one end of it.
  order by p.race
  limit greatest(1, least(deck_size, 200));
$$;

comment on function public.study_deck(integer, integer, text[]) is
  'Weighted study deck for the calling user. weight = urgency; a card may not '
  'be dealt twice in an hour or more than twice in six hours.';
