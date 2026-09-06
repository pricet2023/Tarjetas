-- ---------------------------------------------------------------------------
-- The payoff: what you can and can't say decides what you get asked to say.
--
-- 013 collects skill per phoneme. This spends it, and the reason it is worth
-- spending is that **a phoneme has a history where a card does not**. The
-- existing scheduler models knowledge per (card, direction), so a card nobody
-- has ever seen has nothing to go on — hence the flat 0.85 unseen-urgency in
-- 010, a constant precisely because a card has no past. A *sound* has one, and
-- sounds are shared across the whole deck: a new card containing /r/ and /x/
-- is predictably hard for an English speaker before it is ever attempted.
--
-- Two pieces.
--
-- ## phrase_phones — the phonemes of a card face, in the database
--
-- G2P is 300 lines of TypeScript context rules (`src/app/lib/phonology/`) and
-- is not going to be rewritten in SQL. But the deck weighting stays in SQL
-- (CLAUDE.md), so the *result* of G2P has to be reachable from a query. This
-- table is that seam, and it is keyed on the Spanish text rather than on a
-- card id for three reasons:
--
--   * it is derived from the text and nothing else, so two cards with the same
--     Spanish share a row and an edit simply misses until it is refilled;
--   * `public.cards` is the shared deck, and a derived cache does not belong
--     on a row two people are editing;
--   * it makes this exactly the `word_frequency` / `phrase_zipf` shape from
--     005 and 012 — reference data, probed by key, never joined in bulk. That
--     precedent is load-bearing here: study_deck evaluates its terms for every
--     one of 3,479 seeded cards before it can sample, and 012 is the record of
--     what happens when one of those terms is a hash join.
--
-- Filled for the seed deck by 015 (generated) and by the client for anything
-- typed in afterwards. A phrase that is missing costs nothing: the card falls
-- back to the same flat urgency it has today.
--
-- ## Thompson sampling over a Beta posterior per phoneme
--
-- 010 already samples rather than ranks — an exponential race
-- (Efraimidis-Spirakis) that draws proportional to weight, so that the same
-- few cards don't come up every session. §4.7 of the plan is explicit that
-- this structure is the exploration mechanism and must not be replaced by a
-- sort, and the Bayesian version of it is Thompson sampling: keep a
-- *distribution* per phoneme, draw one value from each, and act as though the
-- draw were the truth.
--
-- So `phone_ability` draws once per phoneme per deck build (not once per card
-- — that would be noise, not sampling) and a card's predicted score is the
-- mean of the draws over its phonemes. A sound with fifty observations draws
-- close to its mean; a sound with none draws from Beta(1,1) and can come back
-- anywhere, which is exactly the "study this because we are uncertain" term
-- the plan asks for. Uncertainty earns attention without a separate bonus
-- being bolted on.
--
-- Deliberately NOT done: pronunciation still does not compete for deck slots
-- (013's header), and a card that *has* been pronounced still schedules on its
-- own history rather than on its phonemes. Direct evidence about this card
-- beats a prediction from its parts once there is any; the prediction is worth
-- having precisely where there is none.
-- ---------------------------------------------------------------------------

-- --- the phonemes of a card face -------------------------------------------
create table public.phrase_phones (
  -- The card's Spanish, verbatim. `g2pPhrase` normalises internally, so this
  -- is stored as the card stores it and looked up the same way.
  phrase     text primary key,
  -- Our symbols, in spoken order, repeats included: a word with three /a/ in
  -- it really is three goes at the sound. `PHONES` in inventory.ts.
  phones     text[] not null,
  -- Which build of G2P produced it, so a rule change can be found and
  -- refilled rather than silently believed.
  g2p_version integer not null default 1,
  created_at timestamptz not null default now()
);

comment on table public.phrase_phones is
  'G2P output cached per card face. Derived reference data — shared, like the '
  'deck itself; nothing here says anything about a person.';

alter table public.phrase_phones enable row level security;

-- Shared reference data, on the same side of 009's line as the deck: every
-- signed-in user reads it, and any of them may fill in a phrase the seed did
-- not cover. There is nothing personal in it to protect.
create policy shared_select on public.phrase_phones
  for select to authenticated using (true);
create policy shared_insert on public.phrase_phones
  for insert to authenticated with check (true);
create policy shared_update on public.phrase_phones
  for update to authenticated using (true) with check (true);

grant select, insert, update on public.phrase_phones to authenticated;

-- ---------------------------------------------------------------------------
-- One Thompson draw per phoneme, for this caller, for this deck build.
--
-- **Every phoneme the deck actually uses, not only the ones with a history.**
-- The obvious cheaper version returns the rows of `phone_state` and lets the
-- caller `coalesce(ability, random())` for the rest — and it is wrong in a way
-- that is easy to miss: `random()` inside the caller's join is evaluated once
-- per *occurrence*, so an untried phoneme gets a different draw in every
-- phrase that contains it. That is noise, not sampling, and it lands on
-- exactly the phonemes exploration matters most for. One draw per phoneme,
-- shared by every card containing it, is the whole idea.
--
-- The universe comes from `phrase_phones` rather than from a hardcoded list,
-- so it cannot drift out of step with the inventory in `inventory.ts`. It is a
-- distinct over ~37,000 unnested labels once per deck build, which is nothing
-- next to the per-card terms.
--
-- **The Beta is sampled through its normal approximation**, and that is a
-- compromise worth stating: Postgres has no gamma sampler, and writing one
-- (Marsaglia-Tsang) in plpgsql to be called from a set-returning query is a
-- lot of machinery for a term that only has to rank cards. The approximation
-- is poor exactly where the Beta is most skewed — few observations — so the
-- draw is clamped rather than allowed to leave [0, 1], and the effect of the
-- error is that a barely-seen phone explores slightly less eagerly than a
-- true Beta would. The direction of that error is the safe one.
--
-- A near miss counts half to each side, matching `summarise` in gop.ts: the
-- glide/vowel confusions it marks `close` are genuinely not the same evidence
-- as a wrong sound (§4.1), and 013 keeps the three counts apart precisely so
-- this function gets to decide.
-- ---------------------------------------------------------------------------
create function public.phone_ability()
returns table (phone text, ability double precision)
language sql
volatile
as $$
  select ps.phone,
         least(0.999, greatest(0.001,
           -- mean + sd * N(0,1), Box-Muller. `random()` never returns 1 but
           -- can return 0, and ln(0) is -infinity, so the first draw is
           -- nudged off the boundary.
           (alpha / (alpha + beta))
           + sqrt((alpha * beta) / (power(alpha + beta, 2) * (alpha + beta + 1)))
             * sqrt(-2 * ln(greatest(random(), 1e-12))) * cos(2 * pi() * random())
         ))
    from (
      select universe.phone,
             -- No row at all is Beta(1, 1): mean 0.5, sd 0.289, so the draw
             -- can come back anywhere and an untried sound is worth finding
             -- out about.
             1.0 + coalesce(p.hits, 0)   + 0.5 * coalesce(p.nears, 0) as alpha,
             1.0 + coalesce(p.misses, 0) + 0.5 * coalesce(p.nears, 0) as beta
        from (
          select distinct u.phone
            from public.phrase_phones pp
            cross join lateral unnest(pp.phones) as u(phone)
        ) universe
        left join public.phone_state p
          on p.phone = universe.phone
         and p.user_id = (select auth.uid())
    ) ps;
$$;

comment on function public.phone_ability() is
  'One Thompson-sampled ability per phoneme the caller has evidence for. '
  'Volatile: a fresh draw per deck build is the point.';

grant execute on function public.phone_ability() to authenticated;

-- ---------------------------------------------------------------------------
-- study_deck, third revision. Same algorithm as 010 —
--
--   weight = urgency x utility
--
-- see 008's header for the halflife, the relearning floor and the Zipf cap,
-- and 010's for the per-user card_state join that is the whole shared-deck /
-- private-progress split. One thing changes: an unseen *pronunciation* prompt
-- no longer takes the flat 0.85, but the difficulty predicted from its
-- phonemes.
--
--   predicted score = avg over the card's phonemes of a Thompson draw
--   urgency         = 1 - predicted score
--
-- The mean rather than the minimum, and not for want of a story about weakest
-- links: `summarise` in gop.ts scores an attempt as the *share of its phonemes
-- that came back clean*, so the mean of per-phoneme success probabilities is a
-- prediction of the very number the attempt will produce. Taking the minimum
-- would predict something nobody records, and would saturate — every card
-- containing /r/ would look equally urgent.
--
-- Cost: the prediction is computed once per distinct phrase, not once per
-- (card, direction), and only when 'pronounce' is among the sides asked for.
-- 012 is the reason that sentence is in this header.
-- ---------------------------------------------------------------------------
create or replace function public.study_deck(
  deck_size integer default 20,
  new_limit integer default 5,
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
  -- One draw per phoneme for the whole deck build. Materialised so the
  -- planner cannot re-evaluate a volatile function per row, which would turn
  -- Thompson sampling into noise: the whole idea is that every card
  -- containing /r/ is judged against the *same* belief about /r/ this time
  -- round.
  ability as materialized (
    select a.phone, a.ability
      from public.phone_ability() a
     where 'pronounce' = any(sides)
  ),
  -- How well the learner is expected to manage this card face, per distinct
  -- phrase. `phone_ability` covers every phoneme the deck uses, including the
  -- ones with no history, so this is a plain join and no phoneme is drawn
  -- twice in one deck build.
  --
  -- **The weakest phone, not the mean, and this was measured.** The mean is
  -- the better *predictor*: `summarise` in gop.ts scores an attempt as the
  -- share of its phonemes that came back clean, so a mean of per-phoneme
  -- success probabilities predicts the very number the attempt will produce.
  -- It is the wrong thing to schedule on. Every Spanish card is mostly vowels
  -- and /s/ and /n/, which a learner has long since got right, so one hopeless
  -- /r/ in a six-phone word moves the mean from 0.95 to 0.80 and the card ends
  -- up 1.1x more urgent than a card with no /r/ in it at all. Measured on a
  -- profile with /r/ and /x/ at 2 hits in 60: a 40-card deck came back with
  -- 10% of its faces containing one, against 10.6% in the deck at large — the
  -- feature did nothing.
  --
  -- A card is worth saying because of its hardest sound. Taking the minimum
  -- says that, and the saturation it is accused of is the correct answer:
  -- while /r/ is the weak sound, every card containing one *is* about equally
  -- worth practising, and utility (word frequency) is the right tie-break
  -- between them.
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
          -- Unseen. For a translation prompt there is nothing to predict from,
          -- so it stays the 010 constant: high, but below a genuinely overdue
          -- card, so a backlog of forgotten material is cleared before new
          -- material is piled on. For a pronunciation prompt there *is*
          -- something to predict from, and this is the whole point of 013.
          then case
                 when s.side = 'pronounce' and pd.score is not null
                   -- The predicted score is *mapped* onto a band around the
                   -- constant it replaces, not clamped into it. Clamping was
                   -- the first attempt and it silently deleted the whole
                   -- feature: a learner who says most sounds well predicts
                   -- ~0.95 on nearly every card, so `1 - score` is ~0.05 for
                   -- all of them and every card pinned to the floor. Mapping
                   -- keeps the ordering, which is the only thing the race
                   -- actually consumes.
                   --
                   -- Straight through: the probability the weakest sound in
                   -- this card comes out wrong.
                   --
                   -- **010's 0.85 floor for unseen cards deliberately does not
                   -- carry over**, and that is the whole difference between
                   -- the two kinds of "unseen". An unseen translation prompt
                   -- is new *material* — it has to be high, or new cards never
                   -- get learned. An unseen pronunciation prompt is a word the
                   -- learner already meets in the other two directions; only
                   -- our recording of them saying it is missing. If every
                   -- sound in it is one they reliably produce, it genuinely is
                   -- not urgent, and saying so is the point.
                   --
                   -- Squeezing it into a band around 0.85 was the second
                   -- attempt and it failed for a measurable reason: the band
                   -- gave a 1.9x spread where utility already spans 6.7x
                   -- (Zipf 3 to Zipf 6), so weighted sampling barely noticed
                   -- it — 11.3% of dealt cards carried a weak sound against a
                   -- 10.6% base rate. Full range restores the signal without
                   -- reintroducing the ranking that killed the variety.
                   then greatest(0.05, 1.0 - pd.score)
                 else 0.85::double precision
               end
        -- Relearning: a card whose streak is 0 despite having been reviewed is
        -- one you got wrong and have not since fixed. Held at a floor until it
        -- is answered correctly. See 008.
        when st.streak = 0 and st.reps > 0
          then greatest(0.6::double precision, 1 - exp(
            - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
            / ((10.0 / 60.0) / (1 + 0.35 * coalesce(st.lapses, 0)))
          ))
        else 1 - exp(
          - (extract(epoch from (now() - st.last_reviewed_at)) / 3600.0)
          / (
              (10.0 / 60.0)
              * power(3.0, least(coalesce(st.streak, 0), 8))
              / (1 + 0.35 * coalesce(st.lapses, 0))
            )
        )
      end as urgency,
      -- Zipf 3 -> 0.15, Zipf 6+ -> 1.0. Scored on the Spanish side, which is
      -- the vocabulary actually being learned. An index probe since 012.
      greatest(0.15, least(1.0,
        0.15 + 0.85 * (least(public.phrase_zipf(c.spanish), 6.0) - 3.0) / 3.0
      ))::double precision as utility
    from public.cards c
    cross join unnest(sides) as s(side)
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
  -- Cap new *cards*, not new (card, direction) rows, so a brand-new card
  -- doesn't consume two of the session's new slots.
  --
  -- **The gate has to be a race for pronunciation, and a ranking for the rest,
  -- and the difference is not cosmetic.**
  --
  -- 010 takes the top N unseen cards by utility, which is a curriculum: the
  -- commonest unseen words first, in a stable order, which is what you want
  -- when the thing being learned is the word. Every unseen row had the same
  -- urgency there, so ranking on utility and on `urgency * utility` were the
  -- same order.
  --
  -- With 013 that stops being true, and a hard top-N over a *differentiated*
  -- urgency becomes the failure mode §4.7 warns about — "preserve the
  -- sampling; do not replace it with a sort". Measured, on a learner whose
  -- /r/ and /x/ are weak: three consecutive 20-card decks contained 21
  -- distinct cards between them. A stable weakness produces a stable ranking,
  -- and the same twenty cards come up until it is fixed.
  --
  -- So the pronunciation gate draws the same exponential race the deck itself
  -- uses (Efraimidis-Spirakis, `raced` below), which samples proportional to
  -- weight instead of taking the maximum: the weak sounds are still heavily
  -- favoured, but the cards carrying them differ session to session. Nothing
  -- here is a curriculum — the words are ones the learner already meets in the
  -- other two directions, and only the sounds are new.
  new_cards as (
    select p.id
      from pool p
     where p.is_new
     group by p.id
     order by case
                when 'pronounce' = any(sides)
                  then min(-ln(random()) / greatest(p.urgency * p.utility, 1e-6))
                -- Ascending, so negating is descending by utility.
                else -max(p.utility)
              end,
              random()
     limit greatest(0, new_limit)
  ),
  eligible as (
    select * from pool
     where not is_new or id in (select id from new_cards)
  ),
  -- Weighted sampling without replacement (Efraimidis-Spirakis): drawing the
  -- smallest -ln(U)/w picks each row with probability proportional to its
  -- weight, which is what makes this a weighted shuffle rather than a ranking.
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
