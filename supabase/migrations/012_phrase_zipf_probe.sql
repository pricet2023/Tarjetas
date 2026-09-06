-- ---------------------------------------------------------------------------
-- Make phrase_zipf an index probe.
--
-- The 005 version left-joined public.word_frequency and let the planner pick
-- the strategy. For a two-token phrase over a 30,000-row table it picks a hash
-- join, building the hash from a sequential scan — per call. That cost ~2ms a
-- card, which was invisible on a deck of a dozen hand-made cards and is 14
-- seconds once 011 seeds three and a half thousand: study_deck evaluates the
-- utility term for every (card, direction) row before it can sample.
--
-- A correlated subquery on the primary key is an index lookup instead, and the
-- same 3,479 cards now score in 52ms rather than 6,919ms. The value is
-- unchanged for every card in the deck — still the minimum over the tokens,
-- still ZIPF_FLOOR for tokens below the generation cutoff. Only the plan is
-- different.
-- ---------------------------------------------------------------------------

create or replace function public.phrase_zipf(phrase text)
returns real
language sql
stable
parallel safe
as $$
  select coalesce(min(coalesce(
           (select wf.zipf from public.word_frequency wf where wf.word = token),
           3.0
         )), 3.0)
    from regexp_split_to_table(
           -- Fold to lowercase and turn anything that isn't a Spanish letter
           -- into a separator, so "¿Cómo estás?" tokenises cleanly.
           regexp_replace(lower(phrase), '[^a-záéíóúüñ]+', ' ', 'g'),
           '\s+'
         ) as token
   where length(token) > 0;
$$;
