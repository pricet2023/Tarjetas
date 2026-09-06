-- ---------------------------------------------------------------------------
-- Pronunciation: a third direction, and per-phoneme skill.
--
-- The card shows the English, you say the Spanish, and the client scores it
-- per phoneme entirely on-device (src/app/lib/{phonology,align,acoustic}).
-- What reaches the database is the result: one number for the attempt and the
-- per-phone detail behind it.
--
-- Three things happen here, and the third is the point.
--
--   * 'pronounce' becomes a legal prompt_side on card_reviews and card_state.
--     It is a third *direction*, not a new keying scheme: saying a word is a
--     separate skill from recognising it, exactly as the two translation
--     directions already are, so it gets its own streak and its own interval
--     out of the machinery that is already there.
--
--   * card_reviews gains `score` and `phone_scores`, both nullable. Additive
--     columns leave the append-only contract alone — there is still no update
--     or delete policy, and the log is still what card_state would be rebuilt
--     from.
--
--   * phone_state accumulates skill per *phoneme*. This is the row the whole
--     exercise exists for. A card's translation history says nothing about a
--     card you have never seen; a phoneme's history says a great deal, because
--     sounds are shared across the deck. /r/ and /x/ are hard for an English
--     speaker in every word that contains them, so a brand-new card's
--     difficulty is predictable before it is ever attempted. Phase 8 spends
--     this; Phase 6 only has to collect it.
--
-- phone_state is progress, not reference data, so it sits on the private side
-- of the line 009 drew: RLS scopes it to the caller even though the words that
-- produced it are in the shared deck. Two people learning from one portfolio
-- have different mouths.
--
-- Deliberately NOT done here: pronunciation does not compete for deck slots.
-- study_deck picks one direction per card with `distinct on (r.id)`, so adding
-- 'pronounce' to the default `sides` would let a pronunciation prompt displace
-- a translation prompt — silently changing a working scheduler on the strength
-- of scores nothing has validated yet. The client asks for `sides =>
-- ['pronounce']` and gets a pronunciation deck; the mixed deck is untouched.
-- Revisit once phone_state has enough in it to be trusted.
-- ---------------------------------------------------------------------------

-- --- 'pronounce' is a direction --------------------------------------------
alter table public.card_reviews drop constraint card_reviews_prompt_side_check;
alter table public.card_reviews
  add constraint card_reviews_prompt_side_check
  check (prompt_side in ('english', 'spanish', 'pronounce'));

alter table public.card_state drop constraint card_state_prompt_side_check;
alter table public.card_state
  add constraint card_state_prompt_side_check
  check (prompt_side in ('english', 'spanish', 'pronounce'));

