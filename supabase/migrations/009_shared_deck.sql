-- ---------------------------------------------------------------------------
-- One shared deck, per-person progress.
--
-- The deck is the thing two people are learning together, so public.cards
-- stops being private: any signed-in user reads, adds, edits and deletes any
-- card. Cards are now the shared artefact and `user_id` becomes `created_by`,
-- authorship only.
--
-- What stays per-user is *progress*. "What should I be shown next" is a fact
-- about a person, not about the deck, so every review, every scheduling row
-- and therefore every deck stays private:
--
--   * card_reviews  — already per-user, still readable only by its author.
--   * card_state    — gains user_id in its primary key. Two people reviewing
--                     the same card in the same direction are two rows.
--   * the counters  — times_seen / times_known / last_seen_at leave
--                     public.cards entirely. Rolled up per user in card_state
--                     and read through the card_progress view; on a shared row
--                     they would have been the two of us added together, which
--                     is nobody's progress.
--
-- The deck builder itself is replaced in 010: it has to filter card_state to
-- the caller, which RLS used to do for it by accident.
-- ---------------------------------------------------------------------------

-- --- cards.user_id -> cards.created_by -------------------------------------
alter table public.cards rename column user_id to created_by;
alter table public.cards alter column created_by drop not null;

-- Was `on delete cascade`: fine when a card was private, wrong once it is
-- shared. Deleting an account must not take the deck's cards with it, so
-- authorship goes null and the card stays.
alter table public.cards drop constraint cards_user_id_fkey;
alter table public.cards
  add constraint cards_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete set null;

alter index cards_user_id_idx rename to cards_created_by_idx;

comment on column public.cards.created_by is
  'Who added the card. Authorship only — every signed-in user can edit and delete any card.';

-- --- one card per English prompt, deck-wide --------------------------------
-- Both of us could independently have made a card for "the house"; the shared
-- deck can only hold one. Keep the oldest, repoint the loser's review history
-- at it and drop the rest. card_state is rebuilt from that log further down,
-- so no progress is lost — only the losing row's `spanish`/`notes` wording.
update public.card_reviews r
   set card_id = keep.id
  from public.cards loser
  join (
    select distinct on (english) english, id
      from public.cards
     order by english, created_at, id
  ) keep on keep.english = loser.english and keep.id <> loser.id
 where r.card_id = loser.id;

delete from public.cards loser
 using (
   select distinct on (english) english, id
     from public.cards
    order by english, created_at, id
 ) keep
 where keep.english = loser.english and keep.id <> loser.id;

alter table public.cards drop constraint cards_user_id_english_key;
create unique index cards_english_key on public.cards (english);

-- --- the counters move off the shared row ----------------------------------
alter table public.cards
  drop column times_seen,
  drop column times_known,
  drop column last_seen_at;

-- --- card_state is keyed per user now --------------------------------------
-- `reps` is already this user's times-seen for the direction; times_known is
-- the matching hit count, so the card list can show a personal ratio. Note it
-- is still not what schedules the card — `streak` is.
alter table public.card_state
  add column times_known integer not null default 0;

alter table public.card_state drop constraint card_state_pkey;
alter table public.card_state add primary key (user_id, card_id, prompt_side);

-- --- rebuild the scheduling state from the log -----------------------------
-- card_reviews is the source of truth (it is append-only for exactly this
-- reason), so a full rebuild is lossless and simpler than backfilling the new
-- column and patching up the merged cards by hand.
delete from public.card_state;

insert into public.card_state
  (card_id, user_id, prompt_side, reps, streak, lapses, times_known, last_reviewed_at)