comment on column public.card_state.prompt_side is
  'Which skill this row schedules. ''english'' = produce the Spanish, '
  '''spanish'' = recognise it, ''pronounce'' = say it out loud. Three separate '
  'skills, scheduled separately.';

-- --- what an attempt records -----------------------------------------------
alter table public.card_reviews
  -- The share of phones that came back clean, near misses counting half (see
  -- `summarise` in gop.ts). Display and logging only: the calibration that
  -- means anything is per phone, and all of it is in phone_scores.
  add column score real check (score is null or (score >= 0 and score <= 1)),
  -- The PhoneScore[] the client scored, snake_cased at the api boundary:
  --   [{ phone, start, end, gop, rival, rival_label, z, calibrated, verdict }]
  -- Stored whole rather than shredded into columns because it is evidence, not
  -- state — the same reason card_reviews itself exists. When the scoring
  -- changes shape, phone_state is rebuilt from this the way 009 rebuilt
  -- card_state from the review log.
  add column phone_scores jsonb check (phone_scores is null or jsonb_typeof(phone_scores) = 'array');

-- A translation review has no pronunciation in it. Without this a client bug
-- could file a mis-sided row that phone_state would then quietly count.
alter table public.card_reviews
  add constraint card_reviews_pronounce_payload
  check (prompt_side = 'pronounce' or (score is null and phone_scores is null));

comment on column public.card_reviews.score is
  'Pronunciation attempts only: share of phones scored good, near misses half.';
comment on column public.card_reviews.phone_scores is
  'Pronunciation attempts only: the per-phone detail the score was reduced from.';

-- --- skill, per phoneme ----------------------------------------------------
create table public.phone_state (
  user_id  uuid not null references auth.users (id) on delete cascade,
  -- Our IPA symbol, as G2P emits it — `PHONES` in
  -- src/app/lib/phonology/inventory.ts, not a model label. The seam between
  -- our inventory and the acoustic model's 392 rows stays in the client.
  phone    text not null,

  -- One observation per aligned span, so a word with three /a/ in it counts
  -- three times. That is right: they are three separate goes at the sound.
  attempts integer not null default 0,
  -- The three verdicts, kept apart rather than folded into successes/failures.
  -- A near miss (glide heard as its full vowel) is genuinely not the same
  -- evidence as a wrong sound, and Phase 8 should get to decide what a Beta
  -- posterior counts as a success rather than inheriting the choice from here.
  hits     integer not null default 0,
  nears    integer not null default 0,
  misses   integer not null default 0,

  -- Running GOP moments, in nats, for the second normalisation §4.6 describes:
  -- native stats calibrate the phoneme, but they cannot cancel *this*
  -- microphone in *this* room. Sum and sum-of-squares rather than a stored
  -- mean so the numbers stay exactly additive under an append-only log.
  gop_sum        double precision not null default 0,
  gop_sq_sum     double precision not null default 0,

  last_scored_at timestamptz,

  primary key (user_id, phone)
);

comment on table public.phone_state is
  'Per-user, per-phoneme pronunciation skill. Progress, not reference data: '
  'the deck is shared, this is not.';

alter table public.phone_state enable row level security;

-- Written only by the security-definer trigger below, exactly like card_state,
-- so there is no insert or update policy to write — just the read.
create policy owner_select on public.phone_state
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.phone_state to authenticated;

-- ---------------------------------------------------------------------------
-- Roll a scored attempt up onto the phonemes it exercised.
--
-- Separate from apply_review() rather than bolted into it: that function is
-- about a card's schedule and this one is about sounds, they share nothing but
-- the row that fired them, and keeping them apart means a change to either
-- cannot break the other. Both are `after insert`, neither reads the other's
-- table.
--
-- Credit assignment is the thing alignment bought us. "The attempt was poor"
-- is not a training signal for a skill model; "the /r/ in this attempt was
-- 3σ below native and the model heard /ɾ/" is, and it is only sayable because
-- forced alignment said which frames were the /r/.
-- ---------------------------------------------------------------------------
create function public.apply_phone_scores()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone_scores is null then
    return new;
  end if;

  insert into public.phone_state as ps
    (user_id, phone, attempts, hits, nears, misses, gop_sum, gop_sq_sum, last_scored_at)
  select new.user_id,
         s.phone,
         count(*)::integer,
         count(*) filter (where s.verdict = 'good')::integer,
         count(*) filter (where s.verdict = 'close')::integer,
         count(*) filter (where s.verdict = 'off')::integer,
         sum(s.gop),
         sum(s.gop * s.gop),
         new.reviewed_at
    from jsonb_to_recordset(new.phone_scores)
           as s(phone text, gop double precision, verdict text)
   -- A phone with no rival anywhere in the model's inventory scores -Infinity,
   -- which JSON has no way to write and JSON.stringify emits as null. Dropping
   -- those keeps gop_sum finite; the attempt is simply not evidence about that
   -- sound.
   where s.phone is not null
     and s.gop is not null
     and s.verdict is not null
   group by s.phone
  on conflict (user_id, phone) do update
    set attempts       = ps.attempts + excluded.attempts,
        hits           = ps.hits + excluded.hits,
        nears          = ps.nears + excluded.nears,
        misses         = ps.misses + excluded.misses,
        gop_sum        = ps.gop_sum + excluded.gop_sum,
        gop_sq_sum     = ps.gop_sq_sum + excluded.gop_sq_sum,
        last_scored_at = greatest(ps.last_scored_at, excluded.last_scored_at);

  return new;
end;
$$;

create trigger card_reviews_apply_phones
  after insert on public.card_reviews
  for each row execute function public.apply_phone_scores();

-- ---------------------------------------------------------------------------
-- The card list's lifetime ratio stays a translation ratio.
--
-- card_progress sums card_state across directions, so without this a
-- pronunciation session would inflate "times seen" on every card it touched
-- and the deck list would report 40/40 on a card whose meaning you cannot
-- recall. Saying a word and knowing what it means are different claims;
-- pronunciation reports itself through phone_state and card_reviews.score.
--
-- Column list is unchanged, so cards_with_progress and study_deck keep working
-- untouched.
-- ---------------------------------------------------------------------------
create or replace view public.card_progress
  with (security_invoker = true)
as
  select card_id,
         sum(reps)::integer        as times_seen,
         sum(times_known)::integer as times_known,
         max(last_reviewed_at)     as last_seen_at
    from public.card_state
   where user_id = (select auth.uid())
     and prompt_side in ('english', 'spanish')
   group by card_id;