with ordered as (
  select r.user_id, r.card_id, r.prompt_side, r.knew, r.reviewed_at,
         lag(r.knew) over w as prev_knew,
         -- Wrong answers up to and including this review.
         count(*) filter (where not r.knew) over w as wrongs_to_here
    from public.card_reviews r
  window w as (partition by r.user_id, r.card_id, r.prompt_side order by r.reviewed_at)
),
totals as (
  select user_id, card_id, prompt_side, max(wrongs_to_here) as wrongs
    from ordered
   group by user_id, card_id, prompt_side
)
select o.card_id, o.user_id, o.prompt_side,
       count(*) as reps,
       -- Every review since the last wrong one: those are the rows whose
       -- running wrong-count has already reached the group's total. With no
       -- wrong answers at all that is the whole history, which is right.
       count(*) filter (where o.knew and o.wrongs_to_here = t.wrongs) as streak,
       count(*) filter (where not o.knew and o.prev_knew) as lapses,
       count(*) filter (where o.knew) as times_known,
       max(o.reviewed_at) as last_reviewed_at
  from ordered o
  join totals t
    on t.user_id = o.user_id and t.card_id = o.card_id and t.prompt_side = o.prompt_side
 group by o.card_id, o.user_id, o.prompt_side, t.wrongs;

-- --- the review trigger no longer touches the shared card ------------------
drop trigger card_reviews_apply on public.card_reviews;
drop function public.apply_review_to_card();

create function public.apply_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_knew boolean := new.knew;
begin
  insert into public.card_state as st
    (card_id, user_id, prompt_side, reps, streak, lapses, times_known, last_reviewed_at)
  values
    (new.card_id, new.user_id, new.prompt_side, 1,
     case when v_knew then 1 else 0 end, 0,
     case when v_knew then 1 else 0 end, new.reviewed_at)
  on conflict (user_id, card_id, prompt_side) do update
    set reps        = st.reps + 1,
        streak      = case when v_knew then st.streak + 1 else 0 end,
        -- A wrong answer only counts as a lapse if the card had been going
        -- right; failing it twice running is one lapse, not two.
        lapses      = st.lapses + case when not v_knew and st.streak > 0 then 1 else 0 end,
        times_known = st.times_known + case when v_knew then 1 else 0 end,
        last_reviewed_at = new.reviewed_at;

  return new;
end;
$$;

create trigger card_reviews_apply
  after insert on public.card_reviews
  for each row execute function public.apply_review();

-- --- RLS: shared deck, private progress ------------------------------------
drop policy owner_select on public.cards;
drop policy owner_insert on public.cards;
drop policy owner_update on public.cards;
drop policy owner_delete on public.cards;

create policy shared_select on public.cards
  for select to authenticated using (true);

-- created_by is authorship, so a card can only be added in your own name.
create policy shared_insert on public.cards
  for insert to authenticated with check (created_by = (select auth.uid()));

-- A shared deck is shared work: either of us can fix a typo in, or bin, any
-- card regardless of who typed it in.
create policy shared_update on public.cards
  for update to authenticated using (true) with check (true);
create policy shared_delete on public.cards
  for delete to authenticated using (true);

-- The insert policy used to also require the card to be owned by the caller,
-- which stopped a review of someone else's card from bumping that card's
-- counters through the security-definer trigger. Both halves of that are gone:
-- every card is now reviewable by both of us, and the trigger only writes the
-- caller's own card_state row. The foreign key still requires a real card.
drop policy owner_insert on public.card_reviews;
create policy owner_insert on public.card_reviews
  for insert to authenticated with check (user_id = (select auth.uid()));

-- --- what the app reads ----------------------------------------------------
-- The caller's own progress on a card, both directions summed. security_invoker
-- so card_state's RLS still applies; the explicit auth.uid() filter is what
-- makes the numbers per-user whether or not RLS is doing its job.
create view public.card_progress
  with (security_invoker = true)
as
  select card_id,
         sum(reps)::integer        as times_seen,
         sum(times_known)::integer as times_known,
         max(last_reviewed_at)     as last_seen_at
    from public.card_state
   where user_id = (select auth.uid())
   group by card_id;

-- The card list: the shared deck, with my progress against it. Replaces the
-- counter columns that used to be read straight off public.cards.
create view public.cards_with_progress
  with (security_invoker = true)
as
  select c.id,
         c.english,
         c.spanish,
         c.notes,
         c.created_by,
         c.created_at,
         c.updated_at,
         coalesce(p.times_seen, 0)  as times_seen,
         coalesce(p.times_known, 0) as times_known,
         p.last_seen_at
    from public.cards c
    left join public.card_progress p on p.card_id = c.id;

grant select on public.card_progress to authenticated;
grant select on public.cards_with_progress to authenticated;
